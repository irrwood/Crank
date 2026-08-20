const { readFile, writeFile, rename } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const path = require("node:path");
const { collectFiles } = require("./project-scanner.cjs");
const { resolveXcodePaths } = require("./xcode-paths.cjs");

const execFileAsync = promisify(execFile);
const supportedProperties = {
  element: ["width", "height", "backgroundColor", "radius"],
  text: ["fontSize", "fontWeight", "text"],
  svg: ["width", "height"],
  image: ["width", "height"]
};

const swiftFontSizes = {
  largeTitle: 34, title: 28, title2: 22, title3: 20, headline: 17,
  subheadline: 15, body: 17, callout: 16, footnote: 13, caption: 12, caption2: 11
};
const swiftFontWeights = { regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 };
const swiftTokenColors = {
  flowPaper: "rgb(245, 247, 252)", flowSand: "rgb(87, 107, 143)", flowInk: "rgb(23, 33, 48)",
  flowAccent: "rgb(8, 112, 219)", flowAccentSoft: "rgb(171, 204, 245)", flowNight: "rgb(245, 247, 252)",
  flowNightSoft: "rgb(230, 237, 247)", flowMint: "rgb(31, 168, 107)", flowMuted: "rgb(107, 125, 148)",
  flowPanel: "rgb(255, 255, 255)", flowBorder: "rgb(194, 209, 230)", flowOrange: "rgb(230, 120, 26)",
  white: "rgb(255, 255, 255)", black: "rgb(0, 0, 0)", red: "rgb(255, 59, 48)", clear: null,
  primary: "rgb(28, 28, 31)", secondary: "rgb(110, 110, 117)", systemBackground: "rgb(255, 255, 255)",
  secondarySystemBackground: "rgb(242, 242, 247)", separator: "rgb(201, 201, 207)", accentColor: "rgb(0, 122, 255)"
};

function flattenEditableDom(tree) {
  const result = [];
  const visit = (node) => {
    const common = {
      id: node.id,
      selector: node.selector ?? null,
      // Where this node was written, when the project was served through a
      // build UI Sync controls. Recorded at push time so a pull can edit that
      // exact line instead of hunting for a CSS rule and giving up when the
      // match is not unique. It is stripped before the job reaches Figma —
      // nothing about someone's file layout needs to travel.
      source: node.source ?? null,
      kind: node.kind,
      width: node.width,
      height: node.height,
      backgroundColor: null,
      radius: null,
      fontSize: null,
      fontWeight: null,
      text: null
    };
    if (node.kind === "element") {
      common.backgroundColor = /rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(node.style.backgroundColor)
        ? null
        : node.style.backgroundColor;
      common.radius = node.style.borderRadius;
    } else if (node.kind === "text") {
      common.fontSize = node.style.fontSize;
      const weight = node.style.fontWeight;
      common.fontWeight = weight >= 800 ? 800 : weight >= 700 ? 700 : weight >= 600 ? 600 : weight >= 500 ? 500 : 400;
      common.text = node.text;
    }
    result.push(common);
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
  return result;
}

function normalizedValue(value) {
  if (typeof value === "number") return Math.round(value * 100) / 100;
  return value;
}

function sameValue(left, right) {
  return normalizedValue(left) === normalizedValue(right);
}

function buildPullPreview(baselines, codeScreens, figmaScreens) {
  const changes = [];
  const conflicts = [];
  const unsupported = [];
  for (const [screenId, codeNodes] of Object.entries(codeScreens)) {
    const baseNodes = new Map((baselines[screenId] ?? []).map((node) => [node.id, node]));
    const figmaNodes = new Map((figmaScreens[screenId] ?? []).map((node) => [node.id, node]));
    for (const codeNode of codeNodes) {
      const base = baseNodes.get(codeNode.id);
      const figma = figmaNodes.get(codeNode.id);
      if (!base || !figma) continue;
      for (const property of supportedProperties[codeNode.kind] ?? []) {
        const baseValue = base[property];
        const codeValue = codeNode[property];
        const figmaValue = figma[property];
        const codeChanged = !sameValue(codeValue, baseValue);
        const figmaChanged = !sameValue(figmaValue, baseValue);
        if (!figmaChanged) continue;
        const entry = {
          id: `${screenId}:${codeNode.id}:${property}`,
          screenId,
          domId: codeNode.id,
          selector: codeNode.selector,
          kind: codeNode.kind,
          property,
          base: baseValue,
          code: codeValue,
          figma: figmaValue,
          sourceText: codeNode.text,
          sourceToken: codeNode.sourceToken ?? null
        };
        if (codeChanged && !sameValue(codeValue, figmaValue)) conflicts.push(entry);
        else if (!codeChanged) changes.push(entry);
      }
    }
  }
  return { changes, conflicts, unsupported };
}

function buildSwiftCodeScreens(baselines, screens) {
  const result = {};
  const sizeFor = (node) => node.fontSize ?? swiftFontSizes[node.fontStyle] ?? (["button", "field"].includes(node.type) ? 15 : 17);
  const weightFor = (node) => swiftFontWeights[node.fontWeight]
    ?? (node.type === "button" || node.fontStyle === "headline" ? 600 : 400);
  for (const screen of screens) {
    const semanticNodes = new Map();
    const visit = (node) => {
      if (node?.syncId) semanticNodes.set(node.syncId, node);
      for (const child of node?.children ?? []) visit(child);
    };
    visit(screen.uiTree);
    result[screen.id] = (baselines[screen.id] ?? []).map((baseline) => {
      if (!baseline.id.startsWith("swift/")) return baseline;
      if (baseline.id.endsWith("/title")) {
        const semantic = semanticNodes.get(baseline.id.slice(0, -6));
        return semantic ? { ...baseline, text: semantic.title ?? baseline.text, fontSize: 34, fontWeight: 700 } : baseline;
      }
      if (baseline.id.endsWith("/text")) {
        const semantic = semanticNodes.get(baseline.id.slice(0, -5));
        return semantic ? {
          ...baseline,
          text: semantic.text ?? baseline.text,
          fontSize: sizeFor(semantic),
          fontWeight: weightFor(semantic)
        } : baseline;
      }
      const semantic = semanticNodes.get(baseline.id);
      if (!semantic) return baseline;
      return {
        ...baseline,
        width: semantic.width ?? baseline.width,
        height: semantic.height ?? baseline.height,
        radius: semantic.cornerRadius ?? baseline.radius,
        backgroundColor: semantic.backgroundColorToken
          ? swiftTokenColors[semantic.backgroundColorToken] ?? baseline.backgroundColor
          : baseline.backgroundColor,
        sourceToken: semantic.backgroundColorToken ?? null
      };
    });
  }
  return result;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function cssDeclarationFor(change) {
  if (change.property === "width" || change.property === "height") return [change.property, `${change.figma}px`];
  if (change.property === "backgroundColor") return ["background-color", change.figma];
  if (change.property === "radius") return ["border-radius", `${change.figma}px`];
  if (change.property === "fontSize") return ["font-size", `${change.figma}px`];
  if (change.property === "fontWeight") return ["font-weight", String(change.figma)];
  return null;
}

function patchCssRule(source, selector, property, value) {
  const selectorPattern = escapeRegExp(selector);
  const rule = new RegExp(`(^|\\n)([ \\t]*${selectorPattern}[ \\t]*\\{)([\\s\\S]*?)(\\n?[ \\t]*\\})`, "m");
  const match = rule.exec(source);
  if (!match) return null;
  const body = match[3];
  const declaration = new RegExp(`(^|\\n)([ \\t]*)${escapeRegExp(property)}[ \\t]*:[^;]+;?`, "m");
  const indentation = /\n([ \t]+)[\w-]+\s*:/m.exec(body)?.[1] ?? "  ";
  const nextBody = declaration.test(body)
    ? body.replace(declaration, `$1$2${property}: ${value};`)
    : `${body.replace(/\s*$/, "")}\n${indentation}${property}: ${value};\n`;
  return `${source.slice(0, match.index)}${match[1]}${match[2]}${nextBody}${match[4]}${source.slice(match.index + match[0].length)}`;
}

function tailwindUtilityFor(change) {
  if (change.property === "width") return `w-[${change.figma}px]`;
  if (change.property === "height") return `h-[${change.figma}px]`;
  if (change.property === "radius") return `rounded-[${change.figma}px]`;
  if (change.property === "fontSize") return `text-[${change.figma}px]`;
  if (change.property === "fontWeight") return `font-[${change.figma}]`;
  if (change.property === "backgroundColor" && typeof change.figma === "string") {
    return `bg-[${change.figma.replace(/\s+/g, "")}]`;
  }
  return null;
}

function isUtilityForProperty(token, property) {
  if (property === "width") return /^w-(?!min-|max-).+/.test(token);
  if (property === "height") return /^h-(?!min-|max-).+/.test(token);
  if (property === "radius") return /^rounded(?:-.+)?$/.test(token);
  if (property === "fontSize") return /^text-(?:xs|sm|base|lg|xl|[2-9]xl|\[.+\])$/.test(token);
  if (property === "fontWeight") return /^font-(?:thin|extralight|light|normal|medium|semibold|bold|extrabold|black|\[.+\])$/.test(token);
  if (property === "backgroundColor") return /^bg-(?!clip-|gradient-|none$).+/.test(token);
  return false;
}

function patchTailwindClassName(source, selector, change) {
  if (!selector?.startsWith(".")) return null;
  const identity = selector.slice(1);
  const utility = tailwindUtilityFor(change);
  if (!identity || !utility) return null;
  const className = /className\s*=\s*(["'])([^"']*)\1/g;
  const candidates = [];
  for (const match of source.matchAll(className)) {
    const tokens = match[2].split(/\s+/).filter(Boolean);
    if (tokens.includes(identity)) candidates.push({ match, tokens });
  }
  if (candidates.length !== 1) return null;
  const [{ match, tokens }] = candidates;
  let replaced = false;
  const nextTokens = tokens.map((token) => {
    if (!replaced && isUtilityForProperty(token, change.property)) {
      replaced = true;
      return utility;
    }
    return token;
  });
  if (!replaced) nextTokens.push(utility);
  const start = match.index + match[0].indexOf(match[2]);
  return `${source.slice(0, start)}${nextTokens.join(" ")}${source.slice(start + match[2].length)}`;
}

function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(needle, index)) >= 0) {
    count += 1;
    index += needle.length;
  }
  return count;
}

async function createPatchPlan(root, changes) {
  const sourceFiles = await collectFiles(root, (target) => /\.(?:css|jsx|tsx)$/.test(target), 2400);
  const contents = new Map();
  for (const file of sourceFiles) contents.set(file, await readFile(file, "utf8"));
  const mutations = [];
  const rejected = [];

  for (const change of changes) {
    if (change.property === "text") {
      const matches = [...contents.entries()].filter(([file, source]) => /\.(?:jsx|tsx)$/.test(file) && countOccurrences(source, String(change.code)) > 0);
      const total = matches.reduce((sum, [, source]) => sum + countOccurrences(source, String(change.code)), 0);
      if (total !== 1) {
        rejected.push({ ...change, reason: "Text is not uniquely identifiable in source" });
        continue;
      }
      const [file, source] = matches[0];
      const next = source.replace(String(change.code), String(change.figma));
      contents.set(file, next);
      mutations.push({ changeId: change.id, file, property: "text" });
      continue;
    }

    const declaration = cssDeclarationFor(change);
    if (!declaration || !change.selector || !change.selector.startsWith(".")) {
      rejected.push({ ...change, reason: "No deterministic source selector" });
      continue;
    }
    let patched = false;
    for (const [file, source] of contents) {
      if (!file.endsWith(".css")) continue;
      const next = patchCssRule(source, change.selector, declaration[0], declaration[1]);
      if (!next) continue;
      contents.set(file, next);
      mutations.push({ changeId: change.id, file, property: declaration[0] });
      patched = true;
      break;
    }
    if (!patched) {
      const candidates = [];
      for (const [file, source] of contents) {
        if (!/\.(?:jsx|tsx)$/.test(file)) continue;
        const next = patchTailwindClassName(source, change.selector, change);
        if (next && next !== source) candidates.push({ file, next });
      }
      if (candidates.length === 1) {
        const [{ file, next }] = candidates;
        contents.set(file, next);
        mutations.push({ changeId: change.id, file, property: `tailwind:${change.property}` });
        patched = true;
      }
    }
    if (!patched) rejected.push({ ...change, reason: `No unique CSS rule or static Tailwind className matched ${change.selector}` });
  }

  const changedFiles = [...contents.entries()]
    .filter(([file, source]) => source !== undefined)
    .map(([file, next]) => ({ file, next }));
  return { mutations, rejected, changedFiles };
}

function swiftSourceTarget(root, selector) {
  if (!selector) return null;
  const separator = selector.lastIndexOf("#");
  const relativeFile = separator >= 0 ? selector.slice(0, separator) : selector;
  const target = path.resolve(root, relativeFile);
  return target.startsWith(`${path.resolve(root)}${path.sep}`) && target.endsWith(".swift") ? target : null;
}

function swiftEscaped(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function replaceUnique(source, expression, replacement) {
  const matches = [...source.matchAll(new RegExp(expression.source, expression.flags.includes("g") ? expression.flags : `${expression.flags}g`))];
  if (matches.length !== 1) return null;
  return source.replace(expression, replacement);
}

function swiftColorExpression(css) {
  const match = String(css || "").match(/^rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)$/);
  if (!match) return null;
  const channel = (value) => (Number(value) / 255).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  const opacity = match[4] === undefined ? "" : `, opacity: ${Number(match[4])}`;
  return `Color(red: ${channel(match[1])}, green: ${channel(match[2])}, blue: ${channel(match[3])}${opacity})`;
}

async function createSwiftPatchPlan(root, changes) {
  const contents = new Map();
  const mutations = [];
  const rejected = [];
  for (const change of changes) {
    const file = swiftSourceTarget(root, change.selector);
    if (!file) {
      rejected.push({ ...change, reason: "No exact Swift source identity was stored for this layer" });
      continue;
    }
    let source;
    try {
      source = contents.has(file) ? contents.get(file) : await readFile(file, "utf8");
    } catch {
      rejected.push({ ...change, reason: `Swift source file is unavailable: ${path.relative(root, file)}` });
      continue;
    }
    let next = null;
    if (change.property === "text") {
      const before = `"${swiftEscaped(change.code)}"`;
      const after = `"${swiftEscaped(change.figma)}"`;
      if (countOccurrences(source, before) === 1) next = source.replace(before, after);
    } else if (["fontSize", "fontWeight"].includes(change.property) && change.sourceText) {
      const anchor = `"${swiftEscaped(change.sourceText)}"`;
      const anchorIndex = source.indexOf(anchor);
      if (anchorIndex >= 0 && source.indexOf(anchor, anchorIndex + anchor.length) < 0) {
        const end = Math.min(source.length, anchorIndex + 900);
        const segment = source.slice(anchorIndex, end);
        if (change.property === "fontSize") {
          const replaced = replaceUnique(segment, /(\.font\s*\(\s*\.system\s*\([^)]*?\bsize\s*:\s*)\d+(?:\.\d+)?/, `$1${change.figma}`);
          if (replaced) next = `${source.slice(0, anchorIndex)}${replaced}${source.slice(end)}`;
        } else {
          const weightName = Number(change.figma) >= 900 ? "black" : Number(change.figma) >= 800 ? "heavy" : Number(change.figma) >= 700 ? "bold" : Number(change.figma) >= 600 ? "semibold" : Number(change.figma) >= 500 ? "medium" : "regular";
          const replaced = replaceUnique(segment, /(\.font\s*\(\s*\.system\s*\([^)]*?\bweight\s*:\s*)\.(?:regular|medium|semibold|bold|heavy|black)/, `$1.${weightName}`);
          if (replaced) next = `${source.slice(0, anchorIndex)}${replaced}${source.slice(end)}`;
        }
      }
    } else if (["width", "height"].includes(change.property)) {
      next = replaceUnique(source, new RegExp(`(\\b${change.property}\\s*:\\s*)${escapeRegExp(String(change.code))}(?![\\d.])`), `$1${change.figma}`);
    } else if (change.property === "radius") {
      const old = escapeRegExp(String(change.code));
      next = replaceUnique(source, new RegExp(`((?:cornerRadius\\s*:\\s*|\\.cornerRadius\\s*\\(\\s*))${old}(?![\\d.])`), `$1${change.figma}`);
    } else if (change.property === "backgroundColor" && change.sourceToken) {
      const color = swiftColorExpression(change.figma);
      if (color) {
        const token = escapeRegExp(change.sourceToken);
        next = replaceUnique(source, new RegExp(`(?:Color\\s*)?\\.\\s*${token}\\b`), color);
      }
    }
    if (!next || next === source) {
      rejected.push({ ...change, reason: `SwiftUI ${change.property} is dynamic or not uniquely identifiable in ${path.relative(root, file)}` });
      continue;
    }
    contents.set(file, next);
    mutations.push({ changeId: change.id, file, property: `swiftui:${change.property}` });
  }
  return {
    mutations,
    rejected,
    changedFiles: [...contents.entries()].map(([file, next]) => ({ file, next }))
  };
}

async function runProjectValidation(root) {
  const manifestPath = path.join(root, "package.json");
  const manifest = await readFile(manifestPath, "utf8").then(JSON.parse).catch(() => null);
  if (!manifest) {
    const packageManifest = path.join(root, "Package.swift");
    const hasSwiftPackage = await readFile(packageManifest, "utf8").then(() => true).catch(() => false);
    if (hasSwiftPackage) {
      await execFileAsync("swift", ["build"], { cwd: root, timeout: 12 * 60 * 1000, maxBuffer: 12 * 1024 * 1024 });
      return ["swift build"];
    }
    const projectFiles = await collectFiles(root, (target) => target.endsWith(".xcodeproj/project.pbxproj"), 20);
    if (projectFiles.length === 0) throw new Error("No Xcode project or Swift package was found for validation");
    const project = path.dirname(projectFiles[0]);
    const xcode = await resolveXcodePaths();
    const xcodeEnvironment = xcode ? { ...process.env, DEVELOPER_DIR: xcode.developerDirectory } : { ...process.env };
    const listing = await execFileAsync("xcodebuild", ["-project", project, "-list", "-json"], {
      cwd: root, env: xcodeEnvironment, timeout: 2 * 60 * 1000, maxBuffer: 4 * 1024 * 1024
    });
    const schemes = JSON.parse(listing.stdout).project?.schemes ?? [];
    if (schemes.length === 0) throw new Error("The Xcode project has no shared build scheme");
    await execFileAsync("xcodebuild", ["-project", project, "-scheme", schemes[0], "-configuration", "Debug", "CODE_SIGNING_ALLOWED=NO", "build"], {
      cwd: root, env: xcodeEnvironment, timeout: 15 * 60 * 1000, maxBuffer: 16 * 1024 * 1024
    });
    return [`xcodebuild ${schemes[0]}`];
  }
  const scripts = ["typecheck", "test", "build"].filter((name) => manifest.scripts?.[name]);
  for (const script of scripts) {
    const usesPnpm = await readFile(path.join(root, "pnpm-lock.yaml"), "utf8").then(() => true).catch(() => false);
    const command = usesPnpm ? "corepack" : "npm";
    const args = usesPnpm ? ["pnpm", script] : ["run", script];
    await execFileAsync(command, args, { cwd: root, timeout: 8 * 60 * 1000, maxBuffer: 8 * 1024 * 1024 });
  }
  return scripts;
}

async function applyPatchPlan(root, plan) {
  const originals = new Map();
  const targets = [...new Set(plan.mutations.map((mutation) => mutation.file))];
  for (const file of targets) originals.set(file, await readFile(file, "utf8"));
  try {
    for (const file of targets) {
      const next = plan.changedFiles.find((entry) => entry.file === file)?.next;
      if (next === undefined) continue;
      const temporary = `${file}.ui-sync-tmp`;
      await writeFile(temporary, next, "utf8");
      await rename(temporary, file);
    }
    const validation = await runProjectValidation(root);
    return { changedFiles: targets.map((file) => path.relative(root, file)), validation };
  } catch (error) {
    for (const [file, source] of originals) await writeFile(file, source, "utf8");
    throw error;
  }
}

module.exports = {
  applyPatchPlan,
  buildPullPreview,
  buildSwiftCodeScreens,
  createPatchPlan,
  createSwiftPatchPlan,
  flattenEditableDom,
  patchCssRule,
  patchTailwindClassName
};
