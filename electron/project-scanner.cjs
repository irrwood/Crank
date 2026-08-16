const { access, readFile, readdir } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { scanWithSwiftSyntax } = require("./swift-syntax-backend.cjs");
const { buildSwiftUiIr } = require("./swiftui-ir.cjs");

const ignoredDirectories = new Set([
  ".build",
  ".git",
  ".swiftpm",
  "Build",
  "DerivedData",
  "Pods",
  "Carthage",
  "dist",
  "node_modules",
  "output",
  "test-fixtures",
  "vendor"
]);

const swiftUiPatterns = [
  ["navigation", "NavigationStack", "Navigation"],
  ["tabs", "TabView", "Tab navigation"],
  ["list", "List", "List"],
  ["form", "Form", "Form"],
  ["scroll", "ScrollView", "Scrollable content"],
  ["grid", "LazyVGrid", "Grid"],
  ["grid", "LazyHGrid", "Grid"],
  ["modal", ".sheet(", "Sheet"],
  ["modal", ".fullScreenCover(", "Full-screen modal"]
];

async function collectFiles(root, predicate, maximumFiles = 1600) {
  const results = [];
  const queue = [root];

  while (queue.length > 0 && results.length < maximumFiles) {
    const directory = queue.shift();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name) && !entry.name.endsWith(".xcassets")) {
          queue.push(target);
        }
      } else if (entry.isFile() && predicate(target)) {
        results.push(target);
        if (results.length >= maximumFiles) break;
      }
    }
  }
  return results;
}

function javascriptManifestInfo(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
    ...(manifest.peerDependencies ?? {})
  };
  const scripts = Object.values(manifest.scripts ?? {}).filter((value) => typeof value === "string");
  const has = (name) => Boolean(dependencies[name]);
  const electronMarkers = ["electron", "electron-vite", "@electron/remote", "@electron-forge/cli"];
  const uiMarkers = [
    "react", "preact", "vue", "svelte", "@angular/core", "solid-js", "lit",
    "@builder.io/qwik", "next", "@remix-run/react", "gatsby", "astro"
  ];
  const hasElectron = electronMarkers.some(has)
    || scripts.some((script) => /(?:^|\s)(?:electron|electron-vite|electron-forge)(?:\s|$)/.test(script));
  const hasSupportedUiRuntime = uiMarkers.some(has);
  const hasRunnableScript = Object.keys(manifest.scripts ?? {}).some((name) =>
    /^(?:dev|start|serve|preview|electron|app)(?::|$)/.test(name)
  );
  if (!hasElectron && !(hasSupportedUiRuntime && hasRunnableScript)) return null;
  return { dependencies, hasElectron, hasSupportedUiRuntime };
}

async function pathIsFile(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function findRendererEntry(root) {
  const candidates = [
    ".vite/renderer/main_window/index.html",
    ".webpack/renderer/main_window/index.html",
    "out/renderer/index.html",
    "out/renderer/main_window/index.html",
    "dist/renderer/index.html",
    "dist/client/index.html",
    "dist/index.html",
    "build/index.html",
    "app/index.html",
    "renderer/index.html",
    "index.html",
    "public/index.html",
    "src/index.html"
  ];
  for (const relativePath of candidates) {
    if (await pathIsFile(path.join(root, relativePath))) return relativePath;
  }
  return null;
}

async function discoverJavascriptProjectRoots(root, maximumProjects = 24) {
  const safeRoot = path.resolve(root);
  const results = [];
  const queue = [{ directory: safeRoot, depth: 0 }];
  let visitedDirectories = 0;

  while (queue.length > 0 && results.length < maximumProjects && visitedDirectories < 2400) {
    const { directory, depth } = queue.shift();
    visitedDirectories += 1;
    const manifest = await readJson(path.join(directory, "package.json"));
    if (javascriptManifestInfo(manifest)) results.push(directory);
    if (depth >= 7) continue;

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectories.has(entry.name) || entry.name.endsWith(".xcassets")) continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }

  return [...new Set(results)].sort((left, right) => {
    if (left === safeRoot) return -1;
    if (right === safeRoot) return 1;
    const leftDepth = path.relative(safeRoot, left).split(path.sep).length;
    const rightDepth = path.relative(safeRoot, right).split(path.sep).length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
}

async function discoverSwiftUiProjectRoots(root, maximumProjects = 24) {
  const safeRoot = path.resolve(root);
  const results = [];
  const queue = [{ directory: safeRoot, depth: 0 }];
  let visitedDirectories = 0;

  while (queue.length > 0 && results.length < maximumProjects && visitedDirectories < 2400) {
    const { directory, depth } = queue.shift();
    visitedDirectories += 1;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    const hasXcodeProject = entries.some((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"));
    const hasSwiftPackage = entries.some((entry) => entry.isFile() && entry.name === "Package.swift");
    const hasSwiftSource = entries.some((entry) => entry.isFile() && entry.name.endsWith(".swift"));
    if (hasXcodeProject || (hasSwiftPackage && hasSwiftSource)) results.push(directory);
    if (depth >= 7) continue;
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || ignoredDirectories.has(entry.name) || entry.name.endsWith(".xcassets") || entry.name.endsWith(".xcodeproj")) continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }

  return [...new Set(results)].sort((left, right) => {
    if (left === safeRoot) return -1;
    if (right === safeRoot) return 1;
    const leftDepth = path.relative(safeRoot, left).split(path.sep).length;
    const rightDepth = path.relative(safeRoot, right).split(path.sep).length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
}

function omitWorkspaceContainers(projects) {
  return projects.filter((project) => {
    if ((project.screens?.length ?? 0) > 0) return true;
    const root = path.resolve(project.root);
    const hasRunnableChild = projects.some((candidate) => {
      if (candidate === project || (candidate.screens?.length ?? 0) === 0) return false;
      return path.resolve(candidate.root).startsWith(`${root}${path.sep}`);
    });
    return !hasRunnableChild;
  });
}

function uniqueMatches(source, expression) {
  return [...new Set([...source.matchAll(expression)].map((match) => match[1]).filter(Boolean))];
}

function classifyView(name, source) {
  const patterns = [];
  const patternIds = [];
  for (const [id, needle, label] of swiftUiPatterns) {
    if (!source.includes(needle)) continue;
    if (!patternIds.includes(id)) patternIds.push(id);
    if (!patterns.includes(label)) patterns.push(label);
  }

  const sfSymbols = uniqueMatches(
    source,
    /(?:systemName|systemImage)\s*:\s*"([A-Za-z0-9._-]+)"/g
  );
  const semanticColors = uniqueMatches(
    source,
    /Color\(\.(systemBackground|secondarySystemBackground|tertiarySystemBackground|label|secondaryLabel|tertiaryLabel|separator|opaqueSeparator|quaternarySystemFill)\)/g
  );
  const hasCustomFont = /\.custom\s*\(/.test(source);
  const isModal = /(Sheet|Modal|Popover)$/.test(name);
  const looksLikeComponent = /(Row|Card|Button|Cell|Badge|Chip|Header|Footer|Style|Panel|Spinner|Backdrop|Sticker|Modifier|Control|Field|Toolbar|Indicator|Shape)$/.test(name);
  const hasScreenStructure = patternIds.some((id) => ["navigation", "tabs", "list", "form", "scroll", "grid"].includes(id));

  return {
    id: name,
    sourceName: name,
    name: name.replace(/(View|Screen|Page)$/, "") || name,
    sourceType: isModal ? "modal" : looksLikeComponent && !hasScreenStructure ? "component" : "screen",
    patterns,
    sfSymbolCount: sfSymbols.length,
    semanticColorCount: semanticColors.length,
    hasCustomFont,
    uiTree: buildSwiftUiIr(source)
  };
}

function canonicalDesignExpression(kind, expression) {
  const modifierNames = [...String(expression || "").matchAll(/\.\s*([a-z][A-Za-z0-9_]*)\s*(?:\(|\{)/g)]
    .map((match) => match[1]);
  const argumentLabels = [...String(expression || "").matchAll(/\b([a-z][A-Za-z0-9_]*)\s*:/g)]
    .map((match) => match[1]);
  return `${kind}|${modifierNames.join(",")}|${argumentLabels.join(",")}`;
}

function prepareDesignNodes(relativeFile, sourceName, designNodes = []) {
  const occurrences = new Map();
  return designNodes.map((node) => {
    const fingerprint = canonicalDesignExpression(node.kind, node.expression);
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    const identity = createHash("sha256")
      .update(`${relativeFile}#${sourceName}#${fingerprint}#${occurrence}`)
      .digest("hex")
      .slice(0, 16);
    return {
      ...node,
      syncId: `swift/${identity}`,
      sourceRange: {
        line: node.line,
        column: node.column,
        startOffset: node.startOffset,
        endOffset: node.endOffset
      }
    };
  });
}

const irSwiftKinds = {
  navigation: new Set(["NavigationStack", "NavigationView"]),
  vstack: new Set(["VStack", "LazyVStack"]),
  hstack: new Set(["HStack", "LazyHStack"]),
  zstack: new Set(["ZStack"]),
  scroll: new Set(["ScrollView"]),
  list: new Set(["List", "Form"]),
  section: new Set(["Section"]),
  text: new Set(["Text"]),
  label: new Set(["Label"]),
  symbol: new Set(["Image"]),
  button: new Set(["Button"]),
  toggle: new Set(["Toggle"]),
  field: new Set(["TextField", "SecureField"]),
  divider: new Set(["Divider"]),
  spacer: new Set(["Spacer"]),
  group: new Set(["Group", "ForEach"]),
  tabview: new Set(["TabView"]),
  shape: new Set(["Circle", "Rectangle", "RoundedRectangle", "Capsule", "LinearGradient", "RadialGradient"]),
  progress: new Set(["ProgressView"])
};

function designNodeMatches(irNode, designNode) {
  if (irNode.type === "custom") return designNode.kind === irNode.name;
  return irSwiftKinds[irNode.type]?.has(designNode.kind) ?? false;
}

function selectDesignNode(irNode, designNodes, used) {
  const candidates = designNodes.filter((candidate) => !used.has(candidate.syncId) && designNodeMatches(irNode, candidate));
  const effectNames = [
    ...(Number(irNode.shadowRadius) > 0 ? ["shadow"] : []),
    ...(Number(irNode.blurRadius) > 0 ? ["blur"] : [])
  ];
  if (effectNames.length === 0) return candidates[0];
  return candidates
    .filter((candidate) => effectNames.every((name) => new RegExp(`\\.${name}\\s*\\(`).test(candidate.expression)))
    .sort((left, right) => left.expression.length - right.expression.length)[0]
    ?? candidates[0];
}

function attachSwiftIdentity(node, relativeFile, sourceName, identityRoot, designNodes = [], state = { used: new Set() }, pathParts = []) {
  if (!node || typeof node !== "object") return node;
  const designNode = selectDesignNode(node, designNodes, state.used);
  if (designNode) state.used.add(designNode.syncId);
  return {
    ...node,
    syncId: designNode?.syncId ?? `swift/${identityRoot}${pathParts.map((part) => `/${part}`).join("")}`,
    sourceFile: relativeFile,
    sourceName,
    ...(designNode ? {
      sourceExpression: designNode.expression.slice(0, 1000),
      sourceRange: designNode.sourceRange
    } : {}),
    ...(node.children ? {
      children: node.children.map((child, index) => attachSwiftIdentity(child, relativeFile, sourceName, identityRoot, designNodes, state, [...pathParts, index]))
    } : {})
  };
}

function collectSwiftStringDefaults(source, defaults) {
  const expression = /\b(?:@Published\s+|@State\s+)?(?:private\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=\n]+)?=\s*"((?:\\.|[^"\\])*)"/g;
  for (const match of source.matchAll(expression)) {
    if (!defaults.has(match[1])) {
      defaults.set(match[1], match[2].replace(/\\"/g, '"').replace(/\\n/g, "\n"));
    }
  }
}

function applySwiftStringDefaults(node, defaults) {
  if (!node || typeof node !== "object") return node;
  return {
    ...node,
    ...(node.textKey && defaults.has(node.textKey) ? { text: defaults.get(node.textKey) } : {}),
    ...(node.children ? { children: node.children.map((child) => applySwiftStringDefaults(child, defaults)) } : {})
  };
}

function expandComponentTrees(views) {
  const byName = new Map(views.map((view) => [view.sourceName, view]));
  const structuralKeys = new Set(["type", "name", "children"]);

  function expand(node, parentType = null, resolving = new Set(), childIndex = 0) {
    if (!node || typeof node !== "object") return node;
    if (node.type === "custom") {
      const target = byName.get(node.name);
      const shouldExpand = target && (target.sourceType === "component" || (parentType === "tabview" && childIndex === 0));
      if (shouldExpand && !resolving.has(target.sourceName)) {
        const nextResolving = new Set(resolving);
        nextResolving.add(target.sourceName);
        const expanded = expand(structuredClone(target.uiTree), parentType, nextResolving, childIndex);
        const instanceStyle = Object.fromEntries(Object.entries(node).filter(([key]) => !structuralKeys.has(key)));
        return { ...expanded, ...instanceStyle };
      }
    }
    return {
      ...node,
      ...(node.children ? { children: node.children.map((child, index) => expand(child, node.type, resolving, index)) } : {})
    };
  }

  return views.map((view) => ({ ...view, uiTree: expand(structuredClone(view.uiTree), null, new Set([view.sourceName])) }));
}

function extractSwiftUiViews(source) {
  if (!source.includes("import SwiftUI")) return [];
  const matches = [...source.matchAll(/\bstruct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*View\b/g)];
  const views = [];

  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const name = match[1];
    if (!name || name.endsWith("_Previews") || name.includes("Preview")) continue;
    const start = match.index ?? 0;
    const end = matches[index + 1]?.index ?? source.length;
    const viewSource = source.slice(start, end).replace(/#Preview[\s\S]*$/, "");
    views.push(classifyView(name, viewSource));
  }
  return views;
}

async function scanSwiftUiProject(root, options = {}) {
  const nativeFiles = await collectFiles(root, (target) => /\.(?:swift|m|mm)$/i.test(target));
  const swiftFiles = nativeFiles.filter((target) => target.endsWith(".swift"));
  if (nativeFiles.length === 0) return null;

  const sourceByFile = new Map();
  const projectTextDefaults = new Map();
  let importsUIKit = false;
  await Promise.all(swiftFiles.map(async (file) => {
    try {
      const source = await readFile(file, "utf8");
      if (source.length > 1_500_000) return;
      sourceByFile.set(file, source);
      if (/\bimport\s+UIKit\b/.test(source)) importsUIKit = true;
      collectSwiftStringDefaults(source, projectTextDefaults);
    } catch {}
  }));

  const projectFiles = await collectFiles(
    root,
    (target) => target.endsWith("project.pbxproj") && target.includes(".xcodeproj"),
    20
  );
  let importsSwiftUi = false;
  let appName = null;
  const viewsById = new Map();

  const syntaxResults = await scanWithSwiftSyntax(root, swiftFiles, options.cacheDirectory);
  if (syntaxResults) {
    importsSwiftUi = syntaxResults.length > 0;
    for (const result of syntaxResults) {
      if (result.isAppEntry) {
        appName = result.name.replace(/App$/, "") || result.name;
        continue;
      }
      if (!result.name || result.name.endsWith("_Previews") || result.name.includes("Preview")) continue;
      const view = classifyView(result.name, result.source);
      const identity = createHash("sha256").update(`${result.relativeFile}#${result.name}`).digest("hex");
      const designNodes = prepareDesignNodes(result.relativeFile, result.name, result.designNodes);
      view.id = `swiftui-${identity.slice(0, 20)}`;
      view.uiTree = attachSwiftIdentity(applySwiftStringDefaults(view.uiTree, projectTextDefaults), result.relativeFile, result.name, identity.slice(0, 16), designNodes);
      view.designNodes = designNodes;
      viewsById.set(view.id, view);
    }
  }

  for (const file of syntaxResults ? [] : swiftFiles) {
    let source;
    try {
      source = sourceByFile.get(file) ?? await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (source.length > 1_500_000 || !source.includes("import SwiftUI")) continue;
    importsSwiftUi = true;
    const appMatch = source.match(/@main[\s\S]{0,240}?struct\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*App\b/);
    if (appMatch?.[1]) appName = appMatch[1].replace(/App$/, "") || appMatch[1];
    for (const view of extractSwiftUiViews(source)) {
      const identity = createHash("sha256")
        .update(`${path.relative(root, file)}#${view.id}`)
        .digest("hex")
      view.uiTree = attachSwiftIdentity(applySwiftStringDefaults(view.uiTree, projectTextDefaults), path.relative(root, file), view.sourceName, identity.slice(0, 16));
      view.id = `swiftui-${identity.slice(0, 20)}`;
      const previous = viewsById.get(view.id);
      if (!previous || view.patterns.length > previous.patterns.length) viewsById.set(view.id, view);
    }
  }

  if (!importsSwiftUi && !importsUIKit) return null;
  const xcodeProjectName = projectFiles[0]
    ? path.basename(path.dirname(projectFiles[0]), ".xcodeproj")
    : null;
  let screens = expandComponentTrees([...viewsById.values()])
    .sort((left, right) => {
      const order = { screen: 0, modal: 1, component: 2 };
      return order[left.sourceType] - order[right.sourceType] || left.name.localeCompare(right.name);
    })
    .slice(0, 120)
    .map(({ sourceName: _sourceName, designNodes: _designNodes, ...view }) => view);
  if (screens.length === 0 && importsUIKit) {
    screens = [{
      id: "ios-runtime-root",
      name: "Application",
      sourceType: "screen",
      patterns: ["UIKit runtime"],
      sfSymbolCount: 0,
      semanticColorCount: 0,
      hasCustomFont: false,
      uiTree: {
        type: "custom",
        name: "UIKit application",
        syncId: "uikit/root",
        sourceFile: path.relative(root, swiftFiles[0] || nativeFiles[0]),
        sourceName: "Application"
      }
    }];
  }

  return {
    kind: "swiftui",
    framework: importsSwiftUi ? "SwiftUI · iOS" : "UIKit · iOS",
    analysisEngine: importsSwiftUi ? (syntaxResults ? "SwiftSyntax" : "Local syntax scan") : "UIKit runtime capture",
    detectedName: appName ?? xcodeProjectName ?? path.basename(root),
    sourceFileCount: nativeFiles.length,
    screens
  };
}

function humanizeRoute(value) {
  const label = String(value || "")
    .replace(/^[/#?]+/, "")
    .replace(/[?&=/_-]+/g, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase())
    .trim();
  return label || "Home";
}

function extractJavascriptPages(root, sourceByFile, dependencies, rendererEntry) {
  const pages = new Map();
  const add = (name, capturePath, pattern = "Runtime route") => {
    const key = capturePath || "/";
    if (!pages.has(key)) pages.set(key, { name, capturePath, pattern });
  };
  add("Home", "/", "Runtime entry");

  const usesRouter = Boolean(
    dependencies["react-router"] || dependencies["react-router-dom"] || dependencies.next
    || dependencies["@remix-run/react"] || dependencies.vue || dependencies["vue-router"]
  );
  for (const source of sourceByFile.values()) {
    if (usesRouter) {
      for (const match of source.matchAll(/<Route\b[^>]*\bpath\s*=\s*["'{`]([^"'`}]+)["'}`]/g)) {
        if (match[1]?.startsWith("/") && !/[:*]/.test(match[1])) add(humanizeRoute(match[1]), match[1], "Declared route");
      }
      for (const match of source.matchAll(/\bpath\s*:\s*["'`]([^"'`]+)["'`]/g)) {
        if (match[1]?.startsWith("/") && !/[:*]/.test(match[1])) add(humanizeRoute(match[1]), match[1], "Declared route");
      }
    }

    const queryVariables = new Map();
    for (const match of source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+URLSearchParams\([^)]*\)\.get\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
      queryVariables.set(match[1], match[2]);
    }
    for (const [variable, parameter] of queryVariables) {
      const valuePattern = new RegExp(`\\b${variable.replace(/[$]/g, "\\$")}\\s*={2,3}\\s*["'\\x60]([^"'\\x60]+)["'\\x60]`, "g");
      for (const match of source.matchAll(valuePattern)) {
        const value = match[1];
        if (!value || value.length > 80) continue;
        add(humanizeRoute(value), `?${encodeURIComponent(parameter)}=${encodeURIComponent(value)}`, `Runtime view · ${parameter}`);
      }
    }
  }

  // Next-compatible frameworks (vinext and friends) use the App Router layout
  // without depending on `next`, so detect the convention as well as the
  // package. `pages/` stays gated on Next itself, because plenty of plain React
  // apps keep components in a pages/ folder that are not routes.
  const relativePaths = [...sourceByFile.keys()].map((file) => path.relative(root, file).replaceAll(path.sep, "/"));
  const hasAppRouter = relativePaths.some((relative) => /(?:^|\/)app\/(?:.+\/)?page\.(?:js|jsx|ts|tsx)$/.test(relative));
  const hasNextConfig = relativePaths.some((relative) => /(?:^|\/)next\.config\.(?:js|mjs|cjs|ts|mts)$/.test(relative));
  const usesPagesRouter = Boolean(dependencies.next) || hasNextConfig;

  if (dependencies.next || hasAppRouter || hasNextConfig) {
    for (const relative of relativePaths) {
      let route = null;
      // Only page.* is a rendered page; route.* is an API handler with no UI.
      const appMatch = relative.match(/(?:^|\/)app\/(.+)\/page\.(?:js|jsx|ts|tsx)$/);
      const pagesMatch = usesPagesRouter ? relative.match(/(?:^|\/)pages\/(.+)\.(?:js|jsx|ts|tsx)$/) : null;
      if (appMatch) route = `/${appMatch[1].replace(/\([^/]+\)\//g, "").replace(/\/index$/, "")}`;
      else if (pagesMatch && !pagesMatch[1].startsWith("_") && !pagesMatch[1].startsWith("api/")) route = `/${pagesMatch[1].replace(/\/index$/, "")}`;
      // Private folders (_name) and route groups are not addressable routes.
      if (route && !/[\[\]]/.test(route) && !route.split("/").some((segment) => segment.startsWith("_"))) {
        add(humanizeRoute(route), route, "Next.js route");
      }
    }
  }

  return [...pages.values()].slice(0, 60).map((page) => createJavascriptScreen(
    root,
    page.name,
    null,
    rendererEntry,
    page.capturePath,
    ["Editable rendered view", page.pattern]
  ));
}

function createJavascriptScreen(root, name, captureView = null, captureEntry = null, capturePath = "/", patterns = ["Editable rendered view"]) {
  const identity = createHash("sha256")
    .update(`${root}#${captureView ?? capturePath ?? name}`)
    .digest("hex")
    .slice(0, 20);
  return {
    id: `javascript-${identity}`,
    name,
    sourceType: "screen",
    patterns,
    sfSymbolCount: 0,
    semanticColorCount: 0,
    hasCustomFont: false,
    captureView,
    captureEntry,
    capturePath
  };
}

async function scanJavascriptProject(root) {
  const manifest = await readJson(path.join(root, "package.json"));
  const manifestInfo = javascriptManifestInfo(manifest);
  if (!manifestInfo) return null;
  const { dependencies, hasElectron } = manifestInfo;
  const hasReact = Boolean(dependencies.react || dependencies.preact);

  const sourceFiles = await collectFiles(
    root,
    (target) => /\.(?:html|js|jsx|ts|tsx|vue|svelte)$/.test(target),
    1600
  );
  const sourceByFile = new Map();
  await Promise.all(sourceFiles.map(async (file) => {
    try {
      const source = await readFile(file, "utf8");
      if (source.length <= 1_500_000) sourceByFile.set(file, source);
    } catch {}
  }));
  const productName = typeof manifest.productName === "string" && manifest.productName.trim()
    ? manifest.productName.trim()
    : typeof manifest.name === "string" && manifest.name.trim()
      ? manifest.name.trim().replace(/(^|[-_])([a-z])/g, (_match, prefix, letter) => `${prefix ? " " : ""}${letter.toUpperCase()}`)
      : path.basename(root);
  let framework = hasReact
    ? "React"
    : dependencies.vue
      ? "Vue"
      : dependencies.svelte
        ? "Svelte"
        : dependencies["@angular/core"]
          ? "Angular"
          : dependencies["solid-js"]
            ? "Solid"
            : dependencies.lit
              ? "Lit"
              : "Chromium renderer";
  if (dependencies.next) framework = "Next.js";
  else if (dependencies.vite) framework = `${framework} + Vite`;
  if (hasElectron) framework = `Electron + ${framework}`;
  if (dependencies.tailwindcss || dependencies["@tailwindcss/vite"]) framework += " + Tailwind";

  const isUiSync = manifest.name === "ui-sync-desktop" || productName === "UI Sync";
  const rendererEntry = await findRendererEntry(root);
  const screens = isUiSync
    ? [createJavascriptScreen(root, "Project", "connections")]
    : extractJavascriptPages(root, sourceByFile, dependencies, rendererEntry);

  return {
    kind: hasElectron ? "desktop" : "web",
    framework,
    analysisEngine: hasElectron ? "Electron Chromium DOM capture" : "Chromium DOM capture",
    detectedName: productName,
    sourceFileCount: sourceFiles.length,
    screens
  };
}

async function readJson(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return null;
  }
}

module.exports = {
  collectFiles,
  createJavascriptScreen,
  discoverJavascriptProjectRoots,
  discoverSwiftUiProjectRoots,
  extractSwiftUiViews,
  findRendererEntry,
  javascriptManifestInfo,
  omitWorkspaceContainers,
  prepareDesignNodes,
  scanJavascriptProject,
  scanSwiftUiProject
};
