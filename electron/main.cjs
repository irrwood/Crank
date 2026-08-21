const { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, protocol, shell } = require("electron");
const { readFile, writeFile, access, mkdir, readdir, stat } = require("node:fs/promises");
const { createHash, randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const path = require("node:path");
const { z } = require("zod");
const { collectFiles, createJavascriptScreen, discoverJavascriptProjectRoots, discoverSwiftUiProjectRoots, omitWorkspaceContainers, scanJavascriptProject, scanSwiftUiProject } = require("./project-scanner.cjs");
const { exploreFromPage, exploreInApp, listTargets, looksLikeAppBundle, normalizeTargetUrl, recaptureInApp, recapturePage, scanAttached, scanFolder, scanSelf, scanUrl, withProjectServer } = require("./page-inventory.cjs");
const { readAppIcon } = require("./app-bundle.cjs");
const { shippedPath } = require("./packaged-path.cjs");
const { renderHandoffPage } = require("./handoff-page.cjs");
const { holdServer } = require("./held-server.cjs");
const { createRecordingSession } = require("./recording-session.cjs");
const { buildFigmaJob, projectIdFor } = require("./figma-export.cjs");
const { createInventoryRegistry, nameFor, targetId } = require("./inventory-registry.cjs");
const { identityOf } = require("./state-discovery.cjs");
const { internalise, mimeFor } = require("./asset-store.cjs");
const { carryUserData } = require("./user-data-migration.cjs");
const { parseFigmaDesignUrl } = require("./figma-link.cjs");
const { DEFAULT_PORT: FIGMA_BRIDGE_PORT, createFigmaBridge } = require("./figma-bridge.cjs");
const { applyPatchPlan, buildPullPreview, buildSwiftCodeScreens, createPatchPlan, createSwiftPatchPlan, flattenEditableDom } = require("./local-pull.cjs");
const { createSwiftUiRuntimeServer, mergeRuntimeSnapshot, runSwiftUiDesignBuild, runtimeSnapshotSchema } = require("./swiftui-design-runtime.cjs");
const { buildSwiftVisualPayload } = require("./swift-visual-assets.cjs");
const { isTextCleanPdfSafe } = require("./pdf-text-clean.cjs");
const { convertPdfToFigmaSvg, resolvePdfToCairo } = require("./swift-pdf-vector.cjs");
const { MAX_SWIFT_PAGES, buildSwiftFigmaScreens } = require("./swift-figma-page.cjs");
const { extractPdfTextRuns } = require("./swift-pdf-text.cjs");
const { prepareNativeSvgShadows } = require("./svg-native-shadows.cjs");
const { resolveCapturedSwiftVectorEffects, sourceVectorEffectSchema } = require("./swift-vector-effects.cjs");
const { resolveSwiftSourceImages } = require("./swift-source-images.cjs");
const { associatePdfPagesWithScreens } = require("./pdf-page-association.cjs");
const { normalizeSwiftTreeForPdfPage } = require("./swift-page-coordinate.cjs");
const { buildCodexConnectionPrompt, buildCodexNewThreadUrl, buildCodexSyncPrompt, findCodexProjectThread, runCodexSyncAgent } = require("./codex-sync-agent.cjs");
const { buildVisualEditPrompt, compareDesignStates, designNodeSnapshotSchema, extractDesignNodes, semanticIntentBatchSchema } = require("./visual-editing.cjs");
const { abortDesignEditCheckpoint, beginDesignEditCheckpoint, commitDesignEditIteration, resolveDesignEditCheckpoint } = require("./design-edit-checkpoint.cjs");
const { probeUrl, resolveDevCommand, startDevServer } = require("./dev-server.cjs");

const visualBaselineNodeSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_:/-]{1,500}$/),
  selector: z.string().min(1).max(240).nullable(),
  kind: z.enum(["element", "text", "svg", "image"]),
  width: z.number().finite().min(0).max(10000),
  height: z.number().finite().min(0).max(10000),
  backgroundColor: z.string().max(80).nullable(),
  radius: z.number().finite().min(0).max(5000).nullable(),
  fontSize: z.number().finite().min(0).max(400).nullable(),
  fontWeight: z.number().int().min(0).max(1000).nullable(),
  text: z.string().max(4000).nullable()
});

const syncStateSchema = z.object({
  version: z.number(),
  revision: z.number().int().nonnegative(),
  figma: z.object({
    fileKey: z.string().min(1),
    frameNodeId: z.string().optional(),
    frameName: z.string().optional()
  }),
  elements: z.record(
    z.object({
      code: z.object({
        file: z.string(),
        component: z.string().optional()
      }),
      figma: z.object({ nodeId: z.string() }),
      lastSync: z.unknown()
    })
  ),
  lastRevision: z
    .object({
      origin: z.string(),
      timestamp: z.string()
    })
    .optional()
});

const registrySchema = z.array(
  z.object({
    root: z.string().min(1),
    figmaFileName: z.string().optional(),
    figmaFileKey: z.string().optional(),
    figmaNodeId: z.string().optional(),
    figmaMappings: z.record(
      z.object({
        nodeId: z.string(),
        frameName: z.string()
      })
    ).optional(),
    visualBaselines: z.record(z.array(visualBaselineNodeSchema).max(5000)).optional(),
    swiftRuntimeSnapshot: runtimeSnapshotSchema.optional(),
    swiftRuntimeScreenshot: z.object({
      path: z.string().min(1).refine(path.isAbsolute),
      capturedAt: z.string().datetime(),
      viewport: z.object({
        x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive()
      }).strict(),
      displayScale: z.number().finite().min(0.5).max(8)
    }).strict().optional(),
    swiftRuntimeVector: z.object({
      pdfPath: z.string().min(1).refine(path.isAbsolute),
      svgPath: z.string().min(1).refine(path.isAbsolute),
      capturedAt: z.string().datetime(),
      viewport: z.object({
        x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive()
      }).strict()
    }).strict().optional(),
    swiftRuntimeVectorMessage: z.string().min(1).max(1000).optional(),
    // The Simulator this project was captured on, so later exports keep one
    // device and therefore one viewport.
    swiftSimulator: z.object({
      udid: z.string().min(1).max(80),
      name: z.string().min(1).max(120),
      runtimeId: z.string().min(1).max(160).nullable().optional()
    }).strict().optional(),
    swiftRuntimePdf: z.object({
      path: z.string().min(1).refine(path.isAbsolute),
      capturedAt: z.string().datetime(),
      viewport: z.object({ x: z.number().finite(), y: z.number().finite(), width: z.number().positive(), height: z.number().positive() }).strict(),
      pages: z.array(z.object({
        id: z.string().regex(/^pdf-page-\d+$/),
        pageNumber: z.number().int().positive().max(500),
        name: z.string().min(1).max(160),
        width: z.number().positive().max(10000),
        height: z.number().positive().max(10000),
        previewPath: z.string().min(1).refine(path.isAbsolute),
        pdfPath: z.string().min(1).refine(path.isAbsolute).optional(),
        cleanPdfPath: z.string().min(1).refine(path.isAbsolute).optional(),
        textCleanPdfPath: z.string().min(1).refine(path.isAbsolute).optional(),
        nativeEffectIds: z.array(z.string().regex(/^swift\/[a-f0-9]{16}\/(?:shadow|blur)$/)).max(2000).optional(),
        nativeEffects: z.array(sourceVectorEffectSchema).max(2000).optional(),
        pdfPageNumber: z.number().int().positive().max(500).optional(),
        renderSource: z.enum(["image-renderer", "window-fallback"]).optional(),
        sourceName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,159}$/).optional(),
        systemTabBar: z.object({
          designKit: z.string().regex(/^iOS \d+$/).optional(),
          appearance: z.enum(["classic", "liquid-glass"]).optional(),
          selectedIndex: z.number().int().nonnegative().max(20),
          items: z.array(z.object({
            title: z.string().min(1).max(120),
            systemImage: z.string().regex(/^[A-Za-z0-9._-]{1,120}$/),
            sourceName: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,159}$/)
          }).strict()).min(2).max(20)
        }).strict().optional(),
        contentFrame: z.object({
          x: z.number().finite().min(-10000).max(10000),
          y: z.number().finite().min(-10000).max(10000),
          width: z.number().positive().max(10000),
          height: z.number().positive().max(10000)
        }).strict().optional(),
        sourceScreenId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).optional(),
        sourceScreenName: z.string().min(1).max(160).optional()
      }).strict()).min(1).max(500)
    }).strict().optional(),
    codexThreadId: z.string().uuid().optional(),
    codexThreadBindingVersion: z.literal(2).optional(),
    codexThreadRequestedAt: z.string().datetime().optional()
  })
);

const deviceConnectionSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{64}$/),
  confirmed: z.boolean()
});

const handoffPageSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(300),
  route: z.string().max(2000),
  recipe: z.array(z.object({
    kind: z.string().max(40),
    locator: z.string().max(2000),
    label: z.string().max(300)
  })).max(20),
  depth: z.number().int().nonnegative().max(20),
  thumbnail: z.object({
    // A scan just taken carries the picture; one loaded from disk carries a
    // reference to it, resolved before anything leaves the app.
    dataUrl: z.string().regex(/^(?:data:image\/|crank-asset:\/\/)/).max(20_000_000),
    width: z.number().finite(),
    height: z.number().finite()
  }).nullable(),
  layerTree: z.object({
    width: z.number().finite(),
    height: z.number().finite(),
    tree: z.unknown()
  }).nullable().optional(),
  // Why this page has no layers, when it has none. Carried so the export can
  // say what went wrong rather than only that something did.
  layerError: z.string().max(400).nullable().optional(),
  // An iOS page is an exported PDF page rather than a captured document. Only
  // its identity travels: the PDF, its clean variants, and the runtime capture
  // stay on disk, and the Figma step reads them from there.
  vector: z.object({
    pageId: z.string().regex(/^pdf-page-\d+$/),
    width: z.number().finite(),
    height: z.number().finite(),
    renderSource: z.enum(["image-renderer", "window-fallback"]).nullable().optional(),
    sourceName: z.string().max(200).nullable().optional()
  }).nullable().optional(),
  // The page's own document. Held as references to stored pictures, so the
  // length is the markup itself rather than the markup plus every image in it.
  snapshot: z.object({
    html: z.string().max(60_000_000),
    bytes: z.number().finite(),
    stats: z.object({
      stylesheets: z.number().finite(),
      inlinedAssets: z.number().finite(),
      rasterised: z.array(z.string().max(200)).max(500),
      skippedAssets: z.array(z.string().max(300)).max(500),
      svgPreserved: z.number().finite()
    }).partial()
  }).nullable().optional(),
  figmaNodeId: z.string().regex(/^\d+:\d+$/).nullable().optional(),
  variants: z.array(z.object({
    id: z.string().max(200),
    name: z.string().max(300),
    route: z.string().max(2000),
    recipe: z.array(z.object({ kind: z.string().max(40), locator: z.string().max(2000), label: z.string().max(300) })).max(20),
    thumbnail: z.object({
      dataUrl: z.string().regex(/^(?:data:image\/|crank-asset:\/\/)/).max(20_000_000),
      width: z.number().finite(), height: z.number().finite()
    }).nullable(),
    layerTree: z.object({
      width: z.number().finite(),
      height: z.number().finite(),
      tree: z.unknown()
    }).nullable().optional(),
    snapshot: z.object({ html: z.string().max(60_000_000), bytes: z.number().finite(), stats: z.record(z.unknown()) }).nullable().optional()
  })).max(50).optional()
});

const handoffInventorySchema = z.object({
  origin: z.string().max(2000).optional(),
  // How the pages were captured. A served project is crawled in a browser; an
  // iOS project is built and exported on a Simulator, and reaches Figma as its
  // rendered pages rather than as a layer tree.
  platform: z.enum(["web", "swiftui"]).optional(),
  // What the scan is *of*, as opposed to where it was served from. A folder is
  // served on a fresh port every time, so the origin cannot name the project.
  source: z.object({
    kind: z.enum(["folder", "url"]),
    target: z.string().min(1).max(2000)
  }).optional(),
  pages: z.array(handoffPageSchema).max(500),
  filtered: z.array(z.object({
    label: z.string().max(300),
    from: z.string().max(300),
    reason: z.string().max(200),
    magnitude: z.number().finite()
  })).max(500).optional()
});

/**
 * A validator's complaint, in a sentence.
 *
 * Zod reports the path as an array of every index it walked through, which for
 * a captured page is dozens of "children" entries and tells the reader nothing
 * about where on their screen the trouble is. The page and the property do.
 */
function describeRejectedJob(cause, job) {
  const issues = Array.isArray(cause?.issues) ? cause.issues : [];
  if (issues.length === 0) {
    return cause instanceof Error ? cause.message : "Figma refused this export.";
  }
  const [first] = issues;
  const path = Array.isArray(first.path) ? first.path : [];
  const property = [...path].reverse().find((part) => typeof part === "string" && part !== "children") ?? "a property";
  const screenIndex = path[0] === "screens" && typeof path[1] === "number" ? path[1] : null;
  const page = screenIndex !== null ? job?.screens?.[screenIndex]?.name : null;
  const where = page ? `「${page}」` : "one page";
  const more = issues.length > 1 ? ` (${issues.length} values in all)` : "";
  return `${where} could not be sent: ${property} — ${first.message}${more}.`;
}

const projectRootSchema = z.string().min(1).refine(path.isAbsolute);
const expectedProjectKindSchema = z.enum(["web", "desktop", "swiftui"]).optional();
const screenIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const pairingCodeSchema = z.string().regex(/^\d{6}$/);
const projectPreviewSchema = z.object({
  screenId: screenIdSchema,
  screenshotDataUrl: z.string().startsWith("data:image/jpeg;base64,").max(3_000_000),
  width: z.number().finite().positive().max(10000),
  height: z.number().finite().positive().max(10000)
}).strict();
const appIconPath = path.join(__dirname, "..", "assets", "app-icon.png");
// Reached from outside the app — the Finder reveals it and Figma imports it —
// so it must be the copy on disk rather than the one inside the archive.
const figmaPluginManifestPath = shippedPath("figma-plugin", "manifest.json");
let figmaBridge = null;
let swiftUiRuntimeServer = null;
const pendingPulls = new Map();
const pendingDesignEdits = new Map();

const registryPath = () => path.join(app.getPath("userData"), "projects.json");
const deviceConnectionPath = () => path.join(app.getPath("userData"), "figma-device-connection.json");

// Built on first use: the path it lives under is only known once the app is
// ready, and a push completes long after the IPC handler that started it.
let inventoryStore = null;
const inventoryRegistry = () => (inventoryStore ??= createInventoryRegistry(app.getPath("userData")));
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function snapshotEditableFiles(root) {
  const files = await collectFiles(root, (target) => /\.(?:css|h|html|js|json|jsx|less|m|pbxproj|plist|sass|scss|strings|svelte|swift|ts|tsx|vue|xcconfig)$/i.test(target), 5000);
  return new Map(await Promise.all(files.map(async (target) => {
    try {
      const content = await readFile(target);
      return [path.relative(root, target), createHash("sha256").update(content).digest("hex")];
    } catch {
      return [path.relative(root, target), null];
    }
  })));
}

function changedEditableFiles(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .filter((file) => before.get(file) !== after.get(file))
    .sort();
}

async function readRegistry() {
  try {
    return registrySchema.parse(JSON.parse(await readFile(registryPath(), "utf8")));
  } catch {
    return [];
  }
}

async function writeRegistry(projects) {
  await writeFile(registryPath(), `${JSON.stringify(registrySchema.parse(projects), null, 2)}\n`);
}

async function updateCodexThreadMetadata(root, update) {
  const registry = await readRegistry();
  const index = registry.findIndex((entry) => entry.root === root);
  if (index < 0) throw new Error("Project is no longer registered");
  const nextRegistry = [...registry];
  nextRegistry[index] = update(registry[index]);
  await writeRegistry(nextRegistry);
  return nextRegistry[index];
}

async function rememberProjectCodexThread(root, threadId) {
  return await updateCodexThreadMetadata(root, (current) => {
    const { codexThreadRequestedAt: _requestedAt, ...rest } = current;
    return {
      ...rest,
      codexThreadId: threadId,
      codexThreadBindingVersion: 2
    };
  });
}

async function requestProjectCodexThread(root, prompt) {
  const requestedAt = new Date().toISOString();
  const metadata = await updateCodexThreadMetadata(root, (current) => {
    const { codexThreadId: _legacyThreadId, codexThreadBindingVersion: _legacyBinding, ...rest } = current;
    return { ...rest, codexThreadRequestedAt: requestedAt };
  });
  await shell.openExternal(buildCodexNewThreadUrl({ root, prompt }));
  return metadata;
}

async function resolveProjectCodexThread(root, project, current) {
  if (current.codexThreadBindingVersion === 2 && current.codexThreadId) {
    return { threadId: current.codexThreadId, metadata: current };
  }
  if (!current.codexThreadRequestedAt) return null;
  const thread = await findCodexProjectThread({
    root,
    threadName: `UI Sync · ${project.name}`,
    notBefore: current.codexThreadRequestedAt
  });
  if (!thread?.id) return null;
  return {
    threadId: thread.id,
    metadata: await rememberProjectCodexThread(root, thread.id)
  };
}

async function readDeviceConnection() {
  try {
    return deviceConnectionSchema.parse(JSON.parse(await readFile(deviceConnectionPath(), "utf8")));
  } catch {
    return null;
  }
}

async function writeDeviceConnection(connection) {
  await writeFile(deviceConnectionPath(), `${JSON.stringify(deviceConnectionSchema.parse(connection), null, 2)}\n`);
}

async function ensureDeviceConnection() {
  const existing = await readDeviceConnection();
  if (existing) return existing;
  const connection = { token: randomBytes(32).toString("hex"), confirmed: false };
  await writeDeviceConnection(connection);
  return connection;
}

async function confirmDeviceConnection(token) {
  const current = await readDeviceConnection();
  if (current?.token === token && !current.confirmed) await writeDeviceConnection({ ...current, confirmed: true });
}

async function resetDeviceConnection(token) {
  const current = await readDeviceConnection();
  if (current?.token !== token) return;
  await writeDeviceConnection({ token: randomBytes(32).toString("hex"), confirmed: false });
}

/**
 * Leaves out the pages this project was told it does not want. A scan finds
 * them every time, so the decision has to be applied every time.
 */
async function keepWanted(id, pages) {
  const dropped = new Set(await inventoryRegistry().dropped(id));
  return dropped.size === 0 ? pages : pages.filter((page) => !dropped.has(page.id));
}

/**
 * Records a push that came from a scan rather than a registered project.
 *
 * The two flows share the bridge but not their memory: a scanned URL is not in
 * projects.json, so the older path rejected its completion as an unregistered
 * project and the plugin reported a failure over frames it had just drawn.
 */
async function saveInventoryPush(context, result) {
  await inventoryRegistry().recordFigmaPush(context.inventoryId, {
    frames: Object.fromEntries(
      (result.mappings ?? []).map((mapping) => [mapping.screenId, { nodeId: mapping.nodeId, frameName: mapping.frameName }])
    ),
    screens: Object.fromEntries(
      (result.screens ?? []).filter((screen) => screen.nodes.length > 0).map((screen) => [screen.screenId, screen.nodes])
    )
  });
}

async function saveAutomaticMappings(context, result) {
  const registry = await readRegistry();
  const index = registry.findIndex((item) => item.root === context.root);
  if (index < 0) throw new Error("Project is no longer registered");
  const current = registry[index];
  if (current.figmaFileKey !== context.figmaFileKey) {
    throw new Error("The connected Figma file changed while frames were being linked");
  }
  const figmaMappings = { ...(current.figmaMappings ?? {}) };
  for (const mapping of result.mappings) {
    figmaMappings[mapping.screenId] = {
      nodeId: mapping.nodeId,
      frameName: mapping.frameName
    };
  }
  const renderedBaselines = Object.fromEntries(
    (result.screens ?? [])
      .filter((screen) => screen.nodes.length > 0)
      .map((screen) => [screen.screenId, screen.nodes])
  );
  const visualBaselines = {
    ...(context.visualBaselines ?? {}),
    ...renderedBaselines
  };
  const nextRegistry = [...registry];
  nextRegistry[index] = {
    ...current,
    figmaMappings,
    ...(Object.keys(visualBaselines).length > 0 ? { visualBaselines } : {})
  };
  await writeRegistry(nextRegistry);
}

async function preparePullPreview(context, result) {
  const registry = await readRegistry();
  const current = registry.find((entry) => entry.root === context.root);
  if (!current?.visualBaselines) throw new Error("Push this project to Figma once before pulling changes back");
  const figmaScreens = Object.fromEntries(result.screens.map((screen) => [screen.screenId, screen.nodes]));
  const preview = buildPullPreview(current.visualBaselines, context.codeScreens, figmaScreens);
  const patchPlan = context.projectKind === "swiftui"
    ? await createSwiftPatchPlan(context.root, preview.changes)
    : await createPatchPlan(context.root, preview.changes);
  const automaticChangeIds = new Set(patchPlan.mutations.map((mutation) => mutation.changeId));
  const pullPreview = {
    changes: preview.changes.map((change) => ({
      id: change.id,
      screenId: change.screenId,
      area: context.screenNames[change.screenId] ?? "Screen",
      property: change.property,
      before: change.code,
      after: change.figma,
      route: automaticChangeIds.has(change.id) ? "automatic" : "codex"
    })),
    conflicts: preview.conflicts,
    rejected: patchPlan.rejected.map(({ id, reason }) => ({ id, reason }))
  };
  pendingPulls.set(context.root, { patchPlan, preview, figmaScreens, pullPreview });
  return { pullPreview };
}

async function readJsonIfPresent(target) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch {
    return null;
  }
}

async function detectProjectRuntime(root, state) {
  const javascript = await scanJavascriptProject(root);
  if (javascript) return javascript;
  const hasSwiftMapping = Object.values(state.elements).some((element) => element.code.file.endsWith(".swift"));
  if (hasSwiftMapping) {
    const swiftUi = await scanSwiftUiProject(root, { cacheDirectory: path.join(app.getPath("userData"), "tools") });
    if (swiftUi) return swiftUi;
  }

  const manifestPaths = new Set([path.join(root, "package.json")]);
  for (const element of Object.values(state.elements)) {
    let directory = path.dirname(path.resolve(root, element.code.file));
    while (directory.startsWith(root)) {
      manifestPaths.add(path.join(directory, "package.json"));
      if (directory === root) break;
      directory = path.dirname(directory);
    }
  }

  const manifests = (
    await Promise.all([...manifestPaths].map((manifestPath) => readJsonIfPresent(manifestPath)))
  ).filter(Boolean);
  const dependencyNames = new Set();
  for (const manifest of manifests) {
    for (const field of ["dependencies", "devDependencies"]) {
      Object.keys(manifest[field] ?? {}).forEach((name) => dependencyNames.add(name));
    }
  }

  const has = (name) => dependencyNames.has(name);
  const isDesktop = has("electron") || has("electron-vite") || has("@electron/remote");
  const hasTailwind = has("tailwindcss") || has("@tailwindcss/vite");
  let framework = "React";
  if (has("next")) framework = "Next.js";
  else if (has("@remix-run/react")) framework = "Remix";
  else if (has("gatsby")) framework = "Gatsby";
  else if (has("vite")) framework = "React + Vite";

  return {
    kind: isDesktop ? "desktop" : "web",
    framework: `${framework}${hasTailwind ? " + Tailwind" : ""}`,
    analysisEngine: "Static project scan",
    detectedName: path.basename(root),
    sourceFileCount: 0,
    screens: []
  };
}

function applyRegistryMetadata(project, metadata) {
  if (!metadata?.figmaFileKey) return project;
  const mappings = metadata.figmaMappings ?? {};
  return {
    ...project,
    connectionStatus: "connected",
    figmaFileName: metadata.figmaFileName ?? "Figma file",
    fileKey: metadata.figmaFileKey,
    frameNodeId: metadata.figmaNodeId ?? null,
    frameName: metadata.figmaNodeId ? `Node ${metadata.figmaNodeId}` : null,
    linkedCount: Object.keys(mappings).length,
    screens: project.screens.map((screen) => ({
      ...screen,
      figmaNodeId: mappings[screen.id]?.nodeId ?? null,
      figmaFrameName: mappings[screen.id]?.frameName ?? null
    }))
  };
}

function figmaSwiftTree(node) {
  if (!node || typeof node !== "object") return node;
  const { sourceExpression: _localSourceExpression, children, ...safeNode } = node;
  return {
    ...safeNode,
    ...(children ? { children: children.map(figmaSwiftTree) } : {})
  };
}

function createUnlinkedProject(root, runtime, metadata) {
  let screens = runtime.screens ?? [];
  let runtimeCapture = runtime.kind === "swiftui" ? { state: "not-run" } : undefined;
  let analysisEngine = runtime.analysisEngine;
  if (runtime.kind === "swiftui" && metadata?.swiftRuntimeSnapshot) {
    const merged = mergeRuntimeSnapshot(screens, metadata.swiftRuntimeSnapshot);
    screens = merged.screens;
    analysisEngine = `${runtime.analysisEngine} + Design Runtime`;
    runtimeCapture = {
      state: "captured",
      capturedAt: metadata.swiftRuntimeSnapshot.capturedAt,
      capturedNodeCount: Math.max(merged.coverage.capturedNodeCount, metadata.swiftRuntimeSnapshot.nodes.filter((node) => !node.syncId.startsWith("swift/")).length),
      screenCount: Math.max(merged.coverage.screenCount, metadata.swiftRuntimeSnapshot.nodes.some((node) => !node.syncId.startsWith("swift/")) ? 1 : 0),
      deviceName: metadata.swiftRuntimeSnapshot.deviceName
    };
  }
  const project = {
    id: Buffer.from(root).toString("base64url"),
    root,
    name: runtime.detectedName ?? path.basename(root),
    kind: runtime.kind,
    framework: runtime.framework,
    analysisEngine,
    ...(runtimeCapture ? { runtimeCapture } : {}),
    figmaFileName: null,
    frameName: null,
    frameNodeId: null,
    fileKey: null,
    linkedCount: 0,
    revision: 0,
    snapshotCount: 0,
    lastOrigin: "discovery",
    lastSyncedAt: null,
    connectionStatus: "setup",
    sourceFileCount: runtime.sourceFileCount ?? 0,
    codexThreadId: metadata?.codexThreadId ?? null,
    screens
  };
  return applyRegistryMetadata(project, metadata);
}

async function inspectProject(root, metadata) {
  const safeRoot = projectRootSchema.parse(root);
  if (await pathExists(path.join(safeRoot, ".ui-sync", "state.json"))) {
    return loadProject(safeRoot, metadata);
  }
  const javascript = await scanJavascriptProject(safeRoot);
  if (javascript) {
    if (path.resolve(safeRoot) === path.resolve(app.getAppPath())) {
      const registered = await readRegistry();
      const available = [];
      for (const entry of registered) {
        if (await pathExists(entry.root)) available.push(entry);
      }
      if (available.length > 0) {
        javascript.screens = available.map((entry) => {
          const projectId = Buffer.from(entry.root).toString("base64url");
          return createJavascriptScreen(
            safeRoot,
            path.basename(entry.root) || "Project",
            projectId,
            null,
            "/",
            ["Editable rendered state", "Project selection"]
          );
        });
      }
    }
    return createUnlinkedProject(safeRoot, javascript, metadata);
  }
  const swiftUi = await scanSwiftUiProject(safeRoot, { cacheDirectory: path.join(app.getPath("userData"), "tools") });
  if (swiftUi) return createUnlinkedProject(safeRoot, swiftUi, metadata);
  throw new Error("unsupported-project");
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const { serializeRenderedApplication } = require("./figma-tree.cjs");

const { captureMimeTypes, startLocalRendererServer } = require("./static-server.cjs");

async function captureApplicationScreens(root, screens, { includeScreenshots = false } = {}) {
  const appRoot = path.resolve(app.getAppPath());
  const capturesSelf = path.resolve(root) === appRoot && screens.every((screen) => screen.captureView);
  if (!capturesSelf && screens.some((screen) => !screen.captureEntry)) {
    throw new Error("No built renderer was found. Run this Electron project's build command once, then refresh the project.");
  }

  const captureWindow = new BrowserWindow({
    show: false,
    frame: false,
    width: 1220,
    height: 790,
    useContentSize: true,
    backgroundColor: "#f4f4f2",
    webPreferences: {
      ...(capturesSelf ? { preload: path.join(__dirname, "preload.cjs") } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `temporary:ui-sync-capture-${randomBytes(12).toString("hex")}`
    }
  });
  captureWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  captureWindow.webContents.on("will-navigate", (event) => event.preventDefault());
  captureWindow.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));

  const captures = new Map();
  try {
    for (const screen of screens) {
      let rendererServer = null;
      try {
        if (capturesSelf) {
          await captureWindow.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
            query: { "ui-sync-capture": "1", "capture-project-id": screen.captureView }
          });
        } else {
          const entryPath = path.resolve(root, screen.captureEntry);
          if (entryPath !== path.resolve(root) && !entryPath.startsWith(`${path.resolve(root)}${path.sep}`)) {
            throw new Error("Renderer entry escaped the selected project folder");
          }
          rendererServer = await startLocalRendererServer(entryPath);
          captureWindow.webContents.session.webRequest.onBeforeRequest((details, callback) => {
            try {
              const requestUrl = new URL(details.url);
              const allowed = ["data:", "blob:", "devtools:"].includes(requestUrl.protocol)
                || requestUrl.origin === rendererServer.origin;
              callback({ cancel: !allowed });
            } catch {
              callback({ cancel: true });
            }
          });
          const captureUrl = new URL(rendererServer.url);
          const capturePath = typeof screen.capturePath === "string" ? screen.capturePath : "/";
          if (capturePath.startsWith("?")) captureUrl.search = capturePath;
          else if (capturePath.startsWith("#")) captureUrl.hash = capturePath;
          else if (capturePath !== "/") captureUrl.pathname = capturePath.startsWith("/") ? capturePath : `/${capturePath}`;
          await captureWindow.loadURL(captureUrl.toString());
        }
        await captureWindow.webContents.executeJavaScript(
          "document.documentElement.dataset.platform = 'macos'; Promise.race([document.fonts.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('Fonts did not finish loading within 10 seconds')), 10000))])",
          true
        );
        for (let attempt = 0; attempt < 75; attempt += 1) {
          const ready = capturesSelf
            ? await captureWindow.webContents.executeJavaScript("document.documentElement.dataset.captureReady === 'true'", true)
            : await captureWindow.webContents.executeJavaScript(
              "Boolean((document.querySelector('[data-ui-sync-root], .app-frame, #root, #app') || document.body)?.childNodes.length)",
              true
            );
          if (ready) break;
          await wait(40);
        }
        await wait(capturesSelf ? 120 : 350);
        const editableDom = await captureWindow.webContents.executeJavaScript(
          `(${serializeRenderedApplication.toString()})()`,
          true
        );
        if (!editableDom?.tree || editableDom.width < 1 || editableDom.height < 1) {
          throw new Error("The Electron renderer opened but did not produce a visible DOM");
        }
        let screenshotDataUrl = null;
        if (includeScreenshots) {
          const screenshot = await captureWindow.webContents.capturePage();
          const thumbnail = screenshot.resize({ width: 420, quality: "good" });
          screenshotDataUrl = `data:image/jpeg;base64,${thumbnail.toJPEG(68).toString("base64")}`;
        }
        captures.set(screen.id, { ...editableDom, ...(screenshotDataUrl ? { screenshotDataUrl } : {}) });
      } finally {
        if (rendererServer) await rendererServer.close();
      }
    }
  } finally {
    captureWindow.destroy();
  }
  return captures;
}

async function loadProject(root, metadata = {}) {
  const safeRoot = projectRootSchema.parse(root);
  const statePath = path.join(safeRoot, ".ui-sync", "state.json");
  const state = syncStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  const runtime = await detectProjectRuntime(safeRoot, state);
  const snapshotsPath = path.join(safeRoot, ".ui-sync", "snapshots");
  let snapshotCount = 0;
  try {
    snapshotCount = (await readdir(snapshotsPath)).filter((name) => name.endsWith(".json")).length;
  } catch {
    snapshotCount = 0;
  }

  return {
    id: Buffer.from(safeRoot).toString("base64url"),
    root: safeRoot,
    name: runtime.detectedName ?? path.basename(safeRoot),
    kind: runtime.kind,
    framework: runtime.framework,
    analysisEngine: runtime.analysisEngine,
    figmaFileName: metadata.figmaFileName ?? state.figma.frameName ?? "Figma",
    frameName: state.figma.frameName ?? "Linked frame",
    frameNodeId: state.figma.frameNodeId ?? Object.values(state.elements)[0]?.figma.nodeId ?? null,
    fileKey: state.figma.fileKey,
    linkedCount: Object.keys(state.elements).length,
    revision: state.revision,
    snapshotCount,
    lastOrigin: state.lastRevision?.origin ?? "setup",
    lastSyncedAt: state.lastRevision?.timestamp ?? null,
    connectionStatus: "connected",
    sourceFileCount: runtime.sourceFileCount ?? 0,
    codexThreadId: metadata.codexThreadId ?? null,
    screens: runtime.screens ?? []
  };
}

async function listProjects() {
  const projects = await readRegistry();
  const loaded = await Promise.all(
    projects.map(async (entry) => {
      const { root } = entry;
      try {
        if (await pathExists(path.join(root, ".ui-sync", "state.json"))) {
          return await loadProject(root, entry);
        }
        return await inspectProject(root, entry);
      } catch {
        return null;
      }
    })
  );
  return omitWorkspaceContainers(loaded.filter(Boolean));
}

async function inspectAndRegisterProjectFolders(roots, expectedKind = null) {
  const registry = await readRegistry();
  const candidateRoots = [];
  for (const selectedRoot of roots) {
    if (await pathExists(path.join(selectedRoot, ".ui-sync", "state.json"))) candidateRoots.push(selectedRoot);
    const [javascriptRoots, swiftUiRoots] = await Promise.all([
      expectedKind === "swiftui" ? [] : discoverJavascriptProjectRoots(selectedRoot),
      expectedKind === "web" || expectedKind === "desktop" ? [] : discoverSwiftUiProjectRoots(selectedRoot)
    ]);
    candidateRoots.push(...javascriptRoots, ...swiftUiRoots);
  }

  const projects = [];
  for (const root of [...new Set(candidateRoots)]) {
    try {
      const registered = registry.find((item) => item.root === root);
      projects.push(await inspectProject(root, registered));
    } catch {
      continue;
    }
  }
  projects.sort((left, right) => {
    const leftMatch = expectedKind && left.kind === expectedKind ? 0 : 1;
    const rightMatch = expectedKind && right.kind === expectedKind ? 0 : 1;
    return leftMatch - rightMatch || left.root.localeCompare(right.root);
  });

  const registeredRoots = new Set(registry.map((entry) => entry.root));
  const additions = projects
    .filter((project) => !registeredRoots.has(project.root))
    .map((project) => ({ root: project.root }));
  if (additions.length > 0) await writeRegistry([...registry, ...additions]);
  return projects;
}

/**
 * Stores what an iOS export produced, keyed by the project folder.
 *
 * The scan hands the renderer pages and pictures; the PDF pages, their clean
 * variants, and the runtime snapshot stay here, because that is what building
 * the Figma layers reads — and none of it belongs in a renderer payload.
 */
async function rememberSwiftCapture(root, capture) {
  const registry = await readRegistry();
  const index = registry.findIndex((item) => item.root === root);
  const entry = {
    ...(index >= 0 ? registry[index] : { root }),
    swiftRuntimeSnapshot: capture.snapshot,
    swiftRuntimeScreenshot: capture.screenshot,
    ...(capture.pdfDocument ? { swiftRuntimePdf: capture.pdfDocument } : {}),
    ...(capture.simulator?.udid ? { swiftSimulator: capture.simulator } : {}),
    ...(capture.vectorMessage ? { swiftRuntimeVectorMessage: capture.vectorMessage } : {})
  };
  delete entry.swiftRuntimeVector;
  if (!capture.pdfDocument) delete entry.swiftRuntimePdf;
  if (!capture.vectorMessage) delete entry.swiftRuntimeVectorMessage;
  await writeRegistry(index >= 0
    ? registry.map((item, at) => (at === index ? entry : item))
    : [...registry, entry]);
  return entry;
}

/**
 * Builds the Figma job for the exported iOS pages of one scan.
 *
 * The renderer sends page identities; the export they name is read back from
 * disk, so what is drawn is the capture UI Sync actually took rather than
 * anything a payload could have carried or altered.
 */
async function buildSwiftInventoryJob(parsed, { kind, target, figmaFileName, frames, onProgress }) {
  const registry = await readRegistry();
  const metadata = registry.find((item) => item.root === target);
  if (!metadata?.swiftRuntimePdf) {
    return { ok: false, message: "This iOS project has no exported pages yet. Scan it again." };
  }
  const wanted = new Set(parsed.pages.map((page) => page.vector?.pageId).filter(Boolean));
  const pages = metadata.swiftRuntimePdf.pages.filter((page) => wanted.has(page.id));
  if (pages.length === 0) {
    return { ok: false, message: "None of these pages are in the current export. Scan the project again." };
  }
  if (pages.length > MAX_SWIFT_PAGES) {
    return { ok: false, message: `This scan has ${pages.length} pages. Send them page by page — one Figma sync carries at most ${MAX_SWIFT_PAGES}.` };
  }
  const project = await inspectProject(target, metadata);
  const { screens, assets, warnings } = await buildSwiftFigmaScreens({
    root: target,
    metadata,
    screens: project.screens,
    pages,
    frames,
    onProgress
  });
  return {
    ok: true,
    assets,
    warnings,
    missing: [],
    dropped: [],
    substitutedFonts: [],
    job: {
      operation: "push",
      projectId: projectIdFor(`${kind}:${target}`),
      projectName: String(nameFor(kind, target) || "Project").slice(0, 160),
      figmaFileName: String(figmaFileName || "").slice(0, 240),
      screens
    }
  };
}

/** What an iOS scan needs from the app: where to build, what to talk to, and
 * which Simulator this project was last captured on. */
async function swiftScanOptions(root) {
  const registry = await readRegistry().catch(() => []);
  const remembered = registry.find((item) => item.root === root);
  return {
    cacheDirectory: path.join(app.getPath("userData"), "design-build"),
    runtimeServer: swiftUiRuntimeServer,
    preferredUdid: remembered?.swiftSimulator?.udid ?? null
  };
}

/**
 * Keeps an iOS capture, with its pages tied back to the views they came from.
 *
 * The association is what lets the Figma step restore this page's own text,
 * effects, and images rather than another page's.
 */
async function storeSwiftCapture(root, capture) {
  if (capture.pdfDocument) {
    const scanned = await scanSwiftUiProject(root, { cacheDirectory: path.join(app.getPath("userData"), "tools") }).catch(() => null);
    if (scanned?.screens?.length) {
      capture.pdfDocument.pages = associatePdfPagesWithScreens(capture.pdfDocument.pages, scanned.screens, capture.snapshot);
    }
  }
  await rememberSwiftCapture(root, capture);
}

async function performSwiftUiDesignBuild(safeRoot) {
  if (!swiftUiRuntimeServer) throw new Error("The local SwiftUI runtime bridge is not running");
  const registry = await readRegistry();
  const index = registry.findIndex((item) => item.root === safeRoot);
  if (index < 0) throw new Error("Project is not registered");
  const currentProject = await inspectProject(safeRoot, registry[index]);
  if (currentProject.kind !== "swiftui") throw new Error("Design Build is only available for SwiftUI projects");
  const result = await runSwiftUiDesignBuild({
    root: safeRoot,
    cacheDirectory: path.join(app.getPath("userData"), "design-build"),
    runtimeServer: swiftUiRuntimeServer
  });
  if (result.pdfDocument) {
    result.pdfDocument.pages = associatePdfPagesWithScreens(result.pdfDocument.pages, currentProject.screens, result.snapshot);
  }
  const nextRegistry = [...registry];
  nextRegistry[index] = {
    ...registry[index],
    swiftRuntimeSnapshot: result.snapshot,
    swiftRuntimeScreenshot: result.screenshot,
    ...(result.pdfDocument ? { swiftRuntimePdf: result.pdfDocument } : {}),
    ...(result.vectorMessage ? { swiftRuntimeVectorMessage: result.vectorMessage } : {})
  };
  delete nextRegistry[index].swiftRuntimeVector;
  if (!result.pdfDocument) delete nextRegistry[index].swiftRuntimePdf;
  if (!result.vectorMessage) delete nextRegistry[index].swiftRuntimeVectorMessage;
  await writeRegistry(nextRegistry);
  const project = await inspectProject(safeRoot, nextRegistry[index]);
  return {
    project,
    capturedNodeCount: project.runtimeCapture?.capturedNodeCount ?? 0,
    screenCount: project.runtimeCapture?.screenCount ?? 0,
    deviceName: result.snapshot.deviceName ?? "iPhone Simulator",
    vectorReady: Boolean(result.pdfDocument),
    vectorMessage: result.vectorMessage
  };
}

async function createSwiftUiDesignSession(safeRoot) {
  const registry = await readRegistry();
  const metadata = registry.find((item) => item.root === safeRoot);
  if (!metadata) throw new Error("Project is not registered");
  const project = await inspectProject(safeRoot, metadata);
  if (project.kind !== "swiftui") throw new Error("Design Studio is only available for SwiftUI projects");
  const explicitNodes = [...new Map((metadata.swiftRuntimeSnapshot?.nodes ?? [])
    .filter((node) => !node.syncId.startsWith("swift/"))
    .map((node) => ({
      id: node.syncId,
      name: node.syncId.replace(/[-_.:/]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()),
      frame: node.frame,
      cornerRadius: node.cornerRadius ?? null,
      backgroundColor: node.backgroundColor ?? null,
      fontSize: node.fontSize ?? null,
      sourceHint: node.sourceHint ?? `${node.sourceFile}:1`,
      ...(node.text ? { text: node.text } : {}),
      pageName: node.sourceName || project.screens[0]?.name || "Current screen",
      measurement: {
        frame: "runtime",
        properties: node.cornerRadius != null || node.backgroundColor != null || node.fontSize != null ? "runtime" : "unavailable"
      }
    }))
    .map((node) => [node.id, node])).values()];
  const nodes = z.array(designNodeSnapshotSchema).max(30).parse((explicitNodes.length > 0 ? explicitNodes : extractDesignNodes(project)).slice(0, 30));
  if (!metadata.swiftRuntimePdf) {
    return {
      state: "needs-capture",
      project,
      nodes: [],
      pdfDataUrl: null,
      pdfReady: false,
      screenshotDataUrl: null,
      vectorSvgDataUrl: null,
      vectorReady: false,
      vectorMessage: metadata.swiftRuntimeVectorMessage ?? null,
      viewport: null,
      deviceName: null,
      capturedAt: null
    };
  }
  const pdf = await readFile(metadata.swiftRuntimePdf.path);
  const screenshot = metadata.swiftRuntimeScreenshot?.path
    ? await readFile(metadata.swiftRuntimeScreenshot.path).catch(() => null)
    : null;
  const pages = await Promise.all(metadata.swiftRuntimePdf.pages.map(async (page) => {
    const pagePdfPath = page.pdfPath ?? metadata.swiftRuntimePdf.path;
    const [pagePdf, fallbackPreview] = await Promise.all([
      readFile(pagePdfPath),
      readFile(page.previewPath)
    ]);
    return {
      id: page.id,
      pageNumber: page.pageNumber,
      name: page.name,
      sourceScreenId: page.sourceScreenId,
      sourceScreenName: page.sourceScreenName,
      renderSource: page.renderSource,
      width: page.width,
      height: page.height,
      pdfDataUrl: `data:application/pdf;base64,${pagePdf.toString("base64")}`,
      pdfPageNumber: page.pdfPageNumber ?? page.pageNumber,
      previewDataUrl: `data:image/png;base64,${fallbackPreview.toString("base64")}`
    };
  }));
  return {
    state: "ready",
    project,
    nodes,
    pdfDataUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
    pdfReady: true,
    screenshotDataUrl: screenshot ? `data:image/png;base64,${screenshot.toString("base64")}` : null,
    vectorSvgDataUrl: null,
    vectorReady: true,
    pages,
    vectorMessage: metadata.swiftRuntimeVectorMessage ?? null,
    viewport: metadata.swiftRuntimePdf.viewport,
    deviceName: metadata.swiftRuntimeSnapshot?.deviceName ?? "iPhone Simulator",
    capturedAt: metadata.swiftRuntimePdf.capturedAt
  };
}

async function performSwiftUiVisualEdit(event, safeRoot, unsafeBatch) {
  if (pendingDesignEdits.has(safeRoot)) throw new Error("Accept or reject the current visual edit before starting another one");
  const batch = semanticIntentBatchSchema.parse(unsafeBatch);
  if (batch.projectRoot !== safeRoot) throw new Error("The visual edit batch does not belong to this project");
  const beforeSession = await createSwiftUiDesignSession(safeRoot);
  const editNodes = batch.nodes?.length ? batch.nodes : beforeSession.nodes;
  if (editNodes.length === 0) throw new Error("This page has no source-linked SwiftUI layers to edit");

  const registry = await readRegistry();
  const current = registry.find((entry) => entry.root === safeRoot);
  if (!current) throw new Error("Project is not registered");
  const project = beforeSession.project;
  const linkedCodexThread = await resolveProjectCodexThread(safeRoot, project, current);
  if (!linkedCodexThread) {
    const connectionPrompt = buildCodexConnectionPrompt({ project });
    if (current.codexThreadRequestedAt) await shell.openExternal(buildCodexNewThreadUrl({ root: safeRoot, prompt: connectionPrompt }));
    else await requestProjectCodexThread(safeRoot, connectionPrompt);
    throw new Error("Codex opened this project in the correct folder. Send the prefilled connection message once, then confirm the visual edit again.");
  }

  let checkpoint = null;
  try {
    checkpoint = await beginDesignEditCheckpoint(safeRoot);
    const geometryOperations = batch.operations.filter((operation) => operation.operation === "resize" || operation.operation === "move_after");
    let comparison = null;
    let summary = "";
    let iterations = 0;
    const changedFiles = new Set();
    let metadataAfterCodex = linkedCodexThread.metadata;
    const rememberThread = async (threadId) => {
      metadataAfterCodex = await rememberProjectCodexThread(safeRoot, threadId);
      event.sender.send("projects:codex-thread-started", { root: safeRoot, threadId });
    };

    for (let iteration = 1; iteration <= 3; iteration += 1) {
      iterations = iteration;
      const prompt = buildVisualEditPrompt({
        project,
        batch,
        nodes: editNodes,
        iteration,
        previousDiff: comparison ? { checks: comparison.checks.filter((check) => check.passed === false) } : null
      });
      const beforeFiles = await snapshotEditableFiles(safeRoot);
      const agentResult = await runCodexSyncAgent({
        root: safeRoot,
        prompt,
        threadId: linkedCodexThread.threadId,
        threadName: `UI Sync · ${project.name}`,
        onThreadStarted: rememberThread
      });
      summary = agentResult.summary.slice(-12000);
      const afterFiles = await snapshotEditableFiles(safeRoot);
      for (const file of changedEditableFiles(beforeFiles, afterFiles)) changedFiles.add(file);
      const committed = await commitDesignEditIteration(checkpoint, iteration);
      for (const file of committed.changedFiles) changedFiles.add(file);

      await performSwiftUiDesignBuild(safeRoot);
      const actualSession = await createSwiftUiDesignSession(safeRoot);
      if (actualSession.state !== "ready") throw new Error("Design Build completed without a readable runtime session");
      const actualIds = new Set(actualSession.nodes.map((node) => node.id));
      const runtimeObservable = batch.operations.every((operation) => actualIds.has(operation.node));
      if (!runtimeObservable) {
        comparison = {
          before: editNodes,
          desired: editNodes,
          actual: actualSession.nodes,
          tolerance: 2,
          converged: false,
          checks: batch.operations.map((operation) => ({
            operationId: operation.id,
            node: operation.node,
            property: operation.operation === "resize" ? (operation.axis === "horizontal" ? "width" : "height") : operation.operation === "set_property" ? operation.property : operation.operation,
            desired: operation.operation === "resize" ? operation.to : operation.operation === "set_property" ? operation.value : "source change",
            actual: "Build passed; this page is not active in the runtime capture",
            delta: null,
            passed: null
          }))
        };
        summary = `${summary}\n\nUI Sync compiled the edit successfully. Runtime pixel comparison is unavailable because ${batch.pageName} is not the app's active launch route; review the editable structure before accepting.`.trim();
        break;
      }
      comparison = compareDesignStates(editNodes, batch.operations, actualSession.nodes);
      if (comparison.converged) break;
    }

    if (!comparison) throw new Error("No visual diff was produced");
    if (comparison.converged && geometryOperations.length > 0) {
      const secondary = await runSwiftUiDesignBuild({
        root: safeRoot,
        cacheDirectory: path.join(app.getPath("userData"), "design-build-secondary"),
        runtimeServer: swiftUiRuntimeServer,
        simulatorPreference: { preferTablet: true }
      });
      const secondaryMerged = mergeRuntimeSnapshot(project.screens, secondary.snapshot);
      const secondaryNodes = extractDesignNodes({ ...project, screens: secondaryMerged.screens });
      const primaryById = new Map(comparison.actual.map((node) => [node.id, node]));
      const secondaryById = new Map(secondaryNodes.map((node) => [node.id, node]));
      for (const operation of geometryOperations) {
        const primaryNode = primaryById.get(operation.node);
        const secondaryNode = secondaryById.get(operation.node);
        const primaryWidth = primaryNode?.frame.width ?? null;
        const secondaryWidth = secondaryNode?.frame.width ?? null;
        const canvasDelta = Math.abs((secondary.snapshot.environment?.viewport.width ?? 0) - (beforeSession.viewport?.width ?? 0));
        const scales = primaryWidth != null && secondaryWidth != null && (canvasDelta < 80 || Math.abs(secondaryWidth - primaryWidth) > comparison.tolerance);
        comparison.checks.push({
          operationId: operation.id,
          node: operation.node,
          property: "adaptive-layout",
          desired: "responds on a second canvas",
          actual: primaryWidth == null || secondaryWidth == null ? "node missing" : `${primaryWidth}pt → ${secondaryWidth}pt on ${secondary.snapshot.deviceName}`,
          delta: primaryWidth == null || secondaryWidth == null ? null : Math.round((secondaryWidth - primaryWidth) * 100) / 100,
          passed: scales
        });
      }
      comparison.converged = comparison.checks.every((check) => check.passed !== false);
    }

    const result = {
      state: "awaiting-review",
      branchName: checkpoint.branchName,
      iterations,
      converged: comparison.converged,
      changedFiles: [...changedFiles].sort(),
      checks: comparison.checks,
      summary
    };
    pendingDesignEdits.set(safeRoot, { checkpoint, result, metadataAfterCodex });
    return result;
  } catch (error) {
    if (checkpoint) {
      try { await abortDesignEditCheckpoint(checkpoint); } catch {}
    }
    throw error;
  }
}

const previewBoundsSchema = z.object({
  x: z.number().finite().min(0).max(20000),
  y: z.number().finite().min(0).max(20000),
  width: z.number().finite().min(0).max(20000),
  height: z.number().finite().min(0).max(20000)
});

/** Dev servers are keyed by project root so each project owns exactly one. */
const devServers = new Map();
let livePreview = null;

function isLocalPreviewUrl(candidate, allowedOrigin) {
  try {
    const url = new URL(candidate);
    if (url.origin === allowedOrigin) return true;
    if (!["http:", "https:", "ws:", "wss:"].includes(url.protocol)) return false;
    return ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
  } catch {
    return false;
  }
}

async function ensureDevServer(root) {
  if (path.resolve(root) === path.resolve(app.getAppPath())) {
    throw new Error("UI Sync cannot open a live preview of itself.");
  }
  const running = devServers.get(root);
  if (running && await probeUrl(running.url)) return running;
  devServers.delete(root);

  const started = await startDevServer(root);
  if (!started.ok) {
    const error = new Error(started.message);
    error.reason = started.reason;
    error.output = started.output ?? null;
    throw error;
  }
  // Never hand back the server rendering UI Sync's own window.
  const ownDevServer = process.env.UI_SYNC_DEV_SERVER_URL;
  if (ownDevServer && started.origin === new URL(ownDevServer).origin) {
    started.stop?.();
    throw new Error("That project's dev server could not be told apart from UI Sync's own dev server.");
  }
  const record = {
    url: started.url,
    origin: started.origin,
    command: started.command,
    attached: started.attached,
    stop: started.stop ?? null
  };
  devServers.set(root, record);
  return record;
}

function previewUrlForPath(origin, capturePath) {
  const url = new URL(origin);
  const target = typeof capturePath === "string" && capturePath ? capturePath : "/";
  if (target.startsWith("?")) url.search = target;
  else if (target.startsWith("#")) url.hash = target;
  else url.pathname = target.startsWith("/") ? target : `/${target}`;
  return url.toString();
}

function destroyLivePreview() {
  if (!livePreview) return;
  const { window, view } = livePreview;
  livePreview = null;
  try {
    if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    view.webContents.close();
  } catch {}
}

function createPreviewView(window, origin) {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      partition: `temporary:ui-sync-live-${randomBytes(12).toString("hex")}`
    }
  });
  const blockedHosts = new Set();
  const contents = view.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (!isLocalPreviewUrl(url, origin)) event.preventDefault();
  });
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    if (["data:", "blob:", "devtools:"].some((scheme) => details.url.startsWith(scheme))) {
      callback({ cancel: false });
      return;
    }
    const allowed = isLocalPreviewUrl(details.url, origin);
    if (!allowed) {
      try { blockedHosts.add(new URL(details.url).host); } catch {}
    }
    callback({ cancel: !allowed });
  });
  return { view, blockedHosts };
}

/**
 * The project's own page, shown instead of a capture of it.
 *
 * Everything stored about a page is an approximation of some size — the layer
 * tree has the boxes and the type but not the gradient, and even the captured
 * markup is missing whatever the capture could not reach. The project is still
 * on this machine, so for reading one page closely the honest thing is to serve
 * it and open the real page. Fonts, ::before, hover and animation are then
 * simply correct, because nothing is standing in for them.
 *
 * The capture is what remains for when this cannot be done: a folder that has
 * moved, an address that is no longer up, an app rather than a project, or a
 * handoff file opened on someone else's machine.
 */
let inventoryPreview = null;
// Bumped by every open and every close, so work started for one page can tell
// that it is no longer the page anyone is looking at. Starting a project's
// server takes seconds, and closing the page during those seconds used to leave
// a preview nobody asked for — a native view over the window and a server held
// open for the rest of the session.
let previewGeneration = 0;

function closeInventoryPreview() {
  previewGeneration += 1;
  if (!inventoryPreview) return;
  const { release, view, window } = inventoryPreview;
  inventoryPreview = null;
  try {
    if (!window.isDestroyed()) window.contentView.removeChildView(view);
    if (!view.webContents.isDestroyed()) view.webContents.close();
  } catch {}
  release?.();
}

/**
 * Replays the clicks that a page is reached by.
 *
 * Most pages are an address, but a fifth of them are somewhere behind a click —
 * a tab, a filter, a menu. The recipe is what the crawl recorded to get there,
 * so replaying it is what makes "open this page" mean the page and not the one
 * it happens to live on.
 */
async function replayRecipe(contents, recipe) {
  const missed = [];
  for (const step of recipe) {
    const clicked = await contents.executeJavaScript(`(() => {
      const element = document.querySelector(${JSON.stringify(step.locator)});
      if (!element) return false;
      element.scrollIntoView({ block: "center" });
      element.click();
      return true;
    })()`, true).catch(() => false);
    if (!clicked) {
      missed.push(step.label || step.locator);
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 420));
  }
  return missed;
}

function registerIpc() {
  ipcMain.handle("projects:list", () => listProjects());

  ipcMain.handle("preview:start", async (event, root, capturePath, bounds) => {
    const safeRoot = projectRootSchema.parse(root);
    const safeBounds = previewBoundsSchema.parse(bounds);
    const registry = await readRegistry();
    if (!registry.some((item) => item.root === safeRoot)) throw new Error("Project is not registered");

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) throw new Error("No window is available for the preview");

    const server = await ensureDevServer(safeRoot);
    destroyLivePreview();
    const { view, blockedHosts } = createPreviewView(window, server.origin);
    window.contentView.addChildView(view);
    view.setBounds({
      x: Math.round(safeBounds.x),
      y: Math.round(safeBounds.y),
      width: Math.round(safeBounds.width),
      height: Math.round(safeBounds.height)
    });
    livePreview = { root: safeRoot, view, window, origin: server.origin, blockedHosts };

    const target = previewUrlForPath(server.origin, capturePath);
    try {
      await view.webContents.loadURL(target);
    } catch (error) {
      destroyLivePreview();
      throw new Error(`The dev server did not serve ${target}: ${error instanceof Error ? error.message : "unknown error"}`);
    }
    return {
      url: target,
      origin: server.origin,
      command: server.command,
      attached: server.attached,
      blockedHosts: [...blockedHosts].slice(0, 20)
    };
  });

  ipcMain.handle("preview:set-bounds", (_event, bounds) => {
    if (!livePreview) return false;
    const safeBounds = previewBoundsSchema.parse(bounds);
    livePreview.view.setBounds({
      x: Math.round(safeBounds.x),
      y: Math.round(safeBounds.y),
      width: Math.round(safeBounds.width),
      height: Math.round(safeBounds.height)
    });
    return true;
  });

  ipcMain.handle("preview:navigate", async (_event, capturePath) => {
    if (!livePreview) throw new Error("No live preview is open");
    const target = previewUrlForPath(livePreview.origin, capturePath);
    await livePreview.view.webContents.loadURL(target);
    return { url: target, blockedHosts: [...livePreview.blockedHosts].slice(0, 20) };
  });

  ipcMain.handle("preview:reload", () => {
    if (!livePreview) return false;
    livePreview.view.webContents.reload();
    return true;
  });

  ipcMain.handle("preview:stop", () => {
    destroyLivePreview();
    return true;
  });

  ipcMain.handle("preview:status", async (_event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    const running = devServers.get(safeRoot);
    const resolved = await resolveDevCommand(safeRoot);
    return {
      running: Boolean(running),
      url: running?.url ?? null,
      command: resolved.ok ? resolved.command : null,
      attached: running?.attached ?? false,
      reason: resolved.ok ? null : resolved.reason,
      message: resolved.ok ? null : resolved.message
    };
  });

  ipcMain.handle("preview:stop-server", (_event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    if (livePreview?.root === safeRoot) destroyLivePreview();
    const running = devServers.get(safeRoot);
    devServers.delete(safeRoot);
    running?.stop?.();
    return true;
  });

  ipcMain.handle("inventory:choose-folder", async () => {
    // Files as well as folders, because macOS shows an installed app as a file:
    // with directories only, a .app cannot be picked at all — the one thing a
    // person with a build rather than a project has to offer.
    const chosen = await dialog.showOpenDialog({
      properties: ["openDirectory", "openFile"],
      title: "Choose a project folder or an app"
    });
    const picked = chosen.canceled ? null : chosen.filePaths[0] ?? null;
    if (!picked) return null;
    // Anything else picked as a file is not a project, and saying so here beats
    // registering it and failing during the scan.
    if (looksLikeAppBundle(picked)) return picked;
    const chosenIsFolder = await stat(picked).then((entry) => entry.isDirectory()).catch(() => false);
    return chosenIsFolder ? picked : null;
  });

  ipcMain.handle("inventory:scan-folder", async (event, root, workspaceRoot) => {
    const safeRoot = projectRootSchema.parse(root);
    // Set only when this package was picked out of a workspace the user
    // dropped, which is the relationship the sidebar nests by.
    const parent = workspaceRoot ? projectRootSchema.parse(workspaceRoot) : null;
    const id = targetId("folder", safeRoot);
    const send = (channel, value) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, { ...value, id });
    };
    // Register before scanning, not after: the project should appear in the
    // sidebar the moment it is dropped, so the wait is something to walk away
    // from rather than something to sit in front of.
    // An installed app is recognised by its icon, and it has one before it has
    // been scanned — so the row wears it from the moment it is dropped rather
    // than after the minutes a scan takes.
    await inventoryRegistry().remember("folder", safeRoot, {
      parent,
      icon: looksLikeAppBundle(safeRoot) ? await readAppIcon(safeRoot) : null
    });
    send("inventory:started", { kind: "folder", target: safeRoot });
    // Scanning UI Sync itself is the one project served this way. Every other
    // route to it produces a copy with no bridge and therefore no projects to
    // show; this one opens a window of its own interface with a preload that
    // only reads. See scanSelf.
    const scanning = { keepAnyway: await inventoryRegistry().kept(id),
      onStatus: (status) => send("inventory:status", status),
      onProgress: (state) => send("inventory:progress", { name: state.name, route: state.route, depth: state.depth }) };
    const scanned = path.resolve(safeRoot) === path.resolve(app.getAppPath())
      ? await scanSelf({ appRoot: safeRoot, ...scanning })
      : await scanFolder(safeRoot, { ...scanning, swift: await swiftScanOptions(safeRoot) });
    // An iOS scan carries its capture with it. The pages go to the renderer;
    // the capture is kept here, because that is what turns a page into Figma
    // layers later, and it is all absolute paths and runtime measurements.
    if (scanned.ok && scanned.capture) {
      await storeSwiftCapture(safeRoot, scanned.capture);
      delete scanned.capture;
    }
    // The folder is what was scanned; the port it was served on is an accident
    // of this run and must not be what the project is remembered as.
    const inventory = scanned.ok
      ? { ...scanned, source: { kind: "folder", target: safeRoot }, pages: await keepWanted(id, scanned.pages) }
      : scanned;
    // A workspace has nothing of its own to show, but its packages do, and the
    // sidebar should hold them the moment the folder is dropped rather than
    // only for as long as a picker is on screen.
    if (!inventory.ok && inventory.reason === "workspace") {
      for (const item of inventory.packages ?? []) {
        await inventoryRegistry().remember("folder", item.root, { parent: safeRoot });
      }
    }
    if (inventory.ok) {
      await inventoryRegistry().saveInventory("folder", safeRoot, inventory, { parent });
      // A folder that also holds projects gets them registered underneath it,
      // unscanned. Dropping a folder means "index what is in here", and the
      // sidebar should show that shape straight away rather than after the
      // user has hunted each one down separately.
      for (const item of inventory.packages ?? []) {
        await inventoryRegistry().remember("folder", item.root, { parent: safeRoot });
      }
    }
    send("inventory:finished", { ok: inventory.ok });
    return { ...inventory, id };
  });

  let recording = null;

  ipcMain.handle("inventory:record-start", async (event, target) => {
    const url = z.string().min(1).max(2000).parse(target);
    const normalized = normalizeTargetUrl(url);
    if (!normalized.ok) return { ok: false, message: normalized.message };
    recording?.close();
    recording = createRecordingSession(normalized.origin, {
      onCaptured: (page) => {
        if (!event.sender.isDestroyed()) event.sender.send("inventory:recorded", page);
      }
    });
    recording.window.on("closed", () => { recording = null; });
    await recording.open(normalized.startPath);
    return { ok: true, origin: normalized.origin };
  });

  ipcMain.handle("inventory:record-capture", async () => {
    if (!recording) return { ok: false, message: "No recording is running." };
    await recording.captureNow();
    return { ok: true, count: recording.pages.length };
  });

  ipcMain.handle("inventory:record-stop", async () => {
    if (!recording) return { ok: true, pages: [] };
    const pages = recording.pages;
    recording.close();
    recording = null;
    return { ok: true, pages };
  });

  /**
   * Walks one level further out from a single page and adds whatever is new to
   * the kept inventory. The pages already held are passed in so their addresses
   * are not walked again.
   */
  ipcMain.handle("inventory:explore-page", async (event, source, page, held) => {
    const where = z.object({ kind: z.enum(["folder", "url"]), target: z.string().min(1).max(2000) }).parse(source);
    const safePage = handoffPageSchema.parse(page);
    const known = z.array(z.object({
      id: z.string().max(200),
      route: z.string().max(2000),
      url: z.string().max(2000).optional()
    })).max(500).parse(held ?? []);
    const id = targetId(where.kind, where.target);
    const send = (detail, phase = "scanning") => {
      if (!event.sender.isDestroyed()) event.sender.send("inventory:status", { phase, detail, id });
    };

    send(`Looking past ${safePage.name}`, "starting");
    const job = (url) => exploreFromPage(url, safePage, {
      pages: known,
      onStatus: (status) => send(status.detail, status.phase),
      onProgress: (state) => {
        if (!event.sender.isDestroyed()) event.sender.send("inventory:progress", { name: state.name, route: state.route, depth: state.depth, id });
      }
    });
    // An installed app has no address and no dev server: it is opened, walked,
    // and closed again, the same way the scan that found the page did it.
    const outcome = where.kind === "url"
      ? await job(where.target)
      : looksLikeAppBundle(where.target)
        ? await exploreInApp(where.target, safePage, {
          pages: known,
          onStatus: (status) => send(status.detail, status.phase),
          onProgress: (state) => {
            if (!event.sender.isDestroyed()) event.sender.send("inventory:progress", { name: state.name, route: state.route, depth: state.depth, id });
          }
        })
        : await withProjectServer(where.target, { onStatus: (status) => send(status.detail, status.phase) }, job);
    if (!outcome.ok) return outcome;

    // Anything dropped before stays dropped, even when found down a new path.
    const found = await keepWanted(id, outcome.pages);
    const stored = await inventoryRegistry().loadInventory(id);
    if (stored?.ok && found.length > 0) {
      const seen = new Set(stored.pages.map((entry) => entry.id));
      await inventoryRegistry().updateInventory(id, {
        ...stored,
        pages: [...stored.pages, ...found.filter((entry) => !seen.has(entry.id))]
      });
    }
    return { ...outcome, pages: found };
  });

  /**
   * Drops one page from a project's inventory, for good. A later scan will find
   * it again and has to leave it out again, so the decision is kept rather than
   * the page merely being removed from what is on screen.
   */
  ipcMain.handle("inventory:drop-page", async (_event, source, pageId) => {
    const where = z.object({ kind: z.enum(["folder", "url"]), target: z.string().min(1).max(2000) }).parse(source);
    const safePageId = z.string().min(1).max(200).parse(pageId);
    const id = targetId(where.kind, where.target);
    await inventoryRegistry().drop(id, safePageId);
    const stored = await inventoryRegistry().loadInventory(id);
    if (stored?.ok) {
      await inventoryRegistry().updateInventory(id, {
        ...stored,
        pages: stored.pages.filter((entry) => entry.id !== safePageId)
      });
    }
    return { ok: true };
  });

  /**
   * Captures one page again. A URL target is already running and is used as
   * given; a folder has no address of its own, so the project is started for
   * the one capture and stopped afterwards.
   */
  ipcMain.handle("inventory:recapture", async (event, source, page) => {
    const where = z.object({ kind: z.enum(["folder", "url"]), target: z.string().min(1).max(2000) }).parse(source);
    const safePage = handoffPageSchema.parse(page);
    const send = (detail) => {
      if (!event.sender.isDestroyed()) event.sender.send("inventory:status", { phase: "capturing", detail, id: targetId(where.kind, where.target) });
    };

    send(`Capturing ${safePage.name} again`);
    const outcome = where.kind === "url"
      ? await recapturePage(where.target, safePage)
      : looksLikeAppBundle(where.target)
        ? await recaptureInApp(where.target, safePage, { onStatus: (status) => send(status.detail) })
        : await withProjectServer(where.target, { onStatus: (status) => send(status.detail) }, (url) => recapturePage(url, safePage));
    if (!outcome.ok) return outcome;

    // The stored inventory is what a reopened project shows, so the fresh page
    // has to replace the stale one there too, not only on screen.
    const id = targetId(where.kind, where.target);
    const stored = await inventoryRegistry().loadInventory(id);
    if (stored?.ok) {
      await inventoryRegistry().updateInventory(id, {
        ...stored,
        pages: stored.pages.map((entry) => (entry.id === outcome.page.id ? outcome.page : entry))
      });
    }
    return outcome;
  });

  /**
   * Puts back a page the crawl judged too small to be one.
   *
   * The threshold is 12% of the screen, and it is a judgement rather than a
   * fact: a tab that swaps a single number really is a page to whoever is
   * documenting the app. So the list of what was left out is not just a report,
   * it is a list of decisions that can be reversed — and the reversal is
   * remembered, because a scan applies the threshold every time and would
   * otherwise take the page away again on the next one.
   */
  ipcMain.handle("inventory:restore-filtered", async (event, source, item) => {
    const where = z.object({ kind: z.enum(["folder", "url"]), target: z.string().min(1).max(2000) }).parse(source);
    const safeItem = z.object({
      label: z.string().max(300),
      route: z.string().max(2000),
      recipe: z.array(z.object({
        kind: z.string().max(40).optional(),
        locator: z.string().max(2000),
        label: z.string().max(300)
      })).min(1).max(20)
    }).parse(item);

    const id = targetId(where.kind, where.target);
    const send = (detail) => {
      if (!event.sender.isDestroyed()) event.sender.send("inventory:status", { phase: "capturing", detail, id });
    };

    // The same identity the crawl would have given it, so the exception matches
    // the page a later scan produces rather than a lookalike of it.
    const recipe = safeItem.recipe.map((step) => ({ kind: step.kind ?? "click", label: step.label, locator: step.locator }));
    const page = {
      id: identityOf(safeItem.route, recipe),
      name: safeItem.label || safeItem.route,
      route: safeItem.route,
      recipe,
      depth: recipe.length,
      signature: "",
      url: "",
      thumbnail: null,
      variants: []
    };

    send(`把「${page.name}」加回来`);
    const outcome = where.kind === "url"
      ? await recapturePage(where.target, page)
      : looksLikeAppBundle(where.target)
        ? await recaptureInApp(where.target, page, { onStatus: (status) => send(status.detail) })
        : await withProjectServer(where.target, { onStatus: (status) => send(status.detail) }, (url) => recapturePage(url, page));
    if (!outcome.ok) return outcome;

    await inventoryRegistry().keep(id, page.id);
    const stored = await inventoryRegistry().loadInventory(id);
    if (stored?.ok) {
      await inventoryRegistry().updateInventory(id, {
        ...stored,
        pages: [...stored.pages.filter((entry) => entry.id !== outcome.page.id), outcome.page],
        filtered: (stored.filtered ?? []).filter((entry) => !(entry.route === safeItem.route && entry.label === safeItem.label))
      });
    }
    return outcome;
  });

  ipcMain.handle("inventory:send-to-figma", async (event, inventory, figmaUrl) => {
    if (!figmaBridge) throw new Error("The local Figma bridge is not running");
    const link = parseFigmaDesignUrl(z.string().min(1).max(2000).parse(figmaUrl));
    if (!link) return { ok: false, message: "That is not a Figma design URL." };

    // Pictures are stored once by content and referred to, which the plugin
    // knows nothing about — so they go back inline for the trip to Figma.
    const parsed = await internalise(handoffInventorySchema.parse(inventory), inventoryRegistry().assets);
    // One identity for the project, whatever served it this time: the folder or
    // the address the user gave, which is also what the sidebar remembers it
    // by. A folder served on a fresh port every scan would otherwise be a new
    // project each time — new baseline, new frames beside the old ones.
    const kind = parsed.source?.kind ?? (parsed.origin?.startsWith("http") ? "url" : "folder");
    const target = parsed.source?.target ?? parsed.origin ?? "";

    // A page the plugin has already drawn is sent back to its own frame. The
    // renderer holds the scan, not what became of it, so the frames are read
    // from what the last push recorded.
    const known = (await inventoryRegistry().loadFigmaBaseline(targetId(kind, target)))?.frames ?? {};

    // An iOS page reaches Figma as its exported page — the rendered PDF as
    // vectors, with only reliably matched native layers restored on top —
    // rather than as a captured layer tree.
    const built = parsed.pages.some((page) => page.vector?.pageId)
      ? await buildSwiftInventoryJob(parsed, {
        kind,
        target,
        figmaFileName: link.fileName,
        frames: known,
        onProgress: (state) => {
          if (!event.sender.isDestroyed()) event.sender.send("inventory:figma-progress", state);
        }
      })
      : buildFigmaJob(parsed, {
        identity: `${kind}:${target}`,
        projectName: nameFor(kind, target),
        figmaFileName: link.fileName
      });
    if (!built.ok) return built;

    for (const screen of built.job.screens) {
      screen.currentNodeId = screen.currentNodeId ?? known[screen.id]?.nodeId ?? null;
    }

    // What is being sent becomes the baseline a later pull compares against.
    // flattenEditableDom is the same reader the original pull path uses, so
    // both directions agree on what a node's properties are. An exported iOS
    // page has no DOM to read: its baseline is the PDF it came from.
    const baselines = Object.fromEntries(
      built.job.screens
        .filter((screen) => screen.domTree)
        .map((screen) => [screen.id, flattenEditableDom(screen.domTree)])
    );
    const inventoryId = await inventoryRegistry().saveFigmaBaseline(kind, target, baselines, { fileKey: link.fileKey });

    const connection = await ensureDeviceConnection();
    let session;
    try {
      session = figmaBridge.enqueue(
        built.job,
        { root: target, inventoryId, figmaFileKey: link.fileKey, connectionToken: connection.token },
        connection.token,
        built.assets ?? new Map()
      );
    } catch (cause) {
      // A page that captured fine can still hold one value the bridge refuses,
      // and the whole export then failed as a wall of validator output with a
      // path forty levels deep. Say which property, on which page, and what it
      // was — the rest of that output helps nobody.
      return { ok: false, message: describeRejectedJob(cause, built.job) };
    }
    return {
      ok: true,
      ...session,
      requiresPairing: !connection.confirmed,
      fileName: link.fileName,
      // The window has only the pasted URL; the key is what opens the file
      // again from the dialog, and it is parsed here rather than twice.
      fileKey: link.fileKey,
      // Named so the caller can say what will not arrive, rather than letting
      // a short export look complete.
      missing: built.missing,
      missingReasons: built.missingReasons,
      dropped: built.dropped,
      substitutedFonts: built.substitutedFonts
    };
  });

  ipcMain.handle("inventory:figma-status", async (_event, pairingCode) => {
    if (!figmaBridge) throw new Error("The local Figma bridge is not running");
    return figmaBridge.getStatus(pairingCodeSchema.parse(pairingCode));
  });

  ipcMain.handle("inventory:preview-open", async (event, id, page, bounds) => {
    const safeId = z.string().regex(/^[a-f0-9]{16}$/).parse(id);
    const safeBounds = previewBoundsSchema.parse(bounds);
    const safePage = z.object({
      route: z.string().max(2000),
      recipe: z.array(z.object({ locator: z.string().max(2000), label: z.string().max(300) })).max(20)
    }).parse(page);

    const entry = (await inventoryRegistry().list()).find((item) => item.id === safeId);
    if (!entry) return { ok: false, message: "这个项目已经不在列表里了。" };
    // An installed app is not something to serve: the pages came out of a
    // Chromium that was launched, not a folder that can be handed to a server.
    if (entry.kind === "folder" && entry.target.toLowerCase().endsWith(".app")) {
      return { ok: false, message: "这是一个装好的 app，不是可以起服务的项目。" };
    }
    if (entry.kind === "folder" && !(await access(entry.target).then(() => true).catch(() => false))) {
      return { ok: false, message: "这个文件夹不在原来的位置了。" };
    }

    const window = BrowserWindow.fromWebContents(event.sender);
    if (!window) return { ok: false, message: "没有可以放预览的窗口。" };
    closeInventoryPreview();
    const generation = previewGeneration;

    let origin;
    let release = null;
    try {
      if (entry.kind === "url") {
        // normalizeTargetUrl answers with a result, not a string. Handed to
        // `new URL` it stringified to "[object Object]" and threw, so opening
        // the real page never once worked for a scanned address — it fell
        // silently back to the capture, which is exactly the failure that is
        // hardest to notice.
        const normalized = normalizeTargetUrl(entry.target);
        if (!normalized.ok) return { ok: false, message: normalized.message };
        origin = normalized.origin;
      } else {
        const held = holdServer(entry.target, { run: withProjectServer });
        release = held.release;
        origin = await held.ready;
      }
    } catch (cause) {
      release?.();
      return { ok: false, message: cause instanceof Error ? cause.message : "这个项目起不来。" };
    }
    if (generation !== previewGeneration || window.isDestroyed()) {
      release?.();
      return { ok: false, message: "预览已经关掉了。" };
    }

    const { view, blockedHosts } = createPreviewView(window, origin);
    window.contentView.addChildView(view);
    view.setBounds({
      x: Math.round(safeBounds.x), y: Math.round(safeBounds.y),
      width: Math.round(safeBounds.width), height: Math.round(safeBounds.height)
    });
    inventoryPreview = { blockedHosts, id: safeId, origin, release, view, window };

    let target;
    try {
      target = new URL(safePage.route || "/", origin).toString();
      await view.webContents.loadURL(target);
    } catch (cause) {
      // Only if this is still the open preview: closing during the load has
      // already torn it down, and tearing down the next one would be wrong.
      if (generation === previewGeneration) closeInventoryPreview();
      return { ok: false, message: `打不开 ${target ?? entry.target}：${cause instanceof Error ? cause.message : "未知错误"}` };
    }
    if (generation !== previewGeneration) return { ok: false, message: "预览已经关掉了。" };
    const missed = safePage.recipe.length > 0 ? await replayRecipe(view.webContents, safePage.recipe) : [];
    return { ok: true, missed, url: target };
  });

  ipcMain.handle("inventory:preview-bounds", (_event, bounds) => {
    if (!inventoryPreview) return false;
    const safeBounds = previewBoundsSchema.parse(bounds);
    inventoryPreview.view.setBounds({
      x: Math.round(safeBounds.x), y: Math.round(safeBounds.y),
      width: Math.round(safeBounds.width), height: Math.round(safeBounds.height)
    });
    return true;
  });

  ipcMain.handle("inventory:preview-close", () => {
    closeInventoryPreview();
    return true;
  });

  ipcMain.handle("inventory:export", async (_event, inventory, title) => {
    const safeTitle = z.string().min(1).max(120).optional().parse(title) ?? "Design handoff";
    // An exported page is opened elsewhere, so it carries its pictures with it.
    const parsed = await internalise(handoffInventorySchema.parse(inventory), inventoryRegistry().assets);
    const suggested = `${safeTitle.replace(/[^\w\u4e00-\u9fa5-]+/g, "-").replace(/^-+|-+$/g, "") || "handoff"}.html`;
    const target = await dialog.showSaveDialog({
      title: "Save handoff page",
      defaultPath: path.join(app.getPath("documents"), suggested),
      filters: [{ name: "HTML", extensions: ["html"] }]
    });
    if (target.canceled || !target.filePath) return { saved: false };
    await writeFile(target.filePath, await renderHandoffPage(parsed, { title: safeTitle }), "utf8");
    return { saved: true, filePath: target.filePath };
  });

  ipcMain.handle("inventory:reveal", async (_event, filePath) => {
    const safePath = z.string().min(1).refine(path.isAbsolute).parse(filePath);
    shell.showItemInFolder(safePath);
  });

  ipcMain.handle("inventory:targets", async () => inventoryRegistry().grouped());

  ipcMain.handle("inventory:open", async (_event, id) => {
    const safeId = z.string().regex(/^[a-f0-9]{16}$/).parse(id);
    return inventoryRegistry().loadInventory(safeId);
  });

  ipcMain.handle("inventory:forget", async (_event, id) => {
    await inventoryRegistry().forget(z.string().regex(/^[a-f0-9]{16}$/).parse(id));
    return inventoryRegistry().grouped();
  });

  /**
   * Scans the app already running behind a debugging port. Remembered as a
   * target in its own right: the same app served renderer-only and the same app
   * attached to are different scans of different content, and merging them
   * would let an empty shell overwrite a real inventory.
   */
  ipcMain.handle("inventory:scan-attached", async (event, port) => {
    const safePort = z.number().int().min(1).max(65535).parse(port);
    // The port is how the app was reached this time, not what it is: tomorrow
    // 9222 may be something else entirely, and the same app started again is
    // the same project. So the window is asked what it is showing, and the
    // address it serves names it — distinct from a plain scan of that address,
    // which reaches the same app without the data behind it.
    let windows = [];
    try {
      windows = await listTargets(safePort);
    } catch {}
    if (windows.length === 0) {
      return {
        ok: false,
        message: `Nothing is listening for a debugger on port ${safePort}. Start the app with --remote-debugging-port=${safePort}, then try again.`
      };
    }
    let origin;
    try {
      origin = new URL(windows[0].url).origin;
    } catch {
      return { ok: false, message: `That window is showing ${windows[0].url || "nothing"}, which cannot be scanned.` };
    }
    const target = `attached:${origin}`;
    const id = targetId("url", target);
    const send = (channel, value) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, { ...value, id });
    };
    await inventoryRegistry().remember("url", target);
    send("inventory:started", { kind: "url", target });
    const scanned = await scanAttached(safePort, {
      targetId: windows[0].id,
      keepAnyway: await inventoryRegistry().kept(id),
      onStatus: (status) => send("inventory:status", status),
      onProgress: (state) => send("inventory:progress", { name: state.name, route: state.route, depth: state.depth })
    });
    const inventory = scanned.ok
      ? { ...scanned, source: { kind: "url", target }, pages: await keepWanted(id, scanned.pages) }
      : scanned;
    if (inventory.ok) await inventoryRegistry().saveInventory("url", target, inventory);
    send("inventory:finished", { ok: inventory.ok });
    return { ...inventory, id };
  });

  ipcMain.handle("inventory:debug-windows", async (_event, port) => {
    const safePort = z.number().int().min(1).max(65535).parse(port);
    try {
      return { ok: true, windows: await listTargets(safePort) };
    } catch {
      return { ok: false, windows: [] };
    }
  });

  ipcMain.handle("inventory:scan", async (event, url, seedPaths) => {
    const target = z.string().min(1).max(2000).parse(url);
    const seeds = z.array(z.string().max(2000)).max(200).optional().parse(seedPaths) ?? [];
    const id = targetId("url", target);
    const send = (channel, value) => {
      if (!event.sender.isDestroyed()) event.sender.send(channel, { ...value, id });
    };
    await inventoryRegistry().remember("url", target);
    send("inventory:started", { kind: "url", target });
    const scanned = await scanUrl(target, {
      keepAnyway: await inventoryRegistry().kept(id),
      seedPaths: seeds,
      onProgress: (state) => send("inventory:progress", { name: state.name, route: state.route, depth: state.depth })
    });
    // The address as typed, which is what the sidebar remembers — the scan
    // normalizes it to an origin and a start path.
    const inventory = scanned.ok
      ? { ...scanned, source: { kind: "url", target }, pages: await keepWanted(id, scanned.pages) }
      : scanned;
    if (inventory.ok) await inventoryRegistry().saveInventory("url", target, inventory);
    send("inventory:finished", { ok: inventory.ok });
    return { ...inventory, id };
  });

  ipcMain.handle("projects:previews", async (_event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    const registry = await readRegistry();
    const registered = registry.find((item) => item.root === safeRoot);
    if (!registered) throw new Error("Project is not registered");
    const project = await inspectProject(safeRoot, registered);
    if (project.kind === "swiftui") return [];
    const screens = project.screens.filter((screen) => screen.sourceType !== "component");
    if (screens.length === 0) return [];
    const captures = await captureApplicationScreens(safeRoot, screens, { includeScreenshots: true });
    return z.array(projectPreviewSchema).max(60).parse(screens.map((screen) => {
      const capture = captures.get(screen.id);
      return {
        screenId: screen.id,
        screenshotDataUrl: capture.screenshotDataUrl,
        width: capture.width,
        height: capture.height
      };
    }));
  });

  ipcMain.handle("projects:add", async (_event, expectedKind) => {
    const safeExpectedKind = expectedProjectKindSchema.parse(expectedKind);
    const result = await dialog.showOpenDialog({
      title:
        safeExpectedKind === "web"
          ? "Connect a website project"
          : safeExpectedKind === "swiftui"
            ? "Connect SwiftUI projects"
            : "Connect Electron projects",
      properties: ["openDirectory", "multiSelections"]
    });
    if (result.canceled || result.filePaths.length === 0) return [];

    const roots = z.array(projectRootSchema).min(1).max(12).parse(result.filePaths);
    try {
      const projects = await inspectAndRegisterProjectFolders(roots, safeExpectedKind);
      if (projects.length > 0) return projects;
      throw new Error("No independently runnable application package was detected");
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Unknown project inspection error";
      await dialog.showMessageBox({
        type: "warning",
        title: "This project is not connected yet",
        message: "No supported UI project was found in this folder.",
        detail: `Choose a folder containing one or more runnable application packages.\n\nTechnical detail: ${reason.slice(0, 1200)}`
      });
      return [];
    }
  });

  ipcMain.handle("projects:refresh", async (_event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    const registry = await readRegistry();
    const registered = registry.find((item) => item.root === safeRoot);
    if (!registered) throw new Error("Project is not registered");
    if (await pathExists(path.join(safeRoot, ".ui-sync", "state.json"))) {
      return loadProject(safeRoot, registered);
    }
    return inspectProject(safeRoot, registered);
  });

  ipcMain.handle("projects:design-build", async (_event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    return performSwiftUiDesignBuild(safeRoot);
  });

  ipcMain.handle("projects:design-session", async (_event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    return createSwiftUiDesignSession(safeRoot);
  });

  ipcMain.handle("projects:visual-edit", async (event, root, batch) => {
    const safeRoot = projectRootSchema.parse(root);
    return performSwiftUiVisualEdit(event, safeRoot, batch);
  });

  ipcMain.handle("projects:visual-edit-resolve", async (_event, root, resolution) => {
    const safeRoot = projectRootSchema.parse(root);
    const safeResolution = z.enum(["accept", "reject"]).parse(resolution);
    const pending = pendingDesignEdits.get(safeRoot);
    if (!pending) throw new Error("There is no visual edit awaiting review");
    await resolveDesignEditCheckpoint(pending.checkpoint, safeResolution);
    pendingDesignEdits.delete(safeRoot);
  });

  ipcMain.handle("projects:inspect-dropped", async (_event, roots) => {
    const safeRoots = z.array(projectRootSchema).min(1).max(12).parse(roots);
    return inspectAndRegisterProjectFolders(safeRoots);
  });

  ipcMain.handle("projects:connect-figma", async (_event, root, figmaUrl) => {
    const safeRoot = projectRootSchema.parse(root);
    const parsed = parseFigmaDesignUrl(figmaUrl, false);
    const registry = await readRegistry();
    const index = registry.findIndex((item) => item.root === safeRoot);
    if (index < 0) throw new Error("Project is not registered");
    const current = registry[index];
    const fileChanged = current.figmaFileKey !== parsed.fileKey;
    const nextEntry = {
      ...current,
      figmaFileName: parsed.fileName,
      figmaFileKey: parsed.fileKey,
      figmaNodeId: parsed.nodeId ?? undefined,
      figmaMappings: fileChanged ? {} : current.figmaMappings,
      visualBaselines: fileChanged ? undefined : current.visualBaselines
    };
    const nextRegistry = [...registry];
    nextRegistry[index] = nextEntry;
    await writeRegistry(nextRegistry);
    return inspectProject(safeRoot, nextEntry);
  });

  ipcMain.handle("projects:map-screen", async (_event, root, screenId, figmaUrl) => {
    const safeRoot = projectRootSchema.parse(root);
    const safeScreenId = screenIdSchema.parse(screenId);
    const parsed = parseFigmaDesignUrl(figmaUrl, true);
    const registry = await readRegistry();
    const index = registry.findIndex((item) => item.root === safeRoot);
    if (index < 0) throw new Error("Project is not registered");
    const current = registry[index];
    if (!current.figmaFileKey) throw new Error("Choose a Figma file first");
    if (current.figmaFileKey !== parsed.fileKey) throw new Error("Use a frame from the connected Figma file");
    const project = await inspectProject(safeRoot, current);
    if (!project.screens.some((screen) => screen.id === safeScreenId)) {
      throw new Error("This SwiftUI page is no longer present");
    }
    const nextEntry = {
      ...current,
      figmaMappings: {
        ...(current.figmaMappings ?? {}),
        [safeScreenId]: {
          nodeId: parsed.nodeId,
          frameName: `Frame ${parsed.nodeId}`
        }
      }
    };
    const nextRegistry = [...registry];
    nextRegistry[index] = nextEntry;
    await writeRegistry(nextRegistry);
    return inspectProject(safeRoot, nextEntry);
  });

  ipcMain.handle("projects:auto-map", async (_event, root, unsafeTargetId) => {
    if (!figmaBridge) throw new Error("The local Figma bridge is not running");
    const safeRoot = projectRootSchema.parse(root);
    const registry = await readRegistry();
    const current = registry.find((item) => item.root === safeRoot);
    if (!current?.figmaFileKey || !current.figmaFileName) throw new Error("Choose a Figma file first");
    const deviceConnection = await ensureDeviceConnection();
    const requiresPairing = !deviceConnection.confirmed;
    const project = await inspectProject(safeRoot, current);
    const discoveredScreens = project.screens.filter((screen) => screen.sourceType !== "component");
    const runtimeScreen = discoveredScreens.find((screen) => screen.runtimeCapture?.isVisualReference);
    let selectedPdfPage = null;
    let selectedSourceScreen = null;
    let pageVector = null;
    if (project.kind === "swiftui") {
      if (!current.swiftRuntimePdf) throw new Error(current.swiftRuntimeVectorMessage || "Export the iOS project to PDF before importing a page into Figma.");
      const pdfPageId = z.string().regex(/^pdf-page-\d+$/).parse(unsafeTargetId);
      selectedPdfPage = current.swiftRuntimePdf.pages.find((page) => page.id === pdfPageId);
      if (!selectedPdfPage) throw new Error("That PDF page is no longer available. Export the project again.");
      selectedSourceScreen = discoveredScreens.find((screen) => screen.id === selectedPdfPage.sourceScreenId) ?? runtimeScreen ?? discoveredScreens[0] ?? null;
      if (selectedSourceScreen && selectedPdfPage.renderSource === "image-renderer" && selectedPdfPage.contentFrame) {
        selectedSourceScreen = {
          ...selectedSourceScreen,
          runtimeCapture: selectedSourceScreen.runtimeCapture
            ? { ...selectedSourceScreen.runtimeCapture, isVisualReference: false }
            : selectedSourceScreen.runtimeCapture,
          uiTree: normalizeSwiftTreeForPdfPage(
            selectedSourceScreen.uiTree,
            selectedPdfPage.contentFrame,
            { width: selectedPdfPage.width, height: selectedPdfPage.height }
          )
        };
      }
      const svgDirectory = path.join(
        path.dirname(current.swiftRuntimePdf.path),
        "figma-pages",
        createHash("sha256").update(safeRoot).digest("hex").slice(0, 16)
      );
      await mkdir(svgDirectory, { recursive: true });
      const svgPath = path.join(svgDirectory, `${selectedPdfPage.id}.svg`);
      const sourceTexts = [];
      const collectSourceTexts = (node) => {
        if (!node || typeof node !== "object") return;
        if (typeof node.text === "string" && node.text.trim()) sourceTexts.push(node.text.trim());
        for (const child of node.children ?? []) collectSourceTexts(child);
      };
      if (selectedSourceScreen) collectSourceTexts(selectedSourceScreen.uiTree);
      const capturedRuntimeTextFrames = [];
      const collectCapturedRuntimeText = (node) => {
        if (!node || typeof node !== "object") return;
        if (node.runtimeTextCaptured === true && node.runtimeFrame?.width > 0 && node.runtimeFrame?.height > 0 && typeof node.text === "string" && node.text.length > 0) {
          capturedRuntimeTextFrames.push(node.runtimeFrame);
        }
        for (const child of node.children ?? []) collectCapturedRuntimeText(child);
      };
      if (selectedSourceScreen) collectCapturedRuntimeText(selectedSourceScreen.uiTree);
      const extractedText = selectedPdfPage.renderSource === "image-renderer"
        ? await extractPdfTextRuns(selectedPdfPage.pdfPath ?? current.swiftRuntimePdf.path, {
          pageNumber: selectedPdfPage.pdfPageNumber ?? selectedPdfPage.pageNumber,
          width: selectedPdfPage.width,
          height: selectedPdfPage.height,
          sourceTexts
        }).catch(() => null)
        : null;
      const hasCompleteEditableText = Boolean(extractedText?.complete && extractedText.runs.length > 0);
      const textCleanValidation = selectedPdfPage.renderSource === "window-fallback"
        && selectedPdfPage.textCleanPdfPath
        && capturedRuntimeTextFrames.length > 0
        ? await isTextCleanPdfSafe({
          normalPdfPath: selectedPdfPage.pdfPath ?? current.swiftRuntimePdf.path,
          normalPageNumber: selectedPdfPage.pdfPageNumber ?? selectedPdfPage.pageNumber,
          cleanPdfPath: selectedPdfPage.textCleanPdfPath,
          frames: capturedRuntimeTextFrames,
          viewport: current.swiftRuntimeSnapshot?.environment?.viewport ?? { x: 0, y: 0, width: selectedPdfPage.width, height: selectedPdfPage.height }
        })
        : { safe: false };
      const hasCapturedRuntimeText = Boolean(
        selectedPdfPage.renderSource === "window-fallback"
        && selectedPdfPage.textCleanPdfPath
        && textCleanValidation.safe
      );
      const sourcePdfPath = selectedPdfPage.pdfPath ?? current.swiftRuntimePdf.path;
      const coordinateSpace = selectedPdfPage.contentFrame
        ? { ...selectedPdfPage.contentFrame, outputWidth: selectedPdfPage.width, outputHeight: selectedPdfPage.height }
        : current.swiftRuntimeSnapshot?.environment?.viewport
          ? { ...current.swiftRuntimeSnapshot.environment.viewport, outputWidth: selectedPdfPage.width, outputHeight: selectedPdfPage.height }
          : null;
      const vectorEffects = selectedPdfPage.cleanPdfPath && current.swiftRuntimeSnapshot
        ? resolveCapturedSwiftVectorEffects(selectedPdfPage.nativeEffects ?? [], current.swiftRuntimeSnapshot, selectedPdfPage.sourceName, coordinateSpace)
        : [];
      const sourceImages = current.swiftRuntimeSnapshot
        ? await resolveSwiftSourceImages(safeRoot, current.swiftRuntimeSnapshot, selectedPdfPage.sourceName, coordinateSpace)
        : [];
      const vectorPdfPath = hasCapturedRuntimeText
        ? selectedPdfPage.textCleanPdfPath
        : vectorEffects.length > 0
          ? selectedPdfPage.cleanPdfPath
          : sourcePdfPath;
      const vectorPageNumber = hasCapturedRuntimeText ? 1 : selectedPdfPage.pdfPageNumber ?? selectedPdfPage.pageNumber;
      await convertPdfToFigmaSvg(vectorPdfPath, svgPath, {
        pageNumber: vectorPageNumber,
        stripTextGlyphs: hasCompleteEditableText,
        sourceImages
      });
      const nativeShadowPlan = prepareNativeSvgShadows(await readFile(svgPath, "utf8"));
      if (nativeShadowPlan.shadows.length > 0) await writeFile(svgPath, nativeShadowPlan.svg, "utf8");
      let semanticFallbackSvg = null;
      if (vectorEffects.length > 0 || hasCapturedRuntimeText) {
        const fallbackPath = path.join(svgDirectory, `${selectedPdfPage.id}-visual-fallback.svg`);
        await convertPdfToFigmaSvg(sourcePdfPath, fallbackPath, {
          pageNumber: selectedPdfPage.pdfPageNumber ?? selectedPdfPage.pageNumber,
          stripTextGlyphs: hasCompleteEditableText,
          sourceImages
        });
        semanticFallbackSvg = await readFile(fallbackPath, "utf8");
      }
      pageVector = {
        svgPath,
        textMode: hasCapturedRuntimeText ? "editable-runtime" : hasCompleteEditableText ? "editable-pdf" : "pdf-glyphs",
        textRuns: hasCompleteEditableText ? extractedText.runs : [],
        fallbackSvg: semanticFallbackSvg ?? nativeShadowPlan.fallbackSvg,
        nativeShadows: nativeShadowPlan.shadows,
        vectorEffects
      };
    }
    const selectedScreenId = project.kind === "swiftui" || unsafeTargetId === undefined
      ? null
      : screenIdSchema.parse(unsafeTargetId);
    const screens = project.kind === "swiftui" && selectedSourceScreen && selectedPdfPage
      ? [{ ...selectedSourceScreen, id: selectedPdfPage.id, name: selectedPdfPage.name, figmaNodeId: current.figmaMappings?.[selectedPdfPage.id]?.nodeId ?? null }]
      : selectedScreenId
        ? discoveredScreens.filter((screen) => screen.id === selectedScreenId)
        : discoveredScreens;
    if (selectedScreenId && screens.length === 0) throw new Error("That rendered screen is no longer available. Refresh the project and try again.");
    if (screens.length === 0) {
      const typeSummary = project.screens.reduce((summary, screen) => {
        summary[screen.sourceType] = (summary[screen.sourceType] || 0) + 1;
        return summary;
      }, {});
      throw new Error(`No application screens were found for ${project.name} at ${safeRoot}. Scanned ${project.screens.length} views (${JSON.stringify(typeSummary)}).`);
    }
    const captures = project.kind === "swiftui" ? null : await captureApplicationScreens(safeRoot, screens);
    const swiftVisualPayloads = new Map();
    const swiftVisualAssets = new Map();
    if (project.kind === "swiftui") {
      for (const screen of screens) {
        let payload = { uiTree: screen.uiTree, assets: new Map(), visualReferenceAssetId: null, vectorSvg: null, vectorFallbackSvg: null, vectorNativeShadows: [], vectorEffects: [], vectorTextMode: null, vectorTextRuns: [] };
        payload = await buildSwiftVisualPayload(screen, current.swiftRuntimeScreenshot ?? null, { vector: pageVector });
        if (pageVector?.svgPath && !payload.vectorSvg) throw new Error(`The ${screen.name} PDF vector could not be prepared for Figma.`);
        swiftVisualPayloads.set(screen.id, payload);
        for (const [assetId, asset] of payload.assets) swiftVisualAssets.set(assetId, asset);
      }
    }
    const visualBaselines = captures
      ? Object.fromEntries(screens.map((screen) => [screen.id, flattenEditableDom(captures.get(screen.id).tree)]))
      : null;
    const projectId = createHash("sha256").update(safeRoot).digest("hex").slice(0, 24);
    const session = figmaBridge.enqueue({
      projectId,
      projectName: project.name,
      figmaFileName: current.figmaFileName,
      screens: screens.map((screen) => {
        if (project.kind === "swiftui") {
          const visualPayload = swiftVisualPayloads.get(screen.id);
          return {
            id: screen.id,
            name: screen.name,
            sourceType: screen.sourceType,
            currentNodeId: screen.figmaNodeId ?? null,
            renderMode: "structured",
            uiTree: figmaSwiftTree(visualPayload?.uiTree ?? screen.uiTree),
            visualReferenceAssetId: visualPayload?.visualReferenceAssetId ?? null,
            vectorSvg: visualPayload?.vectorSvg ?? null,
            vectorFallbackSvg: visualPayload?.vectorFallbackSvg ?? null,
            vectorNativeShadows: visualPayload?.vectorNativeShadows ?? [],
            vectorEffects: visualPayload?.vectorEffects ?? [],
            vectorTextMode: visualPayload?.vectorTextMode ?? null,
            vectorTextRuns: visualPayload?.vectorTextRuns ?? [],
            systemTabBar: selectedPdfPage?.systemTabBar
              ? {
                designKit: selectedPdfPage.systemTabBar.designKit,
                appearance: selectedPdfPage.systemTabBar.appearance,
                selectedIndex: selectedPdfPage.systemTabBar.selectedIndex,
                items: selectedPdfPage.systemTabBar.items.map(({ title, systemImage }) => ({ title, systemImage }))
              }
              : null,
            semanticAutoLayout: false
          };
        }
        const capture = captures.get(screen.id);
        if (!capture) throw new Error(`Could not capture ${screen.name}`);
        return {
          id: screen.id,
          name: screen.name,
          sourceType: screen.sourceType,
          currentNodeId: screen.figmaNodeId ?? null,
          renderMode: "editable-dom",
          width: capture.width,
          height: capture.height,
          domTree: capture.tree
        };
      })
    }, {
      root: safeRoot,
      figmaFileKey: current.figmaFileKey,
      connectionToken: deviceConnection.token,
      visualBaselines
    }, deviceConnection.token, project.kind === "swiftui" ? swiftVisualAssets : new Map());
    return { ...session, requiresPairing };
  });

  ipcMain.handle("projects:pull", async (_event, root) => {
    if (!figmaBridge) throw new Error("The local Figma bridge is not running");
    const safeRoot = projectRootSchema.parse(root);
    const registry = await readRegistry();
    const current = registry.find((item) => item.root === safeRoot);
    if (!current?.figmaFileKey || !current.figmaFileName) throw new Error("Choose a Figma file first");
    if (!current.visualBaselines) throw new Error("Sync to Figma once to establish an editable baseline");
    const project = await inspectProject(safeRoot, current);
    const screens = project.screens.filter((screen) => screen.sourceType !== "component");
    const captures = project.kind === "swiftui" ? null : await captureApplicationScreens(safeRoot, screens);
    const codeScreens = project.kind === "swiftui"
      ? buildSwiftCodeScreens(current.visualBaselines, screens)
      : Object.fromEntries(screens.map((screen) => [screen.id, flattenEditableDom(captures.get(screen.id).tree)]));
    const screenNames = Object.fromEntries(screens.map((screen) => [screen.id, screen.name]));
    const deviceConnection = await ensureDeviceConnection();
    const requiresPairing = !deviceConnection.confirmed;
    const projectId = createHash("sha256").update(safeRoot).digest("hex").slice(0, 24);
    const session = figmaBridge.enqueue({
      operation: "pull",
      projectId,
      projectName: project.name,
      figmaFileName: current.figmaFileName,
      screens: screens.map((screen) => {
        if (project.kind === "swiftui") {
          return {
            id: screen.id,
            name: screen.name,
            sourceType: screen.sourceType,
            currentNodeId: screen.figmaNodeId ?? null,
            renderMode: "structured",
            uiTree: figmaSwiftTree(screen.uiTree)
          };
        }
        const capture = captures.get(screen.id);
        return {
          id: screen.id,
          name: screen.name,
          sourceType: screen.sourceType,
          currentNodeId: screen.figmaNodeId ?? null,
          renderMode: "editable-dom",
          width: capture.width,
          height: capture.height,
          domTree: capture.tree
        };
      })
    }, {
      operation: "pull",
      projectKind: project.kind,
      root: safeRoot,
      figmaFileKey: current.figmaFileKey,
      connectionToken: deviceConnection.token,
      codeScreens,
      screenNames
    }, deviceConnection.token);
    return { ...session, requiresPairing };
  });

  ipcMain.handle("projects:apply-pull", async (_event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    const pending = pendingPulls.get(safeRoot);
    if (!pending) throw new Error("Run To local preview first");
    const needsCodex = pending.preview.conflicts.length > 0 || pending.patchPlan.rejected.length > 0;
    const result = pending.patchPlan.mutations.length > 0
      ? await applyPatchPlan(safeRoot, pending.patchPlan)
      : { changedFiles: [], validation: [] };
    const registry = await readRegistry();
    const index = registry.findIndex((entry) => entry.root === safeRoot);
    if (index >= 0 && !needsCodex) {
      const nextRegistry = [...registry];
      nextRegistry[index] = { ...registry[index], visualBaselines: pending.figmaScreens };
      await writeRegistry(nextRegistry);
    }
    if (needsCodex) {
      const automaticIds = new Set(pending.patchPlan.mutations.map((mutation) => mutation.changeId));
      pending.pullPreview = {
        ...pending.pullPreview,
        changes: pending.pullPreview.changes.filter((change) => !automaticIds.has(change.id))
      };
      pending.patchPlan = { mutations: [], rejected: pending.patchPlan.rejected, changedFiles: [] };
    } else {
      pendingPulls.delete(safeRoot);
    }
    return { ...result, needsCodex };
  });

  ipcMain.handle("projects:sync-from-figma-with-codex", async (event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    const pending = pendingPulls.get(safeRoot);
    const registry = await readRegistry();
    const current = registry.find((entry) => entry.root === safeRoot);
    if (!current?.figmaFileKey) throw new Error("Choose a Figma file first");
    const project = await inspectProject(safeRoot, current);
    let mappings = Object.entries(current.figmaMappings ?? {}).map(([screenId, mapping]) => ({
      screenId,
      nodeId: mapping.nodeId,
      frameName: mapping.frameName
    }));
    if (mappings.length === 0 && current.figmaNodeId) {
      mappings = [{ screenId: "project", nodeId: current.figmaNodeId, frameName: current.figmaFileName ?? "Project frame" }];
    }
    if (mappings.length === 0) throw new Error("Map at least one app page to an exact Figma frame before syncing with Codex");
    const prompt = buildCodexSyncPrompt({
      project,
      figmaFileKey: current.figmaFileKey,
      figmaFileName: current.figmaFileName ?? "Figma file",
      mappings,
      pullPreview: pending?.pullPreview ?? null
    });
    const linkedCodexThread = await resolveProjectCodexThread(safeRoot, project, current);
    if (!linkedCodexThread) {
      const connectionPrompt = buildCodexConnectionPrompt({ project });
      if (current.codexThreadRequestedAt) {
        await shell.openExternal(buildCodexNewThreadUrl({ root: safeRoot, prompt: connectionPrompt }));
      } else {
        await requestProjectCodexThread(safeRoot, connectionPrompt);
      }
      throw new Error("Codex opened this project in the correct folder. Send the prefilled connection message once, then click Sync from Figma again.");
    }
    const before = await snapshotEditableFiles(safeRoot);
    let metadataAfterCodex = linkedCodexThread.metadata;
    const rememberThread = async (threadId) => {
      metadataAfterCodex = await rememberProjectCodexThread(safeRoot, threadId);
      event.sender.send("projects:codex-thread-started", { root: safeRoot, threadId });
    };
    const agentResult = await runCodexSyncAgent({
      root: safeRoot,
      prompt,
      threadId: linkedCodexThread.threadId,
      threadName: `UI Sync · ${project.name}`,
      onThreadStarted: rememberThread
    });
    const after = await snapshotEditableFiles(safeRoot);
    const changedFiles = changedEditableFiles(before, after);
    if (pending) {
      const latestRegistry = await readRegistry();
      const latestIndex = latestRegistry.findIndex((entry) => entry.root === safeRoot);
      if (latestIndex >= 0) {
        const nextRegistry = [...latestRegistry];
        nextRegistry[latestIndex] = { ...latestRegistry[latestIndex], visualBaselines: pending.figmaScreens };
        await writeRegistry(nextRegistry);
        metadataAfterCodex = nextRegistry[latestIndex];
      }
      pendingPulls.delete(safeRoot);
    }

    let refreshedProject = await inspectProject(safeRoot, metadataAfterCodex);
    const validation = [];
    if (project.kind === "swiftui" && changedFiles.length > 0) {
      try {
        const designBuild = await performSwiftUiDesignBuild(safeRoot);
        refreshedProject = designBuild.project;
        validation.push(`Design Build captured ${designBuild.capturedNodeCount} runtime nodes on ${designBuild.deviceName}`);
      } catch (error) {
        validation.push(`Codex finished, but Design Build needs attention: ${error instanceof Error ? error.message : "Unknown validation error"}`);
      }
    }
    return {
      project: refreshedProject,
      changedFiles,
      validation,
      summary: agentResult.summary.slice(-12000),
      codexThreadId: agentResult.threadId
    };
  });

  ipcMain.handle("projects:open-codex-conversation", async (_event, root) => {
    const safeRoot = projectRootSchema.parse(root);
    const registry = await readRegistry();
    const current = registry.find((entry) => entry.root === safeRoot);
    if (!current) throw new Error("Add this project to UI Sync before opening its Codex conversation");
    const project = await inspectProject(safeRoot, current);
    const linkedCodexThread = await resolveProjectCodexThread(safeRoot, project, current);
    if (linkedCodexThread) {
      await shell.openExternal(`codex://threads/${linkedCodexThread.threadId}`);
      return {
        project: await inspectProject(safeRoot, linkedCodexThread.metadata),
        needsSend: false
      };
    }

    const connectionPrompt = buildCodexConnectionPrompt({ project });
    const metadata = current.codexThreadRequestedAt
      ? current
      : await requestProjectCodexThread(safeRoot, connectionPrompt);
    if (current.codexThreadRequestedAt) {
      await shell.openExternal(buildCodexNewThreadUrl({ root: safeRoot, prompt: connectionPrompt }));
    }
    return {
      project: await inspectProject(safeRoot, metadata),
      needsSend: true
    };
  });

  ipcMain.handle("projects:auto-map-status", async (_event, root, pairingCode) => {
    if (!figmaBridge) return { state: "error", message: "The local Figma bridge is not running" };
    const safeRoot = projectRootSchema.parse(root);
    const safeCode = pairingCodeSchema.parse(pairingCode);
    const status = figmaBridge.getStatus(safeCode);
    if (status.state !== "complete") return status;
    const registry = await readRegistry();
    const current = registry.find((item) => item.root === safeRoot);
    return { ...status, project: await inspectProject(safeRoot, current) };
  });

  ipcMain.handle("figma:show-plugin", async () => {
    shell.showItemInFolder(figmaPluginManifestPath);
  });

  /**
   * Whether the plugin on this Mac is connected.
   *
   * The connection is device-level and already remembered on disk; until now it
   * was only ever visible in the middle of a sync, as the presence or absence
   * of a pairing code. Someone who wanted to know whether Crank and Figma were
   * talking had to start sending pages to find out.
   */
  ipcMain.handle("figma:connection", async () => {
    const connection = await readDeviceConnection();
    return {
      connected: Boolean(connection?.confirmed),
      running: Boolean(figmaBridge),
      port: FIGMA_BRIDGE_PORT,
      manifestPath: figmaPluginManifestPath
    };
  });

  /**
   * Hands out a pairing code with nothing behind it.
   *
   * Connecting used to require sending pages somewhere, which is backwards for
   * someone who has just installed the plugin and has nothing to send yet.
   */
  ipcMain.handle("figma:start-pairing", async () => {
    if (!figmaBridge) return { ok: false, message: "The local Figma bridge is not running." };
    const connection = await ensureDeviceConnection();
    const session = figmaBridge.enqueue({
      operation: "pair",
      projectId: createHash("sha256").update("crank:pairing").digest("hex").slice(0, 24),
      projectName: "Crank",
      figmaFileName: "",
      screens: []
    }, { pairing: true, connectionToken: connection.token }, connection.token);
    return { ok: true, ...session };
  });

  /**
   * Forgets the pairing, so the next sync asks for a code again.
   *
   * The plugin can already drop the connection from its side; this is the same
   * door from this side — for a Mac someone is handing on, or a pairing that
   * has gone stale and has to be made again.
   */
  ipcMain.handle("figma:forget-connection", async () => {
    await writeDeviceConnection({ token: randomBytes(32).toString("hex"), confirmed: false });
    return { connected: false, running: Boolean(figmaBridge), port: FIGMA_BRIDGE_PORT, manifestPath: figmaPluginManifestPath };
  });

  ipcMain.handle("codex:open-thread", async (_event, threadId) => {
    const safeThreadId = z.string().uuid().parse(threadId);
    await shell.openExternal(`codex://threads/${safeThreadId}`);
  });

  ipcMain.handle("clipboard:write", (_event, value) => {
    clipboard.writeText(z.string().max(2048).parse(value));
  });

  ipcMain.handle("figma:open", async (_event, fileKey, nodeId) => {
    const safeFileKey = z.string().regex(/^[A-Za-z0-9_-]+$/).parse(fileKey);
    const safeNodeId = z.string().regex(/^\d+[:\-]\d+$/).nullable().parse(nodeId);
    const url = safeNodeId
      ? `https://www.figma.com/design/${safeFileKey}?node-id=${safeNodeId.replace(":", "-")}`
      : `https://www.figma.com/design/${safeFileKey}`;
    await shell.openExternal(url);
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1220,
    height: 790,
    minWidth: 980,
    minHeight: 680,
    backgroundColor: "#f4f4f2",
    icon: appIconPath,
    title: "UI Sync",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: "under-window",
    visualEffectState: "active",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.on("closed", () => {
    if (livePreview?.window === window) destroyLivePreview();
    // The page preview holds the project's own server open for as long as
    // someone is reading it. Closing the window is someone having stopped.
    if (inventoryPreview?.window === window) closeInventoryPreview();
  });
  window.webContents.on("did-finish-load", () => {
    if (process.platform !== "darwin") return;
    window.webContents.executeJavaScript("document.documentElement.dataset.platform = 'macos'", true);
  });

  if (process.env.UI_SYNC_DEV_SERVER_URL) {
    window.loadURL(process.env.UI_SYNC_DEV_SERVER_URL);
  } else {
    window.loadFile(path.join(__dirname, "..", "dist", "index.html"));
  }
}

// Pictures live on disk under the hash of their bytes; the window asks for
// them by reference. Declared before the app is ready, because a scheme cannot
// be made to behave like http after the first window exists.
protocol.registerSchemesAsPrivileged([
  { privileges: { standard: true, secure: true, supportFetchAPI: true }, scheme: "crank-asset" }
]);

app.whenReady().then(async () => {
  if (!hasSingleInstanceLock) return;
  protocol.handle("crank-asset", async (request) => {
    const bytes = await inventoryRegistry().assets.read(request.url).catch(() => null);
    return bytes
      ? new Response(bytes, { headers: { "Cache-Control": "max-age=31536000", "Content-Type": mimeFor(request.url) } })
      : new Response("", { status: 404 });
  });
  inventoryRegistry().sweepAssets()
    .then(({ removed, skipped, unread }) => {
      if (skipped) console.log(`Kept every stored image: ${unread} scan(s) could not be read, so what is unreferenced is not known.`);
      else if (removed > 0) console.log(`Removed ${removed} stored images nothing points at.`);
    })
    .catch(() => null);
  // The product was renamed, and Electron derives this directory from the
  // product name — so without this every scanned project would appear to have
  // vanished on first launch.
  const carried = await carryUserData(
    path.join(path.dirname(app.getPath("userData")), "UI Sync"),
    app.getPath("userData")
  );
  if (carried.carried.length > 0) console.log("Carried forward from UI Sync:", carried.carried.join(", "));
  if (process.platform === "darwin") app.dock.setIcon(appIconPath);
  figmaBridge = createFigmaBridge({
    onComplete: async (context, result) => {
      // A pairing job has no pages behind it and nothing to save: the plugin
      // reporting back *is* the pairing, and confirming it is the whole job.
      if (result.operation === "pair") {
        await confirmDeviceConnection(context.connectionToken);
        return {};
      }
      const completion = result.operation === "pull"
        ? await preparePullPreview(context, result)
        : context.inventoryId
          ? await saveInventoryPush(context, result)
          : await saveAutomaticMappings(context, result);
      await confirmDeviceConnection(context.connectionToken);
      return completion;
    },
    onDisconnect: resetDeviceConnection
  });
  swiftUiRuntimeServer = createSwiftUiRuntimeServer();
  try {
    await Promise.all([figmaBridge.start(), swiftUiRuntimeServer.start()]);
  } catch (error) {
    console.error("Could not start a local UI Sync bridge", error);
  }
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/** Dev servers UI Sync spawned must not outlive it; attached ones have no stop. */
function stopOwnedDevServers() {
  destroyLivePreview();
  closeInventoryPreview();
  for (const server of devServers.values()) server.stop?.();
  devServers.clear();
}

app.on("before-quit", () => {
  if (figmaBridge) void figmaBridge.stop();
  if (swiftUiRuntimeServer) void swiftUiRuntimeServer.stop();
  stopOwnedDevServers();
});

// before-quit does not run when the process is signalled, which would leave the
// project's dev server running after UI Sync is gone. SIGKILL stays unreachable.
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    stopOwnedDevServers();
    app.quit();
    process.exit(0);
  });
}
