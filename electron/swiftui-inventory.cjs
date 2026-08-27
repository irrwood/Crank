const { readFile, readdir } = require("node:fs/promises");
const path = require("node:path");
const { runSwiftUiDesignBuild } = require("./swiftui-design-runtime.cjs");
const { resolvePdfToCairo } = require("./swift-pdf-vector.cjs");
const { readXcodeAppIcon } = require("./xcode-app-icon.cjs");
const { usesVectorPdf } = require("./capture-pipeline.cjs");

/**
 * An Xcode project cannot be served and crawled: it has no address, and its
 * screens exist only once the app is running — on a Simulator for iOS, on this
 * Mac for a desktop app. So it is scanned by building it, launching it, and
 * exporting each of its top-level states as a vector PDF page — the same
 * pipeline UI Sync has always used for SwiftUI, producing the same inventory
 * shape a served project produces.
 */
async function looksLikeXcodeProject(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  // Design Build drives an .xcodeproj. A workspace or a bare Swift package has
  // no scheme it can build on its own, so those are not claimed here.
  return entries.some((entry) => entry.isDirectory() && entry.name.endsWith(".xcodeproj"));
}

async function holdsSwiftSources(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  return entries.some((entry) => entry.isFile() && entry.name.endsWith(".swift"))
    || entries.some((entry) => entry.isDirectory() && entry.name.endsWith(".xcassets"));
}

/**
 * Finds the folder Xcode can actually build, given the folder someone handed
 * over.
 *
 * A project is rarely dropped at exactly the level the `.xcodeproj` sits at:
 * the app's own source folder is one level below it, and a repository often
 * keeps the project in a subfolder of its own. Both are the same app, and
 * turning either away for having no `package.json` is what the folder looks
 * like to everything downstream if it is not claimed here.
 *
 * Returns null when nothing nearby can be built, which is the answer for every
 * project that is not an iOS one.
 */
async function resolveXcodeProjectRoot(root) {
  if (await looksLikeXcodeProject(root)) return root;
  // Only a folder that is itself Swift follows its parents up: a web project
  // that happens to live beside an app must stay a web project.
  if (await holdsSwiftSources(root)) {
    let directory = root;
    // Two levels covers `App.xcodeproj` beside `App/` and beside `App/Sources/`.
    for (let step = 0; step < 2; step += 1) {
      const parent = path.dirname(directory);
      if (parent === directory) break;
      if (await looksLikeXcodeProject(parent)) return parent;
      directory = parent;
    }
    return null;
  }
  // A repository with the app in a subfolder — but never one that is a project
  // in its own right, which is what a manifest at the top means.
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) return null;
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name.endsWith(".xcodeproj")) continue;
    if (await looksLikeXcodeProject(path.join(root, entry.name))) candidates.push(path.join(root, entry.name));
  }
  return candidates.length === 1 ? candidates[0] : null;
}

async function pageThumbnail(page) {
  const preview = await readFile(page.previewPath).catch(() => null);
  if (!preview) return null;
  return {
    dataUrl: `data:image/png;base64,${preview.toString("base64")}`,
    width: page.width,
    height: page.height
  };
}

/**
 * Scans an Xcode project into the same inventory a served project produces.
 *
 * `runDesignBuild` is injectable so the shape of a scan can be tested without
 * Xcode, a Simulator, and several minutes of building.
 */
async function scanSwiftUiFolder(root, {
  cacheDirectory,
  runtimeServer,
  preferredUdid = null,
  /** Where the `.xcodeproj` lives, when that is not the folder being scanned. */
  projectRoot = null,
  /**
   * The second capture path, when it is turned on. Given a server, the same
   * launch of the app also reports the render tree SwiftUI drew, and each page
   * carries the layers that produced rather than only its exported vectors.
   */
  displayListServer = null,
  /**
   * Which capture a page should carry when both are available. `display-list`
   * hands over the render tree alone, so the Figma step builds from layers
   * rather than from an exported drawing of the same screen.
   */
  capturePipeline = "vector-pdf",
  onStatus,
  runDesignBuild = runSwiftUiDesignBuild,
  resolveConverter = resolvePdfToCairo
} = {}) {
  if (!runtimeServer) {
    return { ok: false, reason: "swiftui-runtime", message: "The local SwiftUI runtime bridge is not running." };
  }
  // Checked before the build rather than after it: the pages are worth nothing
  // without the converter, and xcodebuild plus the Simulator take minutes.
  //
  // Only when this scan is going to export vectors at all. Asked for the render
  // tree alone, Poppler is not part of the answer, and refusing to scan for the
  // want of it would be refusing over a step this scan does not take.
  if (usesVectorPdf(capturePipeline) && !(await resolveConverter())) {
    return {
      ok: false,
      reason: "poppler",
      message: "Scanning an Xcode project needs Poppler to turn its exported pages into vectors. Install it with `brew install poppler`, then scan again."
    };
  }
  onStatus?.({ phase: "starting", detail: "Building this Xcode project and running it" });
  const displayListSession = displayListServer ? displayListServer.beginSession(root) : null;
  let result;
  try {
    result = await runDesignBuild({
      root: projectRoot ?? root,
      cacheDirectory,
      runtimeServer,
      simulatorPreference: preferredUdid ? { preferredUdid } : {},
      displayListSession
    });
  } catch (error) {
    if (displayListSession) displayListServer.endSession(displayListSession.token);
    return {
      ok: false,
      reason: "swiftui-build",
      message: error instanceof Error ? error.message : "This Xcode project could not be built."
    };
  }

  const deviceName = result.snapshot?.deviceName ?? "iPhone Simulator";
  // A Mac app was run here, not on a device that had to be booted first.
  const ranOnThisMac = result.simulator === null;
  const exported = result.pdfDocument?.pages ?? [];
  // Collected after the build, because the app posts them while it runs. A
  // screen is matched to its page by the view it was captured from — the same
  // name the exported page carries — rather than by order, which two capture
  // paths that skip different screens would not agree on.
  const displayListScreens = displayListSession
    ? await displayListServer.waitForScreens(displayListSession.token, { timeoutMs: 3_000, settleMs: 500 }).catch(() => [])
    : [];
  if (displayListSession) displayListServer.endSession(displayListSession.token);
  const capturedByName = new Map();
  for (const screen of displayListScreens) {
    if (!capturedByName.has(screen.name)) capturedByName.set(screen.name, screen);
  }
  const onlyScreen = displayListScreens.length === 1 ? displayListScreens[0] : null;
  const displayListWarnings = [];
  const capturedScreens = displayListScreens.filter((screen) => screen.layerTree);

  /**
   * Everything an iOS inventory is except its pages, which the two capture
   * paths fill in differently. Written once so the sidebar, the Figma step and
   * the registry cannot tell the two apart.
   */
  const inventoryShell = async () => ({
    ok: true,
    platform: "swiftui",
    origin: root,
    // The project's own icon, out of its asset catalog: a scanned app wears its
    // own face in the sidebar rather than the folder glyph everything shares.
    icon: await readXcodeAppIcon(projectRoot ?? root),
    skipped: [],
    filtered: [],
    inert: [],
    sources: { sitemap: 0, seeds: 0, crawled: 0 },
    servedBy: ranOnThisMac ? `${deviceName}` : `the iOS Simulator (${deviceName})`,
    attached: false
  });

  if (exported.length === 0) {
    // Nothing was exported. That used to end the scan, and it still does when
    // nothing else came back — but a run that read the render tree has the
    // screens, and refusing them because the other path produced no PDF would
    // throw away the result this scan was asked for.
    if (capturedScreens.length === 0) {
      return {
        ok: false,
        reason: "swiftui-no-pages",
        message: result.vectorMessage || "The app ran, but no screen could be exported as a PDF page."
      };
    }
    onStatus?.({ phase: "capturing", detail: `Reading ${capturedScreens.length} ${capturedScreens.length === 1 ? "screen" : "screens"} from ${deviceName}` });
    return {
      ...(await inventoryShell()),
      pages: capturedScreens.map((screen, index) => ({
        id: `display-list-${index}`,
        name: screen.name,
        route: "",
        recipe: [],
        depth: 0,
        thumbnail: screen.thumbnail ?? null,
        snapshot: null,
        layerTree: screen.layerTree,
        layerError: null,
        vector: null,
        variants: []
      })),
      capture: {
        snapshot: result.snapshot,
        screenshot: result.screenshot,
        pdfDocument: null,
        simulator: result.simulator ?? null,
        vectorMessage: result.vectorMessage ?? null,
        warnings: [
          ...(result.warnings ?? []),
          ...capturedScreens.flatMap((screen) => screen.warnings.map((warning) => `${screen.name}: ${warning}`))
        ]
      }
    };
  }

  onStatus?.({ phase: "capturing", detail: `Exporting ${exported.length} ${exported.length === 1 ? "screen" : "screens"} from ${deviceName}` });

  const pages = [];
  for (const page of exported) {
    // One screen and one page is not ambiguous, whatever either is called.
    const captured = capturedByName.get(page.sourceName) ?? (exported.length === 1 ? onlyScreen : null);
    if (captured && !captured.ok && captured.reason) {
      displayListWarnings.push(`${page.name}: ${captured.reason}`);
    }
    for (const warning of captured?.warnings ?? []) displayListWarnings.push(`${page.name}: ${warning}`);
    const capturedLayers = Boolean(captured?.layerTree);
    // Kept whenever this pipeline wants them, and kept anyway when the render
    // tree came back empty for this page — a page with neither is not there.
    const keepsVector = usesVectorPdf(capturePipeline) || !capturedLayers;
    if (!usesVectorPdf(capturePipeline) && !capturedLayers) {
      displayListWarnings.push(`${page.name}: kept its exported vectors, because no layers came back.`);
    }
    pages.push({
      id: page.id,
      name: page.name,
      // A page of an iOS app has no address. Everything downstream treats an
      // empty route as "this page cannot be reopened by loading it".
      route: "",
      recipe: [],
      depth: 0,
      thumbnail: await pageThumbnail(page),
      snapshot: null,
      // The render tree when this scan read one, and null when it did not —
      // which is what every iOS page looked like before this path existed, and
      // what the Figma step already knows how to fall back from.
      layerTree: captured?.layerTree ?? null,
      layerError: captured && !captured.ok ? captured.reason : null,
      // What the Figma side needs to find this page's exported PDF again. The
      // PDF, its clean variants, and the runtime snapshot stay on disk; sending
      // them through the renderer would put a whole capture in every payload.
      // Dropped only when this page really did come back with layers. Asked for
      // the render tree and given nothing for a page, keeping the exported
      // vectors is the difference between a page that looks different and a
      // page that is not there — and the warning above already says which
      // happened.
      vector: keepsVector ? {
        pageId: page.id,
        width: page.width,
        height: page.height,
        renderSource: page.renderSource ?? null,
        sourceName: page.sourceName ?? null
      } : null,
      variants: []
    });
  }

  return {
    ...(await inventoryShell()),
    pages,
    // Persisted by the caller, not by the renderer: this is the capture the
    // Figma import reads from.
    capture: {
      snapshot: result.snapshot,
      screenshot: result.screenshot,
      pdfDocument: result.pdfDocument,
      simulator: result.simulator ?? null,
      vectorMessage: result.vectorMessage ?? null,
      warnings: [...(result.warnings ?? []), ...displayListWarnings]
    }
  };
}

module.exports = { looksLikeXcodeProject, resolveXcodeProjectRoot, scanSwiftUiFolder };
