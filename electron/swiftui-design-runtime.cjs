const http = require("node:http");
const { createHash, randomBytes } = require("node:crypto");
const { cp, mkdir, readFile, readdir, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const os = require("node:os");
const { z } = require("zod");
const { collectFiles, prepareDesignNodes } = require("./project-scanner.cjs");
const { scanWithSwiftSyntax } = require("./swift-syntax-backend.cjs");
const { requireXcodePaths } = require("./xcode-paths.cjs");
const { convertPdfToFigmaSvg, indexPdfPages, isSwiftUiUnsupportedRendererSvg } = require("./swift-pdf-vector.cjs");
const { sourceVectorEffectSchema } = require("./swift-vector-effects.cjs");

const DEFAULT_RUNTIME_PORT = 38458;
const runtimeFrameSchema = z.object({
  x: z.number().finite().min(-10000).max(10000),
  y: z.number().finite().min(-10000).max(10000),
  width: z.number().finite().min(0).max(10000),
  height: z.number().finite().min(0).max(10000)
}).strict();

const runtimeEnvironmentSchema = z.object({
  viewport: runtimeFrameSchema,
  displayScale: z.number().finite().min(0.5).max(8),
  colorScheme: z.enum(["light", "dark"]),
  dynamicTypeSize: z.string().min(1).max(80),
  layoutDirection: z.enum(["leftToRight", "rightToLeft"])
}).strict();

const runtimeNodeSchema = z.object({
  syncId: z.string().regex(/^(?:swift\/[a-f0-9]{16}|[A-Za-z][A-Za-z0-9_.:/-]{0,159})$/),
  sourceFile: z.string().min(1).max(500),
  sourceName: z.string().min(1).max(160),
  pageSourceName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,159}$/).optional(),
  kind: z.string().min(1).max(120),
  instanceId: z.string().min(1).max(120).optional(),
  frame: runtimeFrameSchema,
  environment: runtimeEnvironmentSchema.optional(),
  text: z.string().max(4000).optional(),
  assetName: z.string().min(1).max(500).optional(),
  cornerRadius: z.number().finite().min(0).max(5000).optional(),
  backgroundColor: z.string().max(80).optional(),
  fontSize: z.number().finite().min(0).max(400).optional(),
  sourceHint: z.string().min(1).max(600).optional(),
  capturedAt: z.string().datetime().optional()
}).strict();

const runtimeSnapshotSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  capturedAt: z.string().datetime(),
  deviceName: z.string().max(160).optional(),
  scheme: z.string().max(240).optional(),
  environment: runtimeEnvironmentSchema.optional(),
  nodes: z.array(runtimeNodeSchema).max(8000)
}).strict();

const instrumentableSystemViews = new Set([
  "AsyncImage", "Button", "Capsule", "Circle", "Color", "ContentUnavailableView", "DatePicker",
  "Divider", "ForEach", "Form", "Gauge", "GeometryReader", "Grid", "GridRow", "Group", "GroupBox",
  "HStack", "Image", "Label", "LazyHGrid", "LazyHStack", "LazyVGrid", "LazyVStack", "Link", "List",
  "Map", "Menu", "NavigationLink", "NavigationSplitView", "NavigationStack", "NavigationView", "Picker",
  "ProgressView", "Rectangle", "RoundedRectangle", "ScrollView", "Section", "SecureField", "Slider",
  "Spacer", "Stepper", "TabView", "Text", "TextEditor", "TextField", "TimelineView", "Toggle", "VStack",
  "ViewThatFits", "ZStack"
]);
const ambiguousResultBuilderKinds = new Set(["ForEach", "Section"]);
const swiftUiSceneKinds = new Set(["WindowGroup", "DocumentGroup", "Settings", "Commands", "MenuBarExtra", "ImmersiveSpace"]);

function json(response, statusCode, value) {
  response.writeHead(statusCode, { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

async function readJson(request, maximum = 256 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error("Runtime capture is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createSwiftUiRuntimeServer({ port = DEFAULT_RUNTIME_PORT } = {}) {
  const sessions = new Map();
  let server = null;

  function beginSession(projectRoot) {
    const token = randomBytes(24).toString("hex");
    const address = server?.address();
    const activePort = address && typeof address === "object" ? address.port : port;
    sessions.set(token, { projectRoot, nodes: new Map(), environment: null, screenshot: null, vectorPdfs: [], lastVectorAt: 0, lastCaptureAt: 0 });
    return {
      token,
      endpoint: `http://127.0.0.1:${activePort}/v1/swiftui-runtime/${token}/nodes`,
      screenshotEndpoint: `http://127.0.0.1:${activePort}/v1/swiftui-runtime/${token}/screenshot`,
      vectorEndpoint: `http://127.0.0.1:${activePort}/v1/swiftui-runtime/${token}/vector`
    };
  }

  function snapshot(token, metadata = {}) {
    const session = sessions.get(token);
    if (!session) throw new Error("The Design Build session expired");
    const environment = session.environment ?? metadata.environment;
    return runtimeSnapshotSchema.parse({
      version: environment ? 2 : 1,
      capturedAt: new Date(session.lastCaptureAt || Date.now()).toISOString(),
      ...metadata,
      ...(environment ? { environment } : {}),
      nodes: [...session.nodes.values()]
    });
  }

  // The deadline follows activity: a slow first launch keeps extending it for
  // as long as the app is still posting, so a busy Mac cannot truncate a
  // capture halfway through.
  async function waitForCapture(token, { timeoutMs = 12_000, settleMs = 750 } = {}) {
    const startedAt = Date.now();
    while (true) {
      const session = sessions.get(token);
      if (!session) throw new Error("The Design Build session expired");
      if (session.nodes.size > 0 && Date.now() - session.lastCaptureAt >= settleMs) return snapshot(token);
      if (Date.now() - Math.max(startedAt, session.lastCaptureAt) >= timeoutMs) return snapshot(token);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function waitForScreenshot(token, { timeoutMs = 6_000 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const session = sessions.get(token);
      if (!session) throw new Error("The Design Build session expired");
      if (session.screenshot) return session.screenshot;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  async function waitForVector(token, { timeoutMs = 8_000 } = {}) {
    const vectors = await waitForVectors(token, { timeoutMs });
    return vectors[0] || null;
  }

  async function waitForVectors(token, { timeoutMs = 8_000, settleMs = 2_500 } = {}) {
    const startedAt = Date.now();
    while (true) {
      const session = sessions.get(token);
      if (!session) throw new Error("The Design Build session expired");
      if (session.vectorPdfs.length > 0 && Date.now() - session.lastVectorAt >= settleMs) return [...session.vectorPdfs];
      if (Date.now() - Math.max(startedAt, session.lastVectorAt) >= timeoutMs) return [...session.vectorPdfs];
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  async function waitForVectorSource(token, { sourceName, captureKind, timeoutMs = 6_000 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const session = sessions.get(token);
      if (!session) throw new Error("The Design Build session expired");
      const match = session.vectorPdfs.find((candidate) =>
        (!captureKind || candidate.captureKind === captureKind)
        && (!sourceName || candidate.sourceName === sourceName || candidate.pageSourceNames?.includes(sourceName))
      );
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return null;
  }

  return {
    async start() {
      if (server) return;
      server = http.createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
          const match = url.pathname.match(/^\/v1\/swiftui-runtime\/([a-f0-9]{48})\/(nodes|screenshot|vector)$/);
          if (!match) return json(response, 404, { error: "Not found" });
          const session = sessions.get(match[1]);
          if (!session) return json(response, 404, { error: "Design Build session expired" });
          if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });
          if (match[2] === "screenshot") {
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
              size += chunk.length;
              if (size > 12 * 1024 * 1024) throw new Error("Runtime screenshot is too large");
              chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);
            if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) {
              throw new Error("Runtime screenshot is not a PNG");
            }
            session.screenshot = buffer;
            return json(response, 200, { accepted: true });
          }
          if (match[2] === "vector") {
            const chunks = [];
            let size = 0;
            for await (const chunk of request) {
              size += chunk.length;
              if (size > 32 * 1024 * 1024) throw new Error("Runtime PDF is too large");
              chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);
            if (buffer.length < 8 || buffer.subarray(0, 5).toString("ascii") !== "%PDF-") {
              throw new Error("Runtime vector capture is not a PDF");
            }
            const encodedPageNames = request.headers["x-ui-sync-page-names"];
            if (typeof encodedPageNames === "string" && encodedPageNames.length <= 16_000) {
              try {
                const pageNames = z.array(z.string().min(1).max(160)).max(500).parse(
                  JSON.parse(Buffer.from(encodedPageNames, "base64").toString("utf8"))
                );
                Object.defineProperty(buffer, "pageNames", { value: pageNames, enumerable: false });
              } catch {}
            }
            const captureKind = request.headers["x-ui-sync-capture-kind"];
            if (["image-renderer-root", "image-renderer-page", "image-renderer-root-clean", "image-renderer-page-clean", "window-fallback", "window-fallback-clean"].includes(captureKind)) {
              Object.defineProperty(buffer, "captureKind", { value: captureKind, enumerable: false });
            }
            const sourceName = request.headers["x-ui-sync-source-name"];
            if (typeof sourceName === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,159}$/.test(sourceName)) {
              Object.defineProperty(buffer, "sourceName", { value: sourceName, enumerable: false });
            }
            for (const [header, property, schema] of [
              ["x-ui-sync-page-source-names", "pageSourceNames", z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,159}$/)).max(500)],
              ["x-ui-sync-page-fallbacks", "pageFallbacks", z.array(z.boolean()).max(500)]
            ]) {
              const encoded = request.headers[header];
              if (typeof encoded !== "string" || encoded.length > 16_000) continue;
              try {
                const value = schema.parse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
                Object.defineProperty(buffer, property, { value, enumerable: false });
              } catch {}
            }
            const encodedPageFrame = request.headers["x-ui-sync-page-frame"];
            if (typeof encodedPageFrame === "string" && encodedPageFrame.length <= 2_000) {
              try {
                const pageFrame = runtimeFrameSchema.parse(JSON.parse(Buffer.from(encodedPageFrame, "base64").toString("utf8")));
                Object.defineProperty(buffer, "pageFrame", { value: pageFrame, enumerable: false });
              } catch {}
            }
            Object.defineProperty(buffer, "receivedAt", { value: Date.now(), enumerable: false });
            session.vectorPdfs.push(buffer);
            session.lastVectorAt = Date.now();
            return json(response, 200, { accepted: true });
          }
          const node = runtimeNodeSchema.parse(await readJson(request));
          const { environment, ...capturedNode } = node;
          if (environment) session.environment = environment;
          session.nodes.set(`${node.pageSourceName || "unscoped"}@${node.syncId}@${node.instanceId || "single"}`, { ...capturedNode, capturedAt: node.capturedAt || new Date().toISOString() });
          session.lastCaptureAt = Date.now();
          return json(response, 200, { accepted: true });
        })().catch((error) => json(response, 400, { error: error instanceof Error ? error.message : "Invalid runtime capture" }));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
    },
    beginSession,
    snapshot,
    waitForCapture,
    waitForScreenshot,
    waitForVector,
    waitForVectors,
    waitForVectorSource,
    endSession(token) { sessions.delete(token); },
    async stop() {
      if (!server) return;
      const active = server;
      server = null;
      await new Promise((resolve) => active.close(resolve));
    },
    get port() { return port; }
  };
}

function swiftString(value) {
  return JSON.stringify(String(value)).replaceAll("\\/", "/");
}

function helperName(relativeFile) {
  return createHash("sha256").update(relativeFile).digest("hex").slice(0, 10);
}

function findClosingBrace(source, openingIndex) {
  let depth = 0;
  let state = "code";
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") { state = "code"; index += 1; }
      continue;
    }
    if (state === "string") {
      if (character === "\\") { index += 1; continue; }
      if (character === '"') state = "code";
      continue;
    }
    if (character === "/" && next === "/") { state = "line-comment"; index += 1; continue; }
    if (character === "/" && next === "*") { state = "block-comment"; index += 1; continue; }
    if (character === '"') { state = "string"; continue; }
    if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function findClosingParenthesis(source, openingIndex) {
  let depth = 0;
  let state = "code";
  for (let index = openingIndex; index < source.length; index += 1) {
    const character = source[index];
    const next = source[index + 1];
    if (state === "line-comment") {
      if (character === "\n") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (character === "*" && next === "/") { state = "code"; index += 1; }
      continue;
    }
    if (state === "string") {
      if (character === "\\") { index += 1; continue; }
      if (character === '"') state = "code";
      continue;
    }
    if (character === "/" && next === "/") { state = "line-comment"; index += 1; continue; }
    if (character === "/" && next === "*") { state = "block-comment"; index += 1; continue; }
    if (character === '"') { state = "string"; continue; }
    if (character === "(") depth += 1;
    else if (character === ")") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function nativeEffectModifierEdits(sourceBytes, allNodes, suffix, excludedRanges = []) {
  const edits = [];
  const usedOffsets = new Set();
  const source = sourceBytes.toString("utf8");
  const visualEffectRanges = [];
  for (const match of source.matchAll(/\.visualEffect\s*\{/g)) {
    const opening = source.indexOf("{", match.index);
    const closing = opening >= 0 ? findClosingBrace(source, opening) : -1;
    if (closing < 0) continue;
    visualEffectRanges.push({
      startOffset: Buffer.byteLength(source.slice(0, opening), "utf8"),
      endOffset: Buffer.byteLength(source.slice(0, closing + 1), "utf8")
    });
  }
  const nodes = [...allNodes].sort((left, right) =>
    (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset)
  );
  for (const node of nodes) {
    const expression = sourceBytes.subarray(node.startOffset, node.endOffset).toString("utf8");
    for (const match of expression.matchAll(/\.(shadow|blur)\s*\(/g)) {
      const method = match[1];
      const opening = expression.indexOf("(", match.index);
      const closing = opening >= 0 ? findClosingParenthesis(expression, opening) : -1;
      if (closing < 0) continue;
      const startOffset = node.startOffset + Buffer.byteLength(expression.slice(0, match.index), "utf8");
      const endOffset = node.startOffset + Buffer.byteLength(expression.slice(0, closing), "utf8");
      if (usedOffsets.has(startOffset)
        || [...excludedRanges, ...visualEffectRanges].some((range) => startOffset >= range.startOffset && endOffset <= range.endOffset)) continue;
      usedOffsets.add(startOffset);
      const argumentsText = expression.slice(opening + 1, closing - 1);
      const effect = parseNativeSourceEffect(node, method, argumentsText);
      if (!effect) continue;
      const helper = method === "shadow" ? `_uiSyncShadow_${suffix}` : `_uiSyncBlur_${suffix}`;
      edits.push({
        startOffset,
        endOffset,
        nativeEffect: effect,
        value: `.${helper}(id: ${swiftString(node.syncId)}, sourceFile: ${swiftString(node.sourceFile)}, sourceName: ${swiftString(node.sourceName)}, ${argumentsText})._uiSyncProbe_${suffix}(id: ${swiftString(node.syncId)}, sourceFile: ${swiftString(node.sourceFile)}, sourceName: ${swiftString(node.sourceName)}, kind: ${swiftString(node.kind)}, sourceHint: ${swiftString("native-effect")})`
      });
    }
  }
  return edits;
}

function splitSwiftArguments(value) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let string = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (string) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') string = false;
      continue;
    }
    if (character === '"') { string = true; continue; }
    if ("([{<".includes(character)) depth += 1;
    else if (")]}>".includes(character)) depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function lastSourceNumber(value) {
  const values = [...String(value || "").matchAll(/-?(?:\d+(?:\.\d+)?|\.\d+)/g)].map((match) => Number(match[0]));
  return values.filter(Number.isFinite).at(-1);
}

function parseNativeSourceEffect(node, method, argumentsText) {
  const named = new Map();
  for (const argument of splitSwiftArguments(argumentsText)) {
    const match = argument.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]+)$/);
    if (match) named.set(match[1], match[2]);
  }
  const radius = lastSourceNumber(named.get("radius") ?? (method === "blur" ? splitSwiftArguments(argumentsText)[0] : ""));
  if (!(radius > 0 && radius <= 240)) return null;
  if (method === "blur") return sourceVectorEffectSchema.parse({
    id: `${node.syncId}/blur`, syncId: node.syncId, sourceFile: node.sourceFile, sourceName: node.sourceName,
    type: "LAYER_BLUR", radius
  });
  const colorExpression = named.get("color") ?? "black";
  const colorToken = colorExpression.match(/(?:Color\s*\.)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:\.opacity\s*\(|$)/)?.[1]
    ?? colorExpression.match(/\.([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    ?? "black";
  const opacityExpression = colorExpression.match(/\.opacity\s*\(([\s\S]*)\)/)?.[1];
  return sourceVectorEffectSchema.parse({
    id: `${node.syncId}/shadow`, syncId: node.syncId, sourceFile: node.sourceFile, sourceName: node.sourceName,
    type: "DROP_SHADOW", radius, colorToken,
    opacity: opacityExpression ? Math.max(0, Math.min(1, lastSourceNumber(opacityExpression) ?? 0.33)) : 0.33,
    offset: { x: lastSourceNumber(named.get("x")) ?? 0, y: lastSourceNumber(named.get("y")) ?? 0 }
  });
}

function findInstrumentableViewBuilderRanges(source) {
  const ranges = [];
  const signatures = [
    /\bvar\s+body\s*:\s*some\s+View\s*\{/g,
    /\bfunc\s+makeBody\s*\([^)]*\)\s*->\s*some\s+View\s*\{/g,
    /@ViewBuilder[\s\S]{0,160}?\bvar\s+[A-Za-z_][A-Za-z0-9_]*\s*:\s*some\s+View\s*\{/g
  ];
  for (const signature of signatures) {
    for (const match of source.matchAll(signature)) {
      const openingIndex = (match.index ?? 0) + match[0].lastIndexOf("{");
      const closingIndex = findClosingBrace(source, openingIndex);
      if (closingIndex < 0) continue;
      ranges.push({
        startOffset: Buffer.byteLength(source.slice(0, openingIndex + 1), "utf8"),
        endOffset: Buffer.byteLength(source.slice(0, closingIndex), "utf8")
      });
    }
  }
  return ranges;
}

function findNamedViewBodyRange(source, viewName) {
  const escapedName = String(viewName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const declaration = new RegExp(`\\bstruct\\s+${escapedName}\\b[^\\{]{0,500}:\\s*[^\\{]*\\bView\\b[^\\{]*\\{`).exec(source);
  if (!declaration) return null;
  const structOpening = declaration.index + declaration[0].lastIndexOf("{");
  const structClosing = findClosingBrace(source, structOpening);
  if (structClosing < 0) return null;
  const structSource = source.slice(structOpening + 1, structClosing - 1);
  const body = /\bvar\s+body\s*:\s*some\s+View\s*\{/.exec(structSource);
  if (!body) return null;
  const bodyOpening = structOpening + 1 + body.index + body[0].lastIndexOf("{");
  const bodyClosing = findClosingBrace(source, bodyOpening);
  if (bodyClosing < 0 || bodyClosing > structClosing) return null;
  return {
    startOffset: Buffer.byteLength(source.slice(0, bodyOpening + 1), "utf8"),
    endOffset: Buffer.byteLength(source.slice(0, bodyClosing), "utf8")
  };
}

function runtimeFirstArgument(expression, constructorName) {
  const source = String(expression || "");
  const match = new RegExp(`\\b${escapeRegExp(constructorName)}\\s*\\(`).exec(source);
  if (!match) return null;
  const start = match.index + match[0].length;
  let depth = 0;
  let state = "code";
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (state === "string") {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') state = "code";
      continue;
    }
    if (character === '"') {
      state = "string";
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") {
      if (depth === 0) {
        const argumentsSource = source.slice(start, index).trim();
        let comma = -1;
        let nestedDepth = 0;
        let nestedState = "code";
        let nestedEscaped = false;
        for (let cursor = 0; cursor < argumentsSource.length; cursor += 1) {
          const nestedCharacter = argumentsSource[cursor];
          if (nestedState === "string") {
            if (nestedEscaped) nestedEscaped = false;
            else if (nestedCharacter === "\\") nestedEscaped = true;
            else if (nestedCharacter === '"') nestedState = "code";
            continue;
          }
          if (nestedCharacter === '"') nestedState = "string";
          else if (["(", "[", "{"].includes(nestedCharacter)) nestedDepth += 1;
          else if ([")", "]", "}"].includes(nestedCharacter)) nestedDepth -= 1;
          else if (nestedCharacter === "," && nestedDepth === 0) {
            comma = cursor;
            break;
          }
        }
        const argument = argumentsSource.slice(0, comma < 0 ? argumentsSource.length : comma).trim();
        return argument || null;
      }
      depth -= 1;
    } else if (character === "," && depth === 0) {
      const argument = source.slice(start, index).trim();
      return argument || null;
    }
  }
  return null;
}

function runtimeTextArgument(expression) {
  const argument = runtimeFirstArgument(expression, "Text");
  if (!argument || /^(?:timerInterval|dates|image)\s*:/.test(argument)) return null;
  return argument.replace(/^verbatim\s*:\s*/, "");
}

function runtimeImageArgument(expression) {
  const argument = runtimeFirstArgument(expression, "Image");
  if (!argument || /^(?:systemName|decorative|uiImage|nsImage|cgImage|image|size)\s*:/.test(argument)) return null;
  return argument;
}

function sourceWithoutConditionalCompilation(source) {
  let depth = 0;
  return String(source || "").split(/(?<=\n)/).map((line) => {
    const directive = line.match(/^\s*#(if|elseif|else|endif)\b/)?.[1];
    if (directive === "if") {
      depth += 1;
      return " ".repeat(line.length);
    }
    if (directive === "endif") {
      depth = Math.max(0, depth - 1);
      return " ".repeat(line.length);
    }
    if (directive === "elseif" || directive === "else" || depth > 0) return " ".repeat(line.length);
    return line;
  }).join("");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function humanizeSwiftViewName(value) {
  return String(value || "")
    .replace(/View$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim() || String(value || "Page");
}

function discoverEnumNavigationPages(discoveredViews) {
  const customNames = new Set(discoveredViews.filter((view) => !view.isAppEntry).map((view) => view.name));
  const pages = [];
  for (const routeOwner of discoveredViews) {
    const source = sourceWithoutConditionalCompilation(routeOwner.source);
    for (const switchMatch of source.matchAll(/\bswitch\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\?\?\s*\.[A-Za-z_][A-Za-z0-9_]*)?\s*\{/g)) {
      const stateName = switchMatch[1];
      const enumType = source.match(new RegExp(`@Binding\\s+(?:private\\s+)?var\\s+${escapeRegExp(stateName)}\\s*:\\s*([A-Z][A-Za-z0-9_]*)\\??`))?.[1];
      if (!enumType) continue;
      const opening = source.indexOf("{", switchMatch.index);
      const closing = findClosingBrace(source, opening);
      if (closing < 0) continue;
      const body = source.slice(opening + 1, closing - 1);
      for (const routeMatch of body.matchAll(/\bcase\s+\.([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Z][A-Za-z0-9_]*)\s*\(/g)) {
        const caseName = routeMatch[1];
        const sourceName = routeMatch[2];
        if (!customNames.has(sourceName)) continue;
        const host = discoveredViews.find((candidate) => {
          const hostSource = sourceWithoutConditionalCompilation(candidate.source);
          return new RegExp(`@State\\s+(?:private\\s+)?var\\s+${escapeRegExp(stateName)}\\s*:\\s*${escapeRegExp(enumType)}\\?`).test(hostSource)
            && new RegExp(`\\b${escapeRegExp(routeOwner.name)}\\s*\\([\\s\\S]{0,500}?\\b${escapeRegExp(stateName)}\\s*:\\s*\\$${escapeRegExp(stateName)}\\b`).test(hostSource);
        });
        if (!host) continue;
        const destination = discoveredViews.find((candidate) => candidate.name === sourceName);
        const literalTitle = destination?.source.match(/\.navigationTitle\s*\(\s*("(?:\\.|[^"\\])*")\s*\)/)?.[1];
        let pageName = humanizeSwiftViewName(sourceName);
        if (literalTitle) {
          try { pageName = JSON.parse(literalTitle); } catch {}
        }
        pages.push({
          sourceName,
          pageName,
          preferWindowCapture: true,
          navigationRoute: {
            hostSourceName: host.name,
            hostRelativeFile: host.relativeFile,
            stateName,
            enumType,
            caseName
          }
        });
      }
    }
  }
  return pages.filter((page, index) => pages.findIndex((candidate) => candidate.sourceName === page.sourceName) === index);
}

function discoverSwiftUiPages(discoveredViews) {
  const customNames = new Set(discoveredViews.filter((view) => !view.isAppEntry).map((view) => view.name));
  const pages = [];
  const add = (sourceName, pageName = sourceName, systemImage = null, metadata = {}) => {
    if (customNames.has(sourceName) && !pages.some((page) => page.sourceName === sourceName)) {
      pages.push({ sourceName, pageName, ...(systemImage ? { systemImage } : {}), ...metadata });
    }
  };
  for (const owner of discoveredViews) {
    const tabViews = owner.designNodes.filter((node) => node.kind === "TabView");
    for (const tabView of tabViews) {
      const candidates = owner.designNodes
        .filter((node) => customNames.has(node.kind) && node.startOffset >= tabView.startOffset && node.endOffset <= tabView.endOffset)
        .sort((left, right) => left.startOffset - right.startOffset);
      const directPages = candidates.filter((candidate) => !candidates.some((parent) =>
        parent !== candidate && parent.startOffset <= candidate.startOffset && parent.endOffset >= candidate.endOffset
      ));
      for (const node of directPages) {
        const label = owner.designNodes.find((candidate) =>
          candidate.kind === "Label" && candidate.startOffset >= node.startOffset && candidate.endOffset <= node.endOffset
        );
        const literal = label?.expression.match(/Label\s*\(\s*("(?:\\.|[^"\\])*")/)?.[1];
        let pageName = node.kind;
        if (literal) {
          try { pageName = JSON.parse(literal); } catch {}
        }
        const systemImageLiteral = label?.expression.match(/\bsystemImage\s*:\s*("(?:\\.|[^"\\])*")/)?.[1];
        let systemImage = null;
        if (systemImageLiteral) {
          try { systemImage = JSON.parse(systemImageLiteral); } catch {}
        }
        add(node.kind, pageName, systemImage);
      }
    }
  }
  for (const page of discoverEnumNavigationPages(discoveredViews)) {
    add(page.sourceName, page.pageName, null, {
      preferWindowCapture: true,
      navigationRoute: page.navigationRoute
    });
  }
  const primaryPageNames = new Set(pages.map((page) => page.sourceName));
  const tabOwnerNames = new Set(discoveredViews
    .filter((owner) => owner.designNodes.some((node) => node.kind === "TabView"))
    .map((owner) => owner.name));
  for (const owner of discoveredViews) {
    if (!primaryPageNames.has(owner.name) && !tabOwnerNames.has(owner.name)) continue;
    const modalContainers = owner.designNodes.filter((node) => /\.(?:sheet|fullScreenCover)\s*\(/.test(node.expression));
    for (const container of modalContainers) {
      const expression = container.expression;
      const modalStarts = [...expression.matchAll(/\.(?:sheet|fullScreenCover)\s*\(/g)]
        .map((match) => container.startOffset + Buffer.byteLength(expression.slice(0, match.index), "utf8"));
      const candidates = owner.designNodes
        .filter((node) => customNames.has(node.kind)
          && node.startOffset >= container.startOffset
          && node.endOffset <= container.endOffset
          && modalStarts.some((startOffset) => node.startOffset >= startOffset))
        .sort((left, right) => left.startOffset - right.startOffset);
      const directPages = candidates.filter((candidate) => !candidates.some((parent) =>
        parent !== candidate && parent.startOffset <= candidate.startOffset && parent.endOffset >= candidate.endOffset
      ));
      for (const node of directPages) add(node.kind, node.kind.replace(/View$/, "") || node.kind);
    }
  }
  if (pages.length === 0) {
    for (const app of discoveredViews.filter((view) => view.isAppEntry)) {
      const root = app.designNodes.find((node) => customNames.has(node.kind));
      if (root) add(root.kind);
    }
  }
  return pages;
}

function navigationRouteStateEdits(source, suffix, discoveredViews, routes) {
  const ownerNames = new Set(discoveredViews.map((view) => view.name));
  const grouped = new Map();
  for (const route of routes ?? []) {
    if (!ownerNames.has(route.navigationRoute?.hostSourceName)) continue;
    const identity = `${route.navigationRoute.hostSourceName}:${route.navigationRoute.stateName}:${route.navigationRoute.enumType}`;
    if (!grouped.has(identity)) grouped.set(identity, []);
    grouped.get(identity).push(route);
  }
  const edits = [];
  for (const routesForState of grouped.values()) {
    const { stateName, enumType } = routesForState[0].navigationRoute;
    const declaration = new RegExp(`@State\\s+(?:private\\s+)?var\\s+${escapeRegExp(stateName)}\\s*:\\s*${escapeRegExp(enumType)}\\?\\s*=\\s*([^\\n;]+)`).exec(source);
    if (!declaration) continue;
    const originalDefault = declaration[1].trim();
    const valueStart = declaration.index + declaration[0].lastIndexOf(declaration[1]);
    const routeCases = routesForState.map((page) =>
      `case ${swiftString(page.sourceName)}: return ${enumType}.${page.navigationRoute.caseName}`
    ).join("\n      ");
    edits.push({
      startOffset: Buffer.byteLength(source.slice(0, valueStart), "utf8"),
      endOffset: Buffer.byteLength(source.slice(0, valueStart + declaration[1].length), "utf8"),
      value: `{\n      switch _uiSyncActivePageSourceName_${suffix} {\n      ${routeCases}\n      default: return ${originalDefault}\n      }\n    }()`
    });
  }
  return edits;
}

function discoverSwiftUiPageViewNames(discoveredViews) {
  return discoverSwiftUiPages(discoveredViews).map((page) => page.sourceName);
}

function discoverSwiftUiPrimaryTabPageViewNames(discoveredViews, pageViewNames) {
  const pageNames = new Set(pageViewNames);
  const primaryPages = [];
  for (const owner of discoveredViews) {
    for (const tabView of owner.designNodes.filter((node) => node.kind === "TabView")) {
      const candidates = owner.designNodes
        .filter((node) => pageNames.has(node.kind) && node.startOffset >= tabView.startOffset && node.endOffset <= tabView.endOffset)
        .sort((left, right) => left.startOffset - right.startOffset);
      const directPages = candidates.filter((candidate) => !candidates.some((parent) =>
        parent !== candidate && parent.startOffset <= candidate.startOffset && parent.endOffset >= candidate.endOffset
      ));
      for (const page of directPages) {
        if (!primaryPages.includes(page.kind)) primaryPages.push(page.kind);
      }
    }
  }
  return primaryPages;
}

function fullPageTabEdits(sourceBytes, discoveredViews, suffix, pageViewNames) {
  const customNames = new Set(pageViewNames);
  const edits = [];
  for (const owner of discoveredViews) {
    for (const tabView of owner.designNodes.filter((node) => node.kind === "TabView")) {
      const candidates = owner.designNodes
        .filter((node) => customNames.has(node.kind) && node.startOffset >= tabView.startOffset && node.endOffset <= tabView.endOffset)
        .sort((left, right) => left.startOffset - right.startOffset);
      const directPages = candidates.filter((candidate) => !candidates.some((parent) =>
        parent !== candidate && parent.startOffset <= candidate.startOffset && parent.endOffset >= candidate.endOffset
      ));
      if (directPages.length < 2) continue;
      const expression = sourceBytes.subarray(tabView.startOffset, tabView.endOffset).toString("utf8");
      const selectionBinding = expression.match(/^TabView\s*\(\s*selection\s*:\s*\$([A-Za-z_][A-Za-z0-9_.]*)\s*\)/s)?.[1];
      const branches = directPages.map((node) => ({
        index: pageViewNames.indexOf(node.kind),
        expression: sourceBytes.subarray(node.startOffset, node.endOffset).toString("utf8"),
        tag: sourceBytes.subarray(node.startOffset, node.endOffset).toString("utf8")
          .match(/\.tag\s*\(\s*([^\n\r)]+)\s*\)/)?.[1]?.trim()
      })).filter((branch) => branch.index >= 0);
      if (branches.length < 2) continue;
      const flattenedBody = [...branches]
        .sort((left, right) => left.index - right.index)
        .map((branch, index) => `${index === 0 ? "if" : "else if"} _uiSyncSelectedPageIndex_${suffix} == ${branch.index} {\n${branch.expression}\n}`)
        .join(" ");
      let normalExpression = expression;
      if (selectionBinding && branches.every((branch) => branch.tag)) {
        const fallback = [...branches].sort((left, right) => left.index - right.index)[0];
        const cases = branches
          .sort((left, right) => left.index - right.index)
          .map((branch) => `case ${branch.index}: ${selectionBinding} = ${branch.tag}`)
          .join("\n");
        normalExpression = `${expression}.onAppear {\nswitch _uiSyncSelectedPageIndex_${suffix} {\n${cases}\ndefault: ${selectionBinding} = ${fallback.tag}\n}\n}`;
      }
      edits.push({
        startOffset: tabView.startOffset,
        endOffset: tabView.endOffset,
        value: `_UISyncTabCaptureSwitch_${suffix}(normal: {\n${normalExpression}\n}, capture: {\nGroup {\n${flattenedBody}\n}\n})`
      });
    }
  }
  return edits;
}

function modalPageEdits(sourceBytes, discoveredViews, suffix, pageViewNames) {
  const pageNames = new Set(pageViewNames);
  const edits = [];
  const usedContainers = new Set();
  for (const owner of discoveredViews) {
    const containers = owner.designNodes.filter((node) => /\.(?:sheet|fullScreenCover)\s*\(/.test(node.expression));
    for (const container of containers) {
      const candidates = owner.designNodes
        .filter((node) => pageNames.has(node.kind) && node.startOffset >= container.startOffset && node.endOffset <= container.endOffset)
        .sort((left, right) => left.startOffset - right.startOffset);
      for (const candidate of candidates) {
        const prefix = sourceBytes.subarray(container.startOffset, candidate.startOffset).toString("utf8");
        const presentations = [...prefix.matchAll(/\.(?:sheet|fullScreenCover)\s*\(\s*isPresented\s*:\s*\$([A-Za-z_][A-Za-z0-9_.]*)/g)];
        const presentation = presentations.at(-1);
        if (!presentation) continue;
        const key = `${container.startOffset}:${candidate.kind}`;
        if (usedContainers.has(key)) continue;
        usedContainers.add(key);
        edits.push({
          offset: container.endOffset,
          value: `.onAppear {\nif _uiSyncActivePageSourceName_${suffix} == ${swiftString(candidate.kind)} { ${presentation[1]} = true }\n}`
        });
      }
    }
  }
  return edits;
}

function navigationContentPageEdits(discoveredViews, suffix, pageViewNames) {
  const pageNames = new Set(pageViewNames);
  const edits = [];
  for (const owner of discoveredViews.filter((view) => pageNames.has(view.name))) {
    const navigationRoots = owner.designNodes.filter((node) => node.kind === "NavigationStack" || node.kind === "NavigationView");
    for (const navigation of navigationRoots) {
      const scroll = owner.designNodes
        .filter((node) => node.kind === "ScrollView"
          && node.startOffset >= navigation.startOffset
          && node.endOffset <= navigation.endOffset)
        .sort((left, right) => left.startOffset - right.startOffset)[0];
      if (!scroll) continue;
      const content = owner.designNodes
        .filter((node) => ["VStack", "LazyVStack", "ZStack", "Group", "List", "Form"].includes(node.kind)
          && node.startOffset >= scroll.startOffset
          && node.endOffset <= scroll.endOffset)
        .sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset)[0];
      if (!content) continue;
      edits.push({
        offset: content.endOffset,
        value: `._uiSyncCaptureFullPage_${suffix}(sourceName: ${swiftString(owner.name)})`
      });
    }
  }
  return edits;
}

function runtimeHelperSource(suffix, endpoint, vectorEndpoint, includeVectorCapture, pageViewNames = []) {
  const swiftPageSourceNames = `[${pageViewNames.map(swiftString).join(", ")}]`;
  const source = `

#if canImport(UIKit)
import UIKit
#endif

#if DEBUG
private func _uiSyncArgument_${suffix}(_ name: String) -> String? {
  let arguments = ProcessInfo.processInfo.arguments
  guard let index = arguments.firstIndex(of: name), arguments.indices.contains(index + 1) else { return nil }
  return arguments[index + 1]
}

private var _uiSyncSelectedPageIndex_${suffix}: Int {
  Int(ProcessInfo.processInfo.environment["UI_SYNC_PAGE_INDEX"] ?? _uiSyncArgument_${suffix}("-uiSyncPageIndex") ?? "0") ?? 0
}

private var _uiSyncActivePageSourceName_${suffix}: String? {
  ProcessInfo.processInfo.environment["UI_SYNC_PAGE_SOURCE_NAME"] ?? _uiSyncArgument_${suffix}("-uiSyncPageSourceName")
}

private let _uiSyncDisableNativeEffectsKey_${suffix} = "io.ui-sync.design-build.disable-native-effects"

private struct _UISyncFlattenTabViewKey_${suffix}: EnvironmentKey {
  static let defaultValue = false
}

private struct _UISyncHideCapturedTextKey_${suffix}: EnvironmentKey {
  static let defaultValue = false
}

private extension EnvironmentValues {
  var _uiSyncFlattenTabView_${suffix}: Bool {
    get { self[_UISyncFlattenTabViewKey_${suffix}.self] }
    set { self[_UISyncFlattenTabViewKey_${suffix}.self] = newValue }
  }

  var _uiSyncHideCapturedText_${suffix}: Bool {
    get { self[_UISyncHideCapturedTextKey_${suffix}.self] }
    set { self[_UISyncHideCapturedTextKey_${suffix}.self] = newValue }
  }
}

private struct _UISyncTabCaptureSwitch_${suffix}<Normal: View, Capture: View>: View {
  let normal: () -> Normal
  let capture: () -> Capture
  @Environment(\\._uiSyncFlattenTabView_${suffix}) private var flatten

  @ViewBuilder
  var body: some View {
    if flatten { capture() }
    else { normal() }
  }
}

private struct _UISyncShadowModifier_${suffix}: ViewModifier {
  let color: Color
  let radius: CGFloat
  let x: CGFloat
  let y: CGFloat
  private var disabled: Bool { UserDefaults.standard.bool(forKey: _uiSyncDisableNativeEffectsKey_${suffix}) }

  @ViewBuilder
  func body(content: Content) -> some View {
    if disabled { content }
    else { content.shadow(color: color, radius: radius, x: x, y: y) }
  }
}

private struct _UISyncBlurModifier_${suffix}: ViewModifier {
  let radius: CGFloat
  let opaque: Bool
  private var disabled: Bool { UserDefaults.standard.bool(forKey: _uiSyncDisableNativeEffectsKey_${suffix}) }

  @ViewBuilder
  func body(content: Content) -> some View {
    if disabled { content }
    else { content.blur(radius: radius, opaque: opaque) }
  }
}

private extension View {
  func _uiSyncShadow_${suffix}(id: String, sourceFile: String, sourceName: String, color: Color = .black.opacity(0.33), radius: CGFloat, x: CGFloat = 0, y: CGFloat = 0) -> some View {
    modifier(_UISyncShadowModifier_${suffix}(color: color, radius: radius, x: x, y: y))
  }

  func _uiSyncBlur_${suffix}(id: String, sourceFile: String, sourceName: String, radius: CGFloat, opaque: Bool = false) -> some View {
    modifier(_UISyncBlurModifier_${suffix}(radius: radius, opaque: opaque))
  }
}

private struct _UISyncProbeModifier_${suffix}: ViewModifier {
  let id: String
  let sourceFile: String
  let sourceName: String
  let kind: String
  let cornerRadius: CGFloat?
  let backgroundColor: String?
  let fontSize: CGFloat?
  let sourceHint: String?
  let text: String?
  let assetName: String?
  @Environment(\\.colorScheme) private var colorScheme
  @Environment(\\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\\.layoutDirection) private var layoutDirection
  @Environment(\\._uiSyncHideCapturedText_${suffix}) private var hideCapturedText

  @ViewBuilder
  func body(content: Content) -> some View {
    if hideCapturedText && kind == "Text" && text != nil {
      content.opacity(0)
    } else {
      content.overlay {
        GeometryReader { proxy in
          Color.clear
            .allowsHitTesting(false)
            .accessibilityHidden(true)
            .onAppear { emit(proxy.frame(in: .global)) }
            .onChange(of: proxy.frame(in: .global)) { frame in emit(frame) }
        }
      }
    }
  }

  private func emit(_ frame: CGRect) {
    _uiSyncEmit_${suffix}(
      id: id,
      sourceFile: sourceFile,
      sourceName: sourceName,
      kind: kind,
      frame: frame,
      colorScheme: String(describing: colorScheme),
      dynamicTypeSize: String(describing: dynamicTypeSize),
      layoutDirection: String(describing: layoutDirection),
      cornerRadius: cornerRadius,
      backgroundColor: backgroundColor,
      fontSize: fontSize,
      sourceHint: sourceHint,
      text: text,
      assetName: assetName
    )
  }
}

private extension View {
  func _uiSyncProbe_${suffix}(id: String, sourceFile: String, sourceName: String, kind: String, cornerRadius: CGFloat? = nil, backgroundColor: String? = nil, fontSize: CGFloat? = nil, sourceHint: String? = nil, text: String? = nil, assetName: String? = nil) -> some View {
    modifier(_UISyncProbeModifier_${suffix}(id: id, sourceFile: sourceFile, sourceName: sourceName, kind: kind, cornerRadius: cornerRadius, backgroundColor: backgroundColor, fontSize: fontSize, sourceHint: sourceHint, text: text, assetName: assetName))
  }
}

private struct _UISyncPageCaptureHost_${suffix}<RenderedContent: View>: View {
  let content: RenderedContent
  let sourceName: String
  let fullViewport: Bool
  @State private var didCapture = false
  @Environment(\\.colorScheme) private var colorScheme
  @Environment(\\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\\.layoutDirection) private var layoutDirection

  @MainActor
  var body: some View {
    content.overlay {
      GeometryReader { proxy in
        Color.clear
          .allowsHitTesting(false)
          .accessibilityHidden(true)
          .onAppear { scheduleCapture(frame: proxy.frame(in: .global)) }
      }
    }
  }

  @MainActor
  private func scheduleCapture(frame: CGRect) {
    if let activeSourceName = _uiSyncActivePageSourceName_${suffix}, activeSourceName != sourceName { return }
#if canImport(UIKit)
    let size = fullViewport ? UIScreen.main.bounds.size : frame.size
    let captureFrame = fullViewport ? UIScreen.main.bounds : frame
#else
    let size = frame.size
    let captureFrame = frame
#endif
    guard !didCapture, size.width > 1, size.height > 1 else { return }
    didCapture = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 350_000_000)
      guard #available(iOS 16.0, macOS 13.0, *) else { return }
      let renderedContent = content
        .environment(\\.colorScheme, colorScheme)
        .environment(\\.dynamicTypeSize, dynamicTypeSize)
        .environment(\\.layoutDirection, layoutDirection)
        .environment(\\._uiSyncFlattenTabView_${suffix}, true)
        .ignoresSafeArea()
        .frame(width: size.width, height: size.height, alignment: fullViewport ? .top : .center)
      let renderer = ImageRenderer(content: renderedContent)
      renderer.proposedSize = ProposedViewSize(width: size.width, height: size.height)
      renderer.render { renderedSize, render in
        let data = NSMutableData()
        var mediaBox = CGRect(origin: .zero, size: renderedSize)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return }
        context.beginPDFPage(nil)
        render(context)
        context.endPDFPage()
        context.closePDF()
        guard data.length > 8, let url = URL(string: ${swiftString(vectorEndpoint)}) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
        request.setValue("image-renderer-page", forHTTPHeaderField: "X-UI-Sync-Capture-Kind")
        let effectiveSourceName = _uiSyncArgument_${suffix}("-uiSyncPageSourceName") ?? sourceName
        request.setValue(effectiveSourceName, forHTTPHeaderField: "X-UI-Sync-Source-Name")
        if let pageName = _uiSyncArgument_${suffix}("-uiSyncPageName"),
           let encodedName = try? JSONEncoder().encode([pageName]) {
          request.setValue(encodedName.base64EncodedString(), forHTTPHeaderField: "X-UI-Sync-Page-Names")
        }
        let pageFrame: [String: CGFloat] = ["x": captureFrame.minX, "y": captureFrame.minY, "width": captureFrame.width, "height": captureFrame.height]
        if let encodedFrame = try? JSONSerialization.data(withJSONObject: pageFrame) {
          request.setValue(encodedFrame.base64EncodedString(), forHTTPHeaderField: "X-UI-Sync-Page-Frame")
        }
        request.httpBody = data as Data
        URLSession.shared.dataTask(with: request).resume()
      }
      UserDefaults.standard.set(true, forKey: _uiSyncDisableNativeEffectsKey_${suffix})
      let cleanContent = content
        .environment(\\.colorScheme, colorScheme)
        .environment(\\.dynamicTypeSize, dynamicTypeSize)
        .environment(\\.layoutDirection, layoutDirection)
        .environment(\\._uiSyncFlattenTabView_${suffix}, true)
        .ignoresSafeArea()
        .frame(width: size.width, height: size.height, alignment: fullViewport ? .top : .center)
      let cleanRenderer = ImageRenderer(content: cleanContent)
      cleanRenderer.proposedSize = ProposedViewSize(width: size.width, height: size.height)
      cleanRenderer.render { renderedSize, render in
        let data = NSMutableData()
        var mediaBox = CGRect(origin: .zero, size: renderedSize)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return }
        context.beginPDFPage(nil)
        render(context)
        context.endPDFPage()
        context.closePDF()
        guard data.length > 8, let url = URL(string: ${swiftString(vectorEndpoint)}) else { return }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
        request.setValue("image-renderer-page-clean", forHTTPHeaderField: "X-UI-Sync-Capture-Kind")
        let effectiveSourceName = _uiSyncArgument_${suffix}("-uiSyncPageSourceName") ?? sourceName
        request.setValue(effectiveSourceName, forHTTPHeaderField: "X-UI-Sync-Source-Name")
        let pageFrame: [String: CGFloat] = ["x": captureFrame.minX, "y": captureFrame.minY, "width": captureFrame.width, "height": captureFrame.height]
        if let encodedFrame = try? JSONSerialization.data(withJSONObject: pageFrame) {
          request.setValue(encodedFrame.base64EncodedString(), forHTTPHeaderField: "X-UI-Sync-Page-Frame")
        }
        request.httpBody = data as Data
        URLSession.shared.dataTask(with: request).resume()
      }
      UserDefaults.standard.set(false, forKey: _uiSyncDisableNativeEffectsKey_${suffix})
    }
  }
}

private extension View {
  func _uiSyncCapturePage_${suffix}(sourceName: String) -> some View {
    _UISyncPageCaptureHost_${suffix}(content: self, sourceName: sourceName, fullViewport: false)
  }

  func _uiSyncCaptureFullPage_${suffix}(sourceName: String) -> some View {
    _UISyncPageCaptureHost_${suffix}(content: self, sourceName: sourceName, fullViewport: true)
  }
}

// UI_SYNC_VECTOR_CAPTURE_START
private struct _UISyncVectorCaptureHost_${suffix}<RenderedContent: View>: View {
  let content: RenderedContent
  let renderRoot: Bool
  @State private var didCapture = false
  @State private var hideCapturedText = false
  @Environment(\\.colorScheme) private var colorScheme
  @Environment(\\.dynamicTypeSize) private var dynamicTypeSize
  @Environment(\\.layoutDirection) private var layoutDirection

  @MainActor
  var body: some View {
    content
      .environment(\\._uiSyncHideCapturedText_${suffix}, hideCapturedText)
      .overlay {
      GeometryReader { proxy in
        Color.clear
          .allowsHitTesting(false)
          .accessibilityHidden(true)
          .onAppear { scheduleCapture(size: proxy.size) }
      }
    }
  }

  @MainActor
  private func scheduleCapture(size: CGSize) {
    guard !didCapture, size.width > 1, size.height > 1 else { return }
    didCapture = true
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 750_000_000)
      await capture(size: size)
    }
  }

  @MainActor
  private func capture(size: CGSize) async {
    guard #available(iOS 16.0, macOS 13.0, *) else { return }
    if renderRoot {
      let renderedContent = content
        .environment(\\.colorScheme, colorScheme)
        .environment(\\.dynamicTypeSize, dynamicTypeSize)
        .environment(\\.layoutDirection, layoutDirection)
        .frame(width: size.width, height: size.height)
      let renderer = ImageRenderer(content: renderedContent)
      renderer.proposedSize = ProposedViewSize(width: size.width, height: size.height)
      var pdf: Data?
      renderer.render { renderedSize, render in
        let data = NSMutableData()
        var mediaBox = CGRect(origin: .zero, size: renderedSize)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return }
        context.beginPDFPage(nil)
        render(context)
        context.endPDFPage()
        context.closePDF()
        pdf = data as Data
      }
      if let pdf, pdf.count > 8 {
        post(pdf, captureKind: "image-renderer-root", sourceName: _uiSyncArgument_${suffix}("-uiSyncPageSourceName"))
      }
      UserDefaults.standard.set(true, forKey: _uiSyncDisableNativeEffectsKey_${suffix})
      let cleanContent = content
        .environment(\\.colorScheme, colorScheme)
        .environment(\\.dynamicTypeSize, dynamicTypeSize)
        .environment(\\.layoutDirection, layoutDirection)
        .frame(width: size.width, height: size.height)
      let cleanRenderer = ImageRenderer(content: cleanContent)
      cleanRenderer.proposedSize = ProposedViewSize(width: size.width, height: size.height)
      var cleanPdf: Data?
      cleanRenderer.render { renderedSize, render in
        let data = NSMutableData()
        var mediaBox = CGRect(origin: .zero, size: renderedSize)
        guard let consumer = CGDataConsumer(data: data as CFMutableData),
              let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return }
        context.beginPDFPage(nil)
        render(context)
        context.endPDFPage()
        context.closePDF()
        cleanPdf = data as Data
      }
      if let cleanPdf, cleanPdf.count > 8 {
        post(cleanPdf, captureKind: "image-renderer-root-clean", sourceName: _uiSyncArgument_${suffix}("-uiSyncPageSourceName"))
      }
      UserDefaults.standard.set(false, forKey: _uiSyncDisableNativeEffectsKey_${suffix})
    }
#if canImport(UIKit)
    await captureWindow(captureKind: "window-fallback", settleNanoseconds: 1_400_000_000)
    hideCapturedText = true
    // Give SwiftUI one display turn to apply opacity without allowing a
    // timeline, animation, or live renderer to advance to a different scene.
    try? await Task.sleep(nanoseconds: 16_000_000)
    await captureWindow(captureKind: "window-fallback-clean", settleNanoseconds: 0)
    hideCapturedText = false
#endif
  }

  @MainActor
  private func post(_ pdf: Data, pageNames: [String] = [], captureKind: String, pageSourceNames: [String] = [], pageFallbacks: [Bool] = [], sourceName: String? = nil) {
    guard let url = URL(string: ${swiftString(vectorEndpoint)}) else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
    request.setValue(captureKind, forHTTPHeaderField: "X-UI-Sync-Capture-Kind")
    let effectivePageNames = pageNames.isEmpty ? _uiSyncArgument_${suffix}("-uiSyncPageName").map { [$0] } ?? [] : pageNames
    let effectiveSourceNames = pageSourceNames.isEmpty ? (sourceName ?? _uiSyncArgument_${suffix}("-uiSyncPageSourceName")).map { [$0] } ?? [] : pageSourceNames
    if let sourceName = sourceName ?? _uiSyncArgument_${suffix}("-uiSyncPageSourceName") {
      request.setValue(sourceName, forHTTPHeaderField: "X-UI-Sync-Source-Name")
    }
    if let encodedNames = try? JSONEncoder().encode(effectivePageNames), !effectivePageNames.isEmpty {
      request.setValue(encodedNames.base64EncodedString(), forHTTPHeaderField: "X-UI-Sync-Page-Names")
    }
    if let encodedSourceNames = try? JSONEncoder().encode(effectiveSourceNames), !effectiveSourceNames.isEmpty {
      request.setValue(encodedSourceNames.base64EncodedString(), forHTTPHeaderField: "X-UI-Sync-Page-Source-Names")
    }
    if let encodedFallbacks = try? JSONEncoder().encode(pageFallbacks), !pageFallbacks.isEmpty {
      request.setValue(encodedFallbacks.base64EncodedString(), forHTTPHeaderField: "X-UI-Sync-Page-Fallbacks")
    }
    request.httpBody = pdf
    URLSession.shared.dataTask(with: request).resume()
  }

#if canImport(UIKit)
  @MainActor
  private func opaqueRenderers(in view: UIView) -> [UIView] {
    let className = NSStringFromClass(type(of: view))
    if ["SCNView", "MTKView", "MKMapView", "WKWebView", "PDFView", "AVPlayerView"].contains(where: { className.hasSuffix($0) }) { return [view] }
    return view.subviews.flatMap { opaqueRenderers(in: $0) }
  }

  @MainActor
  private func containsOpaqueRenderer(_ view: UIView) -> Bool {
    !opaqueRenderers(in: view).isEmpty
  }

  @MainActor
  private func renderWindow(_ window: UIWindow, in context: CGContext) {
    let opaqueSnapshots = opaqueRenderers(in: window).compactMap { renderer -> (UIView, Float, CGRect, UIImage)? in
      let frame = renderer.convert(renderer.bounds, to: window)
      guard frame.width > 0, frame.height > 0 else { return nil }
      let image = UIGraphicsImageRenderer(bounds: renderer.bounds).image { _ in
        renderer.drawHierarchy(in: renderer.bounds, afterScreenUpdates: true)
      }
      return (renderer, renderer.layer.opacity, frame, image)
    }
    let tabBar = findTabController(window.rootViewController)?.tabBar
    let originalTabBarOpacity = tabBar?.layer.opacity
    tabBar?.layer.opacity = 0
    for (renderer, _, _, _) in opaqueSnapshots { renderer.layer.opacity = 0 }
    context.saveGState()
    context.translateBy(x: 0, y: window.bounds.height)
    context.scaleBy(x: 1, y: -1)
    window.layer.render(in: context)
    for (_, _, frame, image) in opaqueSnapshots {
      UIGraphicsPushContext(context)
      image.draw(in: frame)
      UIGraphicsPopContext()
    }
    context.restoreGState()
    for (renderer, opacity, _, _) in opaqueSnapshots { renderer.layer.opacity = opacity }
    if let originalTabBarOpacity { tabBar?.layer.opacity = originalTabBarOpacity }
  }

  @MainActor
  private func captureWindow(captureKind: String, settleNanoseconds: UInt64) async {
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
          let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return }
    let tabController = findTabController(window.rootViewController)
    let originalTab = tabController?.selectedIndex ?? 0
    let requestedPageIndex = _uiSyncArgument_${suffix}("-uiSyncPageIndex").flatMap(Int.init)
    let availablePageIndexes = tabController?.viewControllers?.indices.map { $0 } ?? [0]
    let pageIndexes = requestedPageIndex.map {
      availablePageIndexes.contains($0) ? [$0] : [tabController?.selectedIndex ?? 0]
    } ?? availablePageIndexes
    let tabPageNames = tabController?.tabBar.items?.enumerated().map { index, item in
      item.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? item.title! : "Page \(index + 1)"
    } ?? ["Page 1"]
    let pageNames = _uiSyncArgument_${suffix}("-uiSyncPageName").map { [$0] } ?? tabPageNames
    let configuredSourceNames: [String] = ${swiftPageSourceNames}
    let pageSourceNames = _uiSyncArgument_${suffix}("-uiSyncPageSourceName").map { [$0] }
      ?? (configuredSourceNames.count == pageIndexes.count ? configuredSourceNames : [])
    let data = NSMutableData()
    var mediaBox = window.bounds
    guard let consumer = CGDataConsumer(data: data as CFMutableData),
          let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return }
    var pageFallbacks: [Bool] = []
    for pageIndex in pageIndexes {
      if let tabController { tabController.selectedIndex = pageIndex }
      if settleNanoseconds > 0 { try? await Task.sleep(nanoseconds: settleNanoseconds) }
      tabController?.selectedViewController?.view.setNeedsLayout()
      tabController?.selectedViewController?.view.layoutIfNeeded()
      window.layoutIfNeeded()
      let visibleRoot = tabController?.selectedViewController?.view ?? window
      pageFallbacks.append(containsOpaqueRenderer(visibleRoot))
      context.beginPDFPage(nil)
      renderWindow(window, in: context)
      context.endPDFPage()
    }
    context.closePDF()
    tabController?.selectedIndex = originalTab
    if data.length > 8 {
      post(data as Data, pageNames: pageNames, captureKind: captureKind, pageSourceNames: pageSourceNames, pageFallbacks: pageFallbacks)
    }
  }

  @MainActor
  private func findTabController(_ controller: UIViewController?) -> UITabBarController? {
    guard let controller else { return nil }
    if let tabs = controller as? UITabBarController { return tabs }
    for child in controller.children {
      if let tabs = findTabController(child) { return tabs }
    }
    if let presented = controller.presentedViewController { return findTabController(presented) }
    return nil
  }
#endif
}
// UI_SYNC_VECTOR_CAPTURE_END

private func _uiSyncEmit_${suffix}(id: String, sourceFile: String, sourceName: String, kind: String, frame: CGRect, colorScheme: String, dynamicTypeSize: String, layoutDirection: String, cornerRadius: CGFloat?, backgroundColor: String?, fontSize: CGFloat?, sourceHint: String?, text: String?, assetName: String?) {
  guard let url = URL(string: ${swiftString(endpoint)}) else { return }
#if canImport(UIKit)
  let screen = UIScreen.main
  let viewport = screen.bounds
  let environment: [String: Any] = [
    "viewport": ["x": viewport.minX, "y": viewport.minY, "width": viewport.width, "height": viewport.height],
    "displayScale": screen.scale,
    "colorScheme": colorScheme,
    "dynamicTypeSize": dynamicTypeSize,
    "layoutDirection": layoutDirection
  ]
#else
  let environment: [String: Any] = [
    "viewport": ["x": 0, "y": 0, "width": max(frame.maxX, 1), "height": max(frame.maxY, 1)],
    "displayScale": 1,
    "colorScheme": colorScheme,
    "dynamicTypeSize": dynamicTypeSize,
    "layoutDirection": layoutDirection
  ]
#endif
  var payload: [String: Any] = [
    "syncId": id,
    "sourceFile": sourceFile,
    "sourceName": sourceName,
    "kind": kind,
    "instanceId": "\\(Int((frame.minX * 100).rounded())):\\(Int((frame.minY * 100).rounded())):\\(Int((frame.width * 100).rounded())):\\(Int((frame.height * 100).rounded()))",
    "frame": ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height],
    "environment": environment,
    "capturedAt": ISO8601DateFormatter().string(from: Date())
  ]
  if let cornerRadius { payload["cornerRadius"] = cornerRadius }
  if let backgroundColor { payload["backgroundColor"] = backgroundColor }
  if let fontSize { payload["fontSize"] = fontSize }
  if let sourceHint { payload["sourceHint"] = sourceHint }
  if let text { payload["text"] = String(text.prefix(500)) }
  if let assetName { payload["assetName"] = String(assetName.prefix(500)) }
  if let pageSourceName = _uiSyncActivePageSourceName_${suffix} {
    payload["pageSourceName"] = pageSourceName
  }
  guard let body = try? JSONSerialization.data(withJSONObject: payload) else { return }
  var request = URLRequest(url: url)
  request.httpMethod = "POST"
  request.setValue("application/json", forHTTPHeaderField: "Content-Type")
  request.httpBody = body
  URLSession.shared.dataTask(with: request).resume()
}
#endif
`;
  return includeVectorCapture
    ? source
    : source.replace(/\/\/ UI_SYNC_VECTOR_CAPTURE_START[\s\S]*?\/\/ UI_SYNC_VECTOR_CAPTURE_END\n/, "");
}

function instrumentSwiftSource(source, relativeFile, discoveredViews, endpoint, vectorEndpoint = endpoint.replace(/\/nodes$/, "/vector"), options = {}) {
  const suffix = helperName(relativeFile);
  const sourceBytes = Buffer.from(source, "utf8");
  const viewBuilderRanges = findInstrumentableViewBuilderRanges(source);
  const customViews = new Set(discoveredViews.map((view) => view.name));
  const edits = [];
  edits.push(...navigationRouteStateEdits(source, suffix, discoveredViews, options.navigationRoutes));
  const tabEdits = options.renderFullTabPages
    ? fullPageTabEdits(sourceBytes, discoveredViews, suffix, options.pageViewNames ?? [])
    : [];
  edits.push(...tabEdits);
  edits.push(...modalPageEdits(sourceBytes, discoveredViews, suffix, options.pageViewNames ?? []));
  const allNodes = discoveredViews.flatMap((view) => prepareDesignNodes(relativeFile, view.name, view.designNodes).map((node) => ({ view, node })));
  const explicitNodes = allNodes.filter(({ node }) => /\.designNode\s*\(\s*"[A-Za-z][A-Za-z0-9_.:/-]{0,159}"/.test(node.expression));
  const candidates = explicitNodes.length > 0 ? explicitNodes : allNodes;
  const nativeEffectEdits = nativeEffectModifierEdits(sourceBytes, allNodes.map(({ view, node }) => ({
    ...node,
    sourceFile: relativeFile,
    sourceName: view.name
  })), suffix, tabEdits);
  edits.push(...nativeEffectEdits);
  const appRoot = discoveredViews
    .filter((view) => view.isAppEntry)
    .flatMap((view) => view.designNodes)
    .find((node) => !swiftUiSceneKinds.has(node.kind) && !/#(?:if|elseif|else|endif)\b/.test(node.expression));
  if (appRoot) {
    edits.push({ offset: appRoot.endOffset, value: `, renderRoot: ${options.renderFullTabPages ? "false" : "true"})` });
    edits.push({ offset: appRoot.startOffset, value: `_UISyncVectorCaptureHost_${suffix}(content: ` });
  }
  if (tabEdits.length > 0) {
    const fullPageRoot = discoveredViews
      .flatMap((view) => view.designNodes)
      .filter((node) => node.kind !== "TabView" && tabEdits.some((edit) =>
        node.startOffset <= edit.startOffset && node.endOffset >= edit.endOffset
      ))
      .sort((left, right) => (left.endOffset - left.startOffset) - (right.endOffset - right.startOffset))[0];
    if (fullPageRoot) {
      const primaryPageNames = discoverSwiftUiPrimaryTabPageViewNames(discoveredViews, options.pageViewNames ?? []);
      edits.push({
        offset: fullPageRoot.endOffset,
        value: primaryPageNames
          .map((sourceName) => `._uiSyncCaptureFullPage_${suffix}(sourceName: ${swiftString(sourceName)})`)
          .join("")
      });
    }
  }
  for (const view of discoveredViews.filter((candidate) => !options.renderFullTabPages && options.pageViewNames?.includes(candidate.name))) {
    const bodyRange = findNamedViewBodyRange(source, view.name);
    const rootNode = bodyRange && view.designNodes
      .filter((node) => node.startOffset >= bodyRange.startOffset && node.endOffset <= bodyRange.endOffset)
      .sort((left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset)[0];
    if (!rootNode) continue;
    const sourceSpan = sourceBytes.subarray(rootNode.startOffset, rootNode.endOffset).toString("utf8");
    if (/#(?:if|elseif|else|endif)\b/.test(sourceSpan)) continue;
    edits.push({
      offset: rootNode.endOffset,
      value: `._uiSyncCapturePage_${suffix}(sourceName: ${swiftString(view.name)})`
    });
  }
  for (const { view, node } of candidates) {
    if (view.isAppEntry) continue;
    if (!instrumentableSystemViews.has(node.kind) && !customViews.has(node.kind)) continue;
    if (explicitNodes.length === 0 && ambiguousResultBuilderKinds.has(node.kind)) continue;
    if (explicitNodes.length === 0 && !viewBuilderRanges.some((range) => node.startOffset >= range.startOffset && node.endOffset <= range.endOffset)) continue;
    if (tabEdits.some((edit) => node.startOffset >= edit.startOffset && node.endOffset <= edit.endOffset)) continue;
    const sourceSpan = sourceBytes.subarray(node.startOffset, node.endOffset).toString("utf8");
    if (/#(?:if|elseif|else|endif)\b/.test(sourceSpan)) continue;
    const explicitId = node.expression.match(/\.designNode\s*\(\s*"([A-Za-z][A-Za-z0-9_.:/-]{0,159})"/)?.[1];
    const numericArgument = (name) => node.expression.match(new RegExp(`\\b${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`))?.[1] ?? "nil";
    const stringArgument = (name) => {
      const value = node.expression.match(new RegExp(`\\b${name}\\s*:\\s*"([^"\\n]{1,160})"`))?.[1];
      return value ? swiftString(value) : "nil";
    };
    const sourceHint = explicitId ? stringArgument("source") : "nil";
    const textArgument = node.kind === "Text" ? runtimeTextArgument(node.expression) : null;
    const capturedText = textArgument ? `String(describing: (${textArgument}))` : "nil";
    const imageArgument = node.kind === "Image" ? runtimeImageArgument(node.expression) : null;
    const capturedAssetName = imageArgument ? `String(describing: (${imageArgument}))` : "nil";
    edits.push({
      offset: node.endOffset,
      value: `._uiSyncProbe_${suffix}(id: ${swiftString(explicitId || node.syncId)}, sourceFile: ${swiftString(relativeFile)}, sourceName: ${swiftString(view.name)}, kind: ${swiftString(node.kind)}, cornerRadius: ${numericArgument("cornerRadius")}, backgroundColor: ${stringArgument("backgroundColor")}, fontSize: ${numericArgument("fontSize")}, sourceHint: ${sourceHint === "nil" && explicitId ? swiftString(`${relativeFile}:${node.sourceRange.line}`) : sourceHint}, text: ${capturedText}, assetName: ${capturedAssetName})`
    });
  }
  if (edits.length === 0) return { source, nodeCount: 0, nativeEffects: [], nativeEffectIds: [] };
  let output = sourceBytes;
  for (const edit of edits.sort((left, right) => (right.offset ?? right.startOffset) - (left.offset ?? left.startOffset))) {
    const insertion = Buffer.from(edit.value, "utf8");
    const startOffset = edit.offset ?? edit.startOffset;
    const endOffset = edit.endOffset ?? startOffset;
    output = Buffer.concat([output.subarray(0, startOffset), insertion, output.subarray(endOffset)]);
  }
  return {
    source: `${output.toString("utf8")}${runtimeHelperSource(suffix, endpoint, vectorEndpoint, Boolean(appRoot), options.pageViewNames ?? [])}`,
    nodeCount: edits.length,
    nativeEffects: [...new Map(nativeEffectEdits.map((edit) => [edit.nativeEffect.id, edit.nativeEffect])).values()],
    nativeEffectIds: [...new Set(nativeEffectEdits.map((edit) => edit.nativeEffect.id))]
  };
}

function uiKitCaptureHelper(vectorEndpoint) {
  return `

#if DEBUG && canImport(UIKit)
private func _uiSyncScheduleUIKitPdfCapture() {
  Task { @MainActor in
    try? await Task.sleep(nanoseconds: 900_000_000)
    guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first,
          let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first else { return }
    func findTabs(_ controller: UIViewController?) -> UITabBarController? {
      guard let controller else { return nil }
      if let tabs = controller as? UITabBarController { return tabs }
      for child in controller.children { if let tabs = findTabs(child) { return tabs } }
      return controller.presentedViewController.flatMap(findTabs)
    }
    func opaqueRenderers(in view: UIView) -> [UIView] {
      let className = NSStringFromClass(type(of: view))
      if ["SCNView", "MTKView", "MKMapView", "WKWebView", "PDFView", "AVPlayerView"].contains(where: { className.hasSuffix($0) }) { return [view] }
      return view.subviews.flatMap { opaqueRenderers(in: $0) }
    }
    func containsOpaqueRenderer(_ view: UIView) -> Bool {
      !opaqueRenderers(in: view).isEmpty
    }
    func renderWindow(_ window: UIWindow, in context: CGContext) {
      let opaqueSnapshots = opaqueRenderers(in: window).compactMap { renderer -> (UIView, Float, CGRect, UIImage)? in
        let frame = renderer.convert(renderer.bounds, to: window)
        guard frame.width > 0, frame.height > 0 else { return nil }
        let image = UIGraphicsImageRenderer(bounds: renderer.bounds).image { _ in
          renderer.drawHierarchy(in: renderer.bounds, afterScreenUpdates: true)
        }
        return (renderer, renderer.layer.opacity, frame, image)
      }
      for (renderer, _, _, _) in opaqueSnapshots { renderer.layer.opacity = 0 }
      context.saveGState()
      context.translateBy(x: 0, y: window.bounds.height)
      context.scaleBy(x: 1, y: -1)
      window.layer.render(in: context)
      for (_, _, frame, image) in opaqueSnapshots {
        UIGraphicsPushContext(context)
        image.draw(in: frame)
        UIGraphicsPopContext()
      }
      context.restoreGState()
      for (renderer, opacity, _, _) in opaqueSnapshots { renderer.layer.opacity = opacity }
    }
    let tabs = findTabs(window.rootViewController)
    let originalTab = tabs?.selectedIndex ?? 0
    let indexes = tabs?.viewControllers?.indices.map { $0 } ?? [0]
    let pageNames = tabs?.tabBar.items?.enumerated().map { index, item in
      item.title?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false ? item.title! : "Page \(index + 1)"
    } ?? ["Page 1"]
    let data = NSMutableData()
    var mediaBox = window.bounds
    guard let consumer = CGDataConsumer(data: data as CFMutableData),
          let context = CGContext(consumer: consumer, mediaBox: &mediaBox, nil) else { return }
      var pageFallbacks: [Bool] = []
      for index in indexes {
        tabs?.selectedIndex = index
        try? await Task.sleep(nanoseconds: 900_000_000)
        tabs?.selectedViewController?.view.setNeedsLayout()
        tabs?.selectedViewController?.view.layoutIfNeeded()
        window.layoutIfNeeded()
        pageFallbacks.append(containsOpaqueRenderer(tabs?.selectedViewController?.view ?? window))
        context.beginPDFPage(nil)
        renderWindow(window, in: context)
        context.endPDFPage()
      }
    context.closePDF()
    tabs?.selectedIndex = originalTab
    guard let url = URL(string: ${swiftString(vectorEndpoint)}) else { return }
    var request = URLRequest(url: url)
    request.httpMethod = "POST"
    request.setValue("application/pdf", forHTTPHeaderField: "Content-Type")
    request.setValue("window-fallback", forHTTPHeaderField: "X-UI-Sync-Capture-Kind")
    if let encodedNames = try? JSONEncoder().encode(pageNames) {
      request.setValue(encodedNames.base64EncodedString(), forHTTPHeaderField: "X-UI-Sync-Page-Names")
    }
    if let encodedFallbacks = try? JSONEncoder().encode(pageFallbacks) {
      request.setValue(encodedFallbacks.base64EncodedString(), forHTTPHeaderField: "X-UI-Sync-Page-Fallbacks")
    }
    request.httpBody = data as Data
    URLSession.shared.dataTask(with: request).resume()
  }
}
#endif
`;
}

function instrumentUIKitSource(source, vectorEndpoint) {
  const signatures = [
    /func\s+applicationDidBecomeActive\s*\([^)]*\)\s*\{/m,
    /func\s+application\s*\([\s\S]{0,500}?didFinishLaunchingWithOptions[\s\S]{0,500}?\)\s*->\s*Bool\s*\{/m,
    /func\s+scene\s*\([\s\S]{0,500}?willConnectTo[\s\S]{0,500}?\)\s*\{/m
  ];
  const match = signatures.map((signature) => signature.exec(source)).find(Boolean);
  if (!match) return { source, nodeCount: 0 };
  const offset = match.index + match[0].length;
  return {
    source: `${source.slice(0, offset)}\n    _uiSyncScheduleUIKitPdfCapture()\n${source.slice(offset)}${uiKitCaptureHelper(vectorEndpoint)}`,
    nodeCount: 1
  };
}

function mergeRuntimeIntoNode(node, captures, origin) {
  const runtimeNodes = node.syncId ? captures.get(node.syncId) : null;
  const runtime = runtimeNodes?.[0] ?? null;
  const children = node.children?.map((child) => mergeRuntimeIntoNode(child, captures, origin));
  if (!runtime) return { ...node, ...(children ? { children } : {}) };
  const relativeFrame = {
    x: Math.round((runtime.frame.x - origin.x) * 100) / 100,
    y: Math.round((runtime.frame.y - origin.y) * 100) / 100,
    width: Math.round(runtime.frame.width * 100) / 100,
    height: Math.round(runtime.frame.height * 100) / 100
  };
  const runtimeInstances = runtimeNodes.map((instance) => ({
    instanceId: instance.instanceId || "single",
    x: Math.round((instance.frame.x - origin.x) * 100) / 100,
    y: Math.round((instance.frame.y - origin.y) * 100) / 100,
    width: Math.round(instance.frame.width * 100) / 100,
    height: Math.round(instance.frame.height * 100) / 100
  }));
  return {
    ...node,
    runtimeFrame: relativeFrame,
    ...(runtimeInstances.length > 1 ? { runtimeInstances } : {}),
    runtimeStatus: "captured",
    ...(runtime.text ? { text: runtime.text, runtimeTextCaptured: true } : {}),
    ...(runtime.assetName ? { assetName: runtime.assetName, runtimeAssetCaptured: true } : {}),
    ...(runtime.cornerRadius != null ? { cornerRadius: runtime.cornerRadius } : {}),
    ...(runtime.backgroundColor ? { backgroundColorToken: runtime.backgroundColor } : {}),
    ...(runtime.fontSize != null ? { fontSize: runtime.fontSize } : {}),
    ...(children ? { children } : {})
  };
}

function mergeRuntimeSnapshot(screens, snapshot) {
  const safeSnapshot = runtimeSnapshotSchema.parse(snapshot);
  const captures = new Map();
  for (const node of safeSnapshot.nodes) {
    if (!captures.has(node.syncId)) captures.set(node.syncId, []);
    captures.get(node.syncId).push(node);
  }
  for (const nodes of captures.values()) {
    nodes.sort((left, right) => left.frame.y - right.frame.y || left.frame.x - right.frame.x);
  }
  let matchedNodeCount = 0;
  const mergedScreens = screens.map((screen) => {
    const allNodes = [];
    const visit = (node) => {
      allNodes.push(node);
      for (const child of node.children || []) visit(child);
    };
    visit(screen.uiTree);
    const matched = allNodes.filter((node) => node.syncId && captures.has(node.syncId));
    matchedNodeCount += matched.length;
    const rootCapture = captures.get(screen.uiTree.syncId)?.[0] || (matched[0]?.syncId ? captures.get(matched[0].syncId)?.[0] : null);
    const origin = safeSnapshot.environment?.viewport || rootCapture?.frame || { x: 0, y: 0 };
    const mergedTree = mergeRuntimeIntoNode(screen.uiTree, captures, origin);
    return {
      ...screen,
      runtimeCapture: {
        state: matched.length > 0 ? "captured" : "static-fallback",
        capturedNodeCount: matched.length,
        totalNodeCount: allNodes.length,
        capturedAt: safeSnapshot.capturedAt
      },
      uiTree: safeSnapshot.environment && matched.length > 0
        ? { ...mergedTree, runtimeEnvironment: safeSnapshot.environment }
        : mergedTree
    };
  });
  const visualReferenceScreen = mergedScreens
    .filter((screen) => screen.runtimeCapture.state === "captured")
    .sort((left, right) => right.runtimeCapture.capturedNodeCount - left.runtimeCapture.capturedNodeCount)[0];
  const finalizedScreens = mergedScreens.map((screen) => screen.id === visualReferenceScreen?.id
    ? { ...screen, runtimeCapture: { ...screen.runtimeCapture, isVisualReference: true } }
    : screen);
  return {
    screens: finalizedScreens,
    coverage: {
      capturedNodeCount: matchedNodeCount,
      runtimeNodeCount: safeSnapshot.nodes.length,
      screenCount: finalizedScreens.filter((screen) => screen.runtimeCapture.state === "captured").length
    }
  };
}

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) return resolve(stdout);
      const output = `${stdout}\n${stderr}`.trim() || `${command} failed`;
      const diagnostics = extractBuildDiagnostics(output);
      const tail = output.slice(-8000);
      reject(new Error(`${diagnostics.length > 0 ? `${diagnostics.join("\n")}\n\n` : ""}${tail}`.slice(-14000)));
    });
  });
}

function extractBuildDiagnostics(output) {
  const lines = String(output || "").split(/\r?\n/);
  const diagnostics = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!/(?:^|:\d+:\d+: )error: /.test(lines[index])) continue;
    diagnostics.push(lines[index].trim());
    for (let offset = 1; offset <= 2; offset += 1) {
      const context = lines[index + offset]?.trim();
      if (context && !/\/Toolchains\/[^/]+\.xctoolchain\//.test(context)) diagnostics.push(context);
    }
    if (diagnostics.length >= 12) break;
  }
  return [...new Set(diagnostics)];
}

async function runSimulatorBuild(xcodebuild, arguments_, options) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await run(xcodebuild, arguments_, options);
    } catch (error) {
      lastError = error;
      const destinationCacheRace = /Unable to find a destination|Found no destinations|Could not configure request/i.test(error.message);
      if (!destinationCacheRace || attempt === 2) throw error;
      // Xcode 26 can briefly expose only its 26.5 SDK placeholder while it
      // registers an already-installed 26.4.x CoreSimulator runtime. A second
      // build resolves the same fresh project without installing another SDK.
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw lastError;
}

async function findXcodeProject(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const project = entries.find((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"));
  if (!project) throw new Error("Design Build needs an .xcodeproj at the project root");
  return path.join(root, project.name);
}

async function newestInstalledIPhone(simctl, { preferTablet = false, preferredUdid = null } = {}) {
  const runtimePayload = JSON.parse(await run(simctl, ["list", "runtimes", "available", "--json"]));
  const installedIosRuntimes = (runtimePayload.runtimes || []).filter((runtime) =>
    runtime.isAvailable !== false && /iOS/i.test(`${runtime.name || ""} ${runtime.identifier || ""}`)
  ).sort((left, right) => String(right.version || "").localeCompare(String(left.version || ""), undefined, { numeric: true }));
  if (installedIosRuntimes.length === 0) {
    throw new Error(
      "No iOS Simulator Runtime is installed. In Xcode > Settings > Components, install the newest iOS runtime offered (26.4.1 is compatible; it does not need to match the 26.5 SDK)."
    );
  }
  const payload = JSON.parse(await run(simctl, ["list", "devices", "available", "--json"]));
  const runtimeIds = new Set(installedIosRuntimes.map((runtime) => runtime.identifier));
  const devices = Object.entries(payload.devices || {})
    .filter(([runtimeId]) => runtimeIds.has(runtimeId))
    .flatMap(([runtimeId, runtimeDevices]) => runtimeDevices.map((device) => ({ ...device, runtimeId })))
    .filter((device) => device.isAvailable && /iPhone|iPad/.test(device.name));
  const preferred = devices.filter((device) => preferTablet ? /iPad/.test(device.name) : /iPhone/.test(device.name));
  // A project stays on the device it was captured on, so its pages keep one
  // viewport even after a newer runtime or device type is installed.
  const pinned = preferredUdid ? devices.find((device) => device.udid === preferredUdid) : null;
  if (pinned) return pinned;
  const dedicatedName = preferTablet ? "UI Sync iPad" : "UI Sync iPhone";
  const existing = preferred.find((device) => device.name === dedicatedName);
  if (existing) return existing;

  const deviceTypesPayload = JSON.parse(await run(simctl, ["list", "devicetypes", "--json"]));
  const deviceTypes = (deviceTypesPayload.devicetypes || []).filter((deviceType) =>
    preferTablet ? /iPad/.test(deviceType.name) : /iPhone/.test(deviceType.name)
  );
  const deviceType = deviceTypes.find((candidate) => preferTablet ? /iPad Pro.*13-inch/i.test(candidate.name) : /iPhone 17 Pro/i.test(candidate.name)) || deviceTypes[0];
  if (!deviceType) throw new Error("The installed iOS Runtime has no compatible iPhone or iPad device type");
  const runtime = installedIosRuntimes[0];
  const udid = (await run(simctl, ["create", dedicatedName, deviceType.identifier, runtime.identifier])).trim();
  if (!udid) throw new Error("CoreSimulator did not create the dedicated UI Sync device");
  return { udid, name: dedicatedName, state: "Shutdown", isAvailable: true, runtimeId: runtime.identifier };
}

function appleDesignKitForRuntime(runtimeId) {
  const match = String(runtimeId || "").match(/(?:^|\.)iOS-(\d+)(?:-(\d+))?/i);
  const majorVersion = Number(match?.[1]);
  if (!Number.isInteger(majorVersion) || majorVersion < 1) return null;
  return {
    designKit: `iOS ${majorVersion}`,
    appearance: majorVersion >= 26 ? "liquid-glass" : "classic"
  };
}

async function bootSimulator(simctl, selected) {
  if (selected.state !== "Booted") {
    await run(simctl, ["boot", selected.udid]).catch((error) => {
      if (!/current state: Booted|Unable to boot device in current state/.test(error.message)) throw error;
    });
    await run(simctl, ["bootstatus", selected.udid, "-b"]);
  }
}

const COPY_EXCLUSIONS = [".build", ".git", "Build", "DerivedData", "Pods", "Carthage", "node_modules"];

// rsync mirrors the project into the reused workspace: only changed files are
// copied, files deleted from the project are removed, and the previous run's
// instrumented sources are restored to their originals before this run
// instruments them again.
async function copyProject(root, destination) {
  await mkdir(destination, { recursive: true });
  try {
    await run("/usr/bin/rsync", [
      "-a",
      "--delete",
      ...COPY_EXCLUSIONS.flatMap((name) => ["--exclude", `/${name}`, "--exclude", name]),
      `${root.replace(/\/$/, "")}/`,
      `${destination}/`
    ]);
    return;
  } catch {
    // Fall through to a plain recursive copy when rsync is unavailable.
  }
  await cp(root, destination, {
    recursive: true,
    force: true,
    filter: (source) => !COPY_EXCLUSIONS.includes(path.basename(source))
  });
}

async function writeVectorPdf(target, contents) {
  await writeFile(target, contents);
  return target;
}

async function runSwiftUiDesignBuild({ root, cacheDirectory, runtimeServer, simulatorPreference = {} }) {
  const xcode = await requireXcodePaths("Install the full Xcode app before exporting an iOS project");
  const xcodeDeveloper = xcode.developerDirectory;
  const xcodebuild = xcode.xcodebuild;
  const simctl = xcode.simctl;
  const files = await collectFiles(root, (target) => target.endsWith(".swift"));
  const scanDiagnostics = [];
  const discovered = await scanWithSwiftSyntax(root, files, path.join(cacheDirectory, "tools"), {
    onDiagnostic: (diagnostic) => scanDiagnostics.push(diagnostic)
  });
  // A scanner that is present and then fails would quietly downgrade every
  // later step to the regular-expression scan.
  const scanFailure = scanDiagnostics.find((diagnostic) => diagnostic.reason !== "unavailable");
  if (scanFailure) throw new Error(scanFailure.message);
  const usesSwiftUi = Boolean(discovered?.some((view) => view.isAppEntry || view.designNodes.length > 0));
  const swiftPages = discoverSwiftUiPages(discovered || []);
  const pageViewNames = swiftPages.map((page) => page.sourceName);
  const primaryTabPages = swiftPages.filter((page) => page.systemImage);
  let appleDesignKit = null;
  const systemTabBarFor = (sourceName) => {
    const selectedIndex = primaryTabPages.findIndex((page) => page.sourceName === sourceName);
    return selectedIndex >= 0 && primaryTabPages.length >= 2
      ? {
        ...(appleDesignKit ?? {}),
        selectedIndex,
        items: primaryTabPages.map((page) => ({
          title: page.pageName,
          systemImage: page.systemImage,
          sourceName: page.sourceName
        }))
      }
      : null;
  };
  const session = runtimeServer.beginSession(root);
  return (async () => {
  // One workspace per project, reused across runs, with Xcode's DerivedData
  // inside it. A second export is then an incremental build rather than a full
  // rebuild of a freshly copied project — and the copies stop accumulating.
  const workspaceRoot = path.join(
    cacheDirectory || os.tmpdir(),
    "workspaces",
    createHash("sha256").update(root).digest("hex").slice(0, 24)
  );
  await mkdir(workspaceRoot, { recursive: true });
  const copiedRoot = path.join(workspaceRoot, path.basename(root));
  await copyProject(root, copiedRoot);
  const byFile = new Map();
  for (const view of discovered || []) {
    if (!byFile.has(view.relativeFile)) byFile.set(view.relativeFile, []);
    byFile.get(view.relativeFile).push(view);
  }
  let instrumentedNodeCount = 0;
  const nativeEffectIds = new Set();
  const nativeEffects = new Map();
  for (const [relativeFile, views] of byFile) {
    const original = await readFile(path.join(root, relativeFile), "utf8");
    const instrumented = instrumentSwiftSource(original, relativeFile, views, session.endpoint, session.vectorEndpoint, {
      pageViewNames,
      renderFullTabPages: swiftPages.length > 1,
      navigationRoutes: swiftPages.filter((page) => page.navigationRoute)
    });
    if (instrumented.nodeCount === 0) continue;
    await writeFile(path.join(copiedRoot, relativeFile), instrumented.source);
    instrumentedNodeCount += instrumented.nodeCount;
    for (const effectId of instrumented.nativeEffectIds ?? []) nativeEffectIds.add(effectId);
    for (const effect of instrumented.nativeEffects ?? []) nativeEffects.set(effect.id, effect);
  }
  if (!usesSwiftUi) {
    for (const file of files) {
      const original = await readFile(file, "utf8");
      if (!/\bimport\s+UIKit\b/.test(original)) continue;
      const instrumented = instrumentUIKitSource(original, session.vectorEndpoint);
      if (instrumented.nodeCount === 0) continue;
      await writeFile(path.join(copiedRoot, path.relative(root, file)), instrumented.source);
      instrumentedNodeCount += instrumented.nodeCount;
      break;
    }
  }
  if (instrumentedNodeCount === 0) throw new Error("No runtime-instrumentable SwiftUI nodes were found");

  const projectPath = await findXcodeProject(copiedRoot);
  const projectRelative = path.relative(copiedRoot, projectPath);
  const list = JSON.parse(await run(xcodebuild, ["-project", projectPath, "-list", "-json"], { env: { ...process.env, DEVELOPER_DIR: xcodeDeveloper } }));
  const schemes = list.project?.schemes || [];
  const scheme = schemes.find((name) => !/(Tests|UITests)$/i.test(name));
  if (!scheme) throw new Error("No runnable application scheme was found");
  const environment = { ...process.env, DEVELOPER_DIR: xcodeDeveloper };
  const copiedProjectPath = path.join(copiedRoot, projectRelative);
  const simulator = await newestInstalledIPhone(simctl, simulatorPreference);
  appleDesignKit = appleDesignKitForRuntime(simulator.runtimeId);
  const derivedData = path.join(workspaceRoot, "DerivedData");
  // Xcode may reject a slightly older installed runtime as a destination
  // (for example SDK 26.5 with Runtime 26.4.1). Selecting the simulator SDK
  // directly builds the same deployment-compatible app without that check.
  const baseArguments = [
    "-project", copiedProjectPath,
    "-scheme", scheme,
    "-configuration", "Debug",
    "-sdk", "iphonesimulator",
    "-destination", "generic/platform=iOS Simulator",
    "-derivedDataPath", derivedData
  ];
  await runSimulatorBuild(xcodebuild, [
    ...baseArguments,
    "CODE_SIGNING_ALLOWED=NO",
    "INFOPLIST_KEY_NSAppTransportSecurity_NSAllowsLocalNetworking=YES",
    "SWIFT_ACTIVE_COMPILATION_CONDITIONS=DEBUG UI_SYNC_DESIGN",
    "build"
  ], { env: environment });
  await bootSimulator(simctl, simulator);
  const productsDirectory = path.join(derivedData, "Build", "Products", "Debug-iphonesimulator");
  const productEntries = await readdir(productsDirectory, { withFileTypes: true });
  const appEntry = productEntries.find((entry) => entry.isDirectory() && entry.name.endsWith(".app") && !/(Tests|UITests)\.app$/i.test(entry.name));
  if (!appEntry) throw new Error("Design Build succeeded, but its Simulator app product could not be found");
  const appPath = path.join(productsDirectory, appEntry.name);
  const bundleIdentifier = (await run("/usr/bin/plutil", ["-extract", "CFBundleIdentifier", "raw", "-o", "-", path.join(appPath, "Info.plist")])).trim();
  if (!bundleIdentifier) throw new Error("Design Build app has no bundle identifier");
  await run(simctl, ["install", simulator.udid, appPath]);
  await Promise.all([
    run(simctl, ["status_bar", simulator.udid, "override", "--time", "9:41", "--batteryState", "charged", "--batteryLevel", "100"]).catch(() => ""),
    run(simctl, ["ui", simulator.udid, "appearance", "light"]).catch(() => ""),
    run(simctl, ["ui", simulator.udid, "content_size", "large"]).catch(() => ""),
    run(simctl, ["privacy", simulator.udid, "grant", "all", bundleIdentifier]).catch(() => "")
  ]);
  const launchPages = usesSwiftUi && swiftPages.length > 0 ? swiftPages : [null];
  for (let pageIndex = 0; pageIndex < launchPages.length; pageIndex += 1) {
    const page = launchPages[pageIndex];
    const launchArguments = [
      "launch", "--terminate-running-process", simulator.udid, bundleIdentifier, "--args",
      "-designMode", "YES", "-mockData", "fixture-v1"
    ];
    if (page) launchArguments.push(
      "-uiSyncPageIndex", String(pageIndex),
      "-uiSyncPageSourceName", page.sourceName,
      "-uiSyncPageName", page.pageName
    );
    await run(simctl, launchArguments, {
      env: {
        ...environment,
        ...(page ? {
          SIMCTL_CHILD_UI_SYNC_PAGE_INDEX: String(pageIndex),
          SIMCTL_CHILD_UI_SYNC_PAGE_SOURCE_NAME: page.sourceName
        } : {})
      }
    });
    if (page && runtimeServer.waitForVectorSource) {
      await runtimeServer.waitForVectorSource(session.token, {
        sourceName: page.sourceName,
        captureKind: "window-fallback",
        timeoutMs: 6_000
      });
      await runtimeServer.waitForVectorSource(session.token, {
        sourceName: page.sourceName,
        captureKind: "window-fallback-clean",
        timeoutMs: 2_000
      });
    }
  }
  let snapshot = await runtimeServer.waitForCapture(session.token, { timeoutMs: usesSwiftUi ? 12_000 : 1_500 });
  if (usesSwiftUi && snapshot.nodes.length === 0) throw new Error("The app launched, but no SwiftUI runtime nodes were captured");
  const screenshotDirectory = path.join(cacheDirectory || os.tmpdir(), "screenshots");
  await mkdir(screenshotDirectory, { recursive: true });
  const screenshotPath = path.join(screenshotDirectory, `${createHash("sha256").update(root).digest("hex").slice(0, 24)}.png`);
  const appScreenshot = await runtimeServer.waitForScreenshot(session.token);
  if (appScreenshot) await writeFile(screenshotPath, appScreenshot);
  else await run(simctl, ["io", simulator.udid, "screenshot", "--type=png", screenshotPath]);
  const vectorPdfs = runtimeServer.waitForVectors
    ? await runtimeServer.waitForVectors(session.token)
    : [await runtimeServer.waitForVector(session.token)].filter(Boolean);
  if (usesSwiftUi && typeof runtimeServer.snapshot === "function") {
    snapshot = runtimeServer.snapshot(session.token);
  }
  let pdfDocument = null;
  let vectorMessage = null;
  if (vectorPdfs.length > 0) {
    const vectorDirectory = path.join(cacheDirectory || os.tmpdir(), "vectors");
    await mkdir(vectorDirectory, { recursive: true });
    const vectorStem = createHash("sha256").update(root).digest("hex").slice(0, 24);
    const windowPdfs = [...vectorPdfs]
      .filter((candidate) => candidate.captureKind === "window-fallback" || (!candidate.captureKind && candidate.pageNames?.length))
      .sort((left, right) => (left.receivedAt || 0) - (right.receivedAt || 0));
    const cleanWindowPdfs = [...vectorPdfs]
      .filter((candidate) => candidate.captureKind === "window-fallback-clean")
      .sort((left, right) => (left.receivedAt || 0) - (right.receivedAt || 0));
    const windowPdf = [...windowPdfs].sort((left, right) => right.length - left.length)[0] ?? null;
    const pagePdfs = [...vectorPdfs]
      .filter((candidate) => candidate.captureKind === "image-renderer-page" && candidate.sourceName)
      .sort((left, right) => (left.receivedAt || 0) - (right.receivedAt || 0));
    const cleanPagePdfs = [...vectorPdfs]
      .filter((candidate) => candidate.captureKind === "image-renderer-page-clean" && candidate.sourceName)
      .sort((left, right) => (left.receivedAt || 0) - (right.receivedAt || 0));
    const rootPdfs = [...vectorPdfs]
      .filter((candidate) => candidate.captureKind === "image-renderer-root")
      .sort((left, right) => (left.receivedAt || 0) - (right.receivedAt || 0));
    const cleanRootPdfs = [...vectorPdfs]
      .filter((candidate) => candidate.captureKind === "image-renderer-root-clean")
      .sort((left, right) => (left.receivedAt || 0) - (right.receivedAt || 0));
    const rootPdf = [...rootPdfs].sort((left, right) => right.length - left.length)[0] ?? null;
    const legacyPdf = [...vectorPdfs].sort((left, right) => right.length - left.length)[0];
    const primaryPdf = windowPdf ?? pagePdfs[0] ?? rootPdf ?? legacyPdf;
    const pdfPath = path.join(vectorDirectory, `${vectorStem}.pdf`);
    await writeFile(pdfPath, primaryPdf);
    try {
      let pages = [];
      const largestCaptureBySourceName = (candidates) => candidates.reduce((result, candidate) => {
        if (!candidate.sourceName) return result;
        const previous = result.get(candidate.sourceName);
        if (!previous || candidate.length > previous.length) result.set(candidate.sourceName, candidate);
        return result;
      }, new Map());
      const rendererBySourceName = largestCaptureBySourceName([...rootPdfs, ...pagePdfs]);
      const cleanRendererBySourceName = largestCaptureBySourceName([...cleanRootPdfs, ...cleanPagePdfs]);
      const windowBySourceName = new Map(windowPdfs
        .map((candidate) => [candidate.pageSourceNames?.[0] ?? candidate.sourceName, candidate])
        .filter(([sourceName]) => sourceName));
      const cleanWindowBySourceName = new Map(cleanWindowPdfs
        .map((candidate) => [candidate.pageSourceNames?.[0] ?? candidate.sourceName, candidate])
        .filter(([sourceName]) => sourceName));
      const hasFullPageCaptures = swiftPages.length > 1 && swiftPages.every((page) =>
        rendererBySourceName.has(page.sourceName) || windowBySourceName.has(page.sourceName)
      );
      if (hasFullPageCaptures) {
        pages = [];
        for (let index = 0; index < swiftPages.length; index += 1) {
          const pageDefinition = swiftPages[index];
          const rendererPdf = rendererBySourceName.get(pageDefinition.sourceName) ?? null;
          const fallbackPdf = windowBySourceName.get(pageDefinition.sourceName) ?? null;
          // The instrumented renderer flattens only the active TabView branch
          // and composites the native Tab Bar afterward, preserving editable
          // text and shapes. Keep window capture for genuinely opaque UIKit,
          // Metal, media, map, or web content only.
          const requiresFallback = pageDefinition.preferWindowCapture === true || !rendererPdf || fallbackPdf?.pageFallbacks?.[0] === true;
          let selectedPdf = requiresFallback ? fallbackPdf : rendererPdf ?? fallbackPdf;
          let renderSource = selectedPdf === rendererPdf ? "image-renderer" : "window-fallback";
          if (!selectedPdf) continue;
          let pagePdfPath = path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-${renderSource}.pdf`);
          await writeFile(pagePdfPath, selectedPdf);
          if (renderSource === "image-renderer") {
            try {
              const validationPath = path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-image-renderer-validation.svg`);
              await convertPdfToFigmaSvg(
                pagePdfPath,
                validationPath,
                { stripTextGlyphs: false, maximumByteLength: 32_000_000 }
              );
              if (isSwiftUiUnsupportedRendererSvg(await readFile(validationPath, "utf8"))) {
                throw new Error(`ImageRenderer does not support ${pageDefinition.pageName}`);
              }
            } catch {
              if (!fallbackPdf) throw new Error(`ImageRenderer could not export ${pageDefinition.pageName}`);
              selectedPdf = fallbackPdf;
              renderSource = "window-fallback";
              pagePdfPath = path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-${renderSource}.pdf`);
              await writeFile(pagePdfPath, selectedPdf);
            }
          }
          const [page] = await indexPdfPages(
            pagePdfPath,
            path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-pages`),
            { pageNames: [pageDefinition.pageName] }
          );
          if (page) pages.push({
            ...page,
            id: `pdf-page-${index + 1}`,
            pageNumber: index + 1,
            pdfPath: pagePdfPath,
            pdfPageNumber: 1,
            renderSource,
            ...(renderSource === "image-renderer" && cleanRendererBySourceName.has(pageDefinition.sourceName)
              ? { cleanPdfPath: await writeVectorPdf(
                path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-image-renderer-clean.pdf`),
                cleanRendererBySourceName.get(pageDefinition.sourceName)
              ) }
              : {}),
            ...(renderSource === "window-fallback" && cleanWindowBySourceName.has(pageDefinition.sourceName)
              ? { textCleanPdfPath: await writeVectorPdf(
                path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-window-text-clean.pdf`),
                cleanWindowBySourceName.get(pageDefinition.sourceName)
              ) }
              : {}),
            sourceName: pageDefinition.sourceName,
            ...(systemTabBarFor(pageDefinition.sourceName) ? { systemTabBar: systemTabBarFor(pageDefinition.sourceName) } : {}),
            nativeEffects: [...nativeEffects.values()],
            nativeEffectIds: [...nativeEffectIds]
          });
        }
      } else if (windowPdf) {
        const fallbackPages = await indexPdfPages(pdfPath, path.join(vectorDirectory, `${vectorStem}-pages`), {
          pageNames: windowPdf.pageNames
        });
        const rendererBySourceName = largestCaptureBySourceName(pagePdfs);
        const cleanRendererBySourceName = largestCaptureBySourceName(cleanPagePdfs);
        pages = await Promise.all(fallbackPages.map(async (fallbackPage, index) => {
          const sourceName = windowPdf.pageSourceNames?.[index];
          const rendererPdf = sourceName ? rendererBySourceName.get(sourceName) : pagePdfs[index];
          const requiresFallback = windowPdf.pageFallbacks?.[index] === true;
          if (!rendererPdf || requiresFallback) {
            const textCleanPdf = sourceName ? cleanWindowBySourceName.get(sourceName) : cleanWindowPdfs[index];
            return {
              ...fallbackPage,
              pdfPath,
              pdfPageNumber: fallbackPage.pageNumber,
              renderSource: "window-fallback",
              ...(textCleanPdf ? { textCleanPdfPath: await writeVectorPdf(
                path.join(vectorDirectory, `${vectorStem}-${fallbackPage.id}-window-text-clean.pdf`),
                textCleanPdf
              ) } : {}),
              ...(sourceName ? { sourceName } : {}),
              ...(systemTabBarFor(sourceName) ? { systemTabBar: systemTabBarFor(sourceName) } : {}),
              nativeEffects: [...nativeEffects.values()],
              nativeEffectIds: [...nativeEffectIds]
            };
          }
          const pagePdfPath = path.join(vectorDirectory, `${vectorStem}-${fallbackPage.id}-image-renderer.pdf`);
          await writeFile(pagePdfPath, rendererPdf);
          try {
            const validationPath = path.join(vectorDirectory, `${vectorStem}-${fallbackPage.id}-image-renderer-validation.svg`);
            await convertPdfToFigmaSvg(
              pagePdfPath,
              validationPath,
              { stripTextGlyphs: false, maximumByteLength: 32_000_000 }
            );
            if (isSwiftUiUnsupportedRendererSvg(await readFile(validationPath, "utf8"))) {
              throw new Error(`ImageRenderer does not support ${fallbackPage.name}`);
            }
            const [preferred] = await indexPdfPages(
              pagePdfPath,
              path.join(vectorDirectory, `${vectorStem}-${fallbackPage.id}-image-renderer-pages`),
              { pageNames: [fallbackPage.name] }
            );
            if (!preferred) throw new Error("The ImageRenderer PDF produced no page");
            return {
              ...preferred,
              id: fallbackPage.id,
              pageNumber: fallbackPage.pageNumber,
              name: fallbackPage.name,
              pdfPath: pagePdfPath,
              pdfPageNumber: 1,
              renderSource: "image-renderer",
              ...(sourceName && cleanRendererBySourceName.has(sourceName)
                ? { cleanPdfPath: await writeVectorPdf(
                  path.join(vectorDirectory, `${vectorStem}-${fallbackPage.id}-image-renderer-clean.pdf`),
                  cleanRendererBySourceName.get(sourceName)
                ) }
                : {}),
              ...(sourceName ? { sourceName } : {}),
              ...(systemTabBarFor(sourceName) ? { systemTabBar: systemTabBarFor(sourceName) } : {}),
              nativeEffects: [...nativeEffects.values()],
              nativeEffectIds: [...nativeEffectIds]
            };
          } catch {
            const textCleanPdf = sourceName ? cleanWindowBySourceName.get(sourceName) : cleanWindowPdfs[index];
            return {
              ...fallbackPage,
              pdfPath,
              pdfPageNumber: fallbackPage.pageNumber,
              renderSource: "window-fallback",
              ...(textCleanPdf ? { textCleanPdfPath: await writeVectorPdf(
                path.join(vectorDirectory, `${vectorStem}-${fallbackPage.id}-window-text-clean.pdf`),
                textCleanPdf
              ) } : {}),
              ...(sourceName ? { sourceName } : {}),
              ...(systemTabBarFor(sourceName) ? { systemTabBar: systemTabBarFor(sourceName) } : {})
            };
          }
        }));
      } else {
        const preferredPdfs = pagePdfs.length > 0 ? pagePdfs : [rootPdf ?? legacyPdf];
        pages = [];
        for (let index = 0; index < preferredPdfs.length; index += 1) {
          const candidate = preferredPdfs[index];
          const cleanCandidate = candidate.sourceName
            ? cleanRendererBySourceName.get(candidate.sourceName)
            : cleanPagePdfs[index] ?? cleanRootPdfs[index] ?? null;
          const pagePdfPath = index === 0 ? pdfPath : path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-image-renderer.pdf`);
          if (index > 0) await writeFile(pagePdfPath, candidate);
          const [page] = await indexPdfPages(pagePdfPath, path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-pages`));
          if (page) pages.push({
            ...page,
            id: `pdf-page-${index + 1}`,
            pageNumber: index + 1,
            pdfPath: pagePdfPath,
            pdfPageNumber: 1,
            renderSource: candidate.captureKind === "image-renderer-page" || candidate.captureKind === "image-renderer-root"
              ? "image-renderer"
              : "window-fallback",
            ...(cleanCandidate ? { cleanPdfPath: await writeVectorPdf(
              path.join(vectorDirectory, `${vectorStem}-pdf-page-${index + 1}-image-renderer-clean.pdf`),
              cleanCandidate
            ) } : {}),
            ...(candidate.pageFrame ? { contentFrame: candidate.pageFrame } : {}),
            ...(candidate.sourceName ? { sourceName: candidate.sourceName } : {}),
            ...(systemTabBarFor(candidate.sourceName) ? { systemTabBar: systemTabBarFor(candidate.sourceName) } : {}),
            nativeEffects: [...nativeEffects.values()],
            nativeEffectIds: [...nativeEffectIds]
          });
        }
      }
      pdfDocument = {
        path: pdfPath,
        capturedAt: new Date().toISOString(),
        viewport: snapshot.environment?.viewport || { x: 0, y: 0, width: 393, height: 852 },
        pages
      };
    } catch (error) {
      vectorMessage = error instanceof Error ? error.message : "PDF page indexing failed";
    }
  } else {
    vectorMessage = "The app ran, but no iOS window produced a PDF capture.";
  }
  if (!usesSwiftUi && pdfDocument) {
    const firstPage = pdfDocument.pages[0];
    const environment = {
      viewport: { x: 0, y: 0, width: firstPage.width, height: firstPage.height },
      displayScale: 1,
      colorScheme: "light",
      dynamicTypeSize: "large",
      layoutDirection: "leftToRight"
    };
    snapshot = runtimeSnapshotSchema.parse({
      version: 2,
      capturedAt: pdfDocument.capturedAt,
      environment,
      nodes: [{ syncId: "uikit/root", sourceFile: "UIKit runtime", sourceName: "Application", kind: "UIViewController", frame: environment.viewport }]
    });
    pdfDocument.viewport = environment.viewport;
  }
  const capturedAt = new Date().toISOString();
  return {
    warnings: scanDiagnostics.map((diagnostic) => diagnostic.message),
    simulator: { udid: simulator.udid, name: simulator.name, runtimeId: simulator.runtimeId ?? null },
    snapshot: { ...snapshot, deviceName: simulator.name, scheme },
    screenshot: {
      path: screenshotPath,
      capturedAt,
      viewport: snapshot.environment?.viewport || { x: 0, y: 0, width: 393, height: 852 },
      displayScale: snapshot.environment?.displayScale || 1
    },
    pdfDocument,
    vectorMessage,
    instrumentedNodeCount,
    workspaceRoot
  };
  })().finally(() => runtimeServer.endSession(session.token));
}

module.exports = {
  DEFAULT_RUNTIME_PORT,
  appleDesignKitForRuntime,
  createSwiftUiRuntimeServer,
  discoverSwiftUiPages,
  discoverSwiftUiPageViewNames,
  extractBuildDiagnostics,
  findNamedViewBodyRange,
  findInstrumentableViewBuilderRanges,
  instrumentSwiftSource,
  instrumentUIKitSource,
  mergeRuntimeSnapshot,
  runSwiftUiDesignBuild,
  runtimeNodeSchema,
  runtimeEnvironmentSchema,
  runtimeSnapshotSchema
};
