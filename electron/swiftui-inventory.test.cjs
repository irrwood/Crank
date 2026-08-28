const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { PNG } = require("pngjs");
const { looksLikeXcodeProject, resolveXcodeProjectRoot, scanSwiftUiFolder } = require("./swiftui-inventory.cjs");

async function projectFolder({ xcode = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-ios-"));
  if (xcode) await mkdir(path.join(root, "Food Truck.xcodeproj"), { recursive: true });
  await writeFile(path.join(root, "ContentView.swift"), "import SwiftUI\n");
  return root;
}

async function previewPng(directory, name) {
  const png = new PNG({ width: 4, height: 8 });
  png.data.fill(200);
  const target = path.join(directory, name);
  await writeFile(target, PNG.sync.write(png));
  return target;
}

function capture(pages) {
  return {
    snapshot: { deviceName: "UI Sync iPhone", nodes: [] },
    screenshot: { path: "/tmp/shot.png" },
    simulator: { udid: "1234", name: "UI Sync iPhone", runtimeId: "com.apple.CoreSimulator.SimRuntime.iOS-26-4" },
    pdfDocument: { path: "/tmp/project.pdf", capturedAt: "2026-08-20T10:00:00.000Z", viewport: { x: 0, y: 0, width: 393, height: 852 }, pages },
    vectorMessage: null,
    warnings: []
  };
}

const converterFound = async () => "/opt/homebrew/bin/pdftocairo";

test("claims a folder that holds an Xcode project", async () => {
  assert.equal(await looksLikeXcodeProject(await projectFolder()), true);
  assert.equal(await looksLikeXcodeProject(await projectFolder({ xcode: false })), false);
});

test("finds the project file above the source folder that was handed over", async () => {
  const root = await projectFolder();
  const sources = path.join(root, "FocusFlow");
  await mkdir(path.join(sources, "Views"), { recursive: true });
  await writeFile(path.join(sources, "FocusFlowApp.swift"), "import SwiftUI\n");
  assert.equal(await resolveXcodeProjectRoot(sources), root);
  assert.equal(await resolveXcodeProjectRoot(path.join(sources, "Views")), null);
  await writeFile(path.join(sources, "Views", "HomeView.swift"), "import SwiftUI\n");
  assert.equal(await resolveXcodeProjectRoot(path.join(sources, "Views")), root);
});

test("finds the project file in the one subfolder that has it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-ios-repo-"));
  const app = path.join(root, "ios");
  await mkdir(path.join(app, "FocusFlow.xcodeproj"), { recursive: true });
  assert.equal(await resolveXcodeProjectRoot(root), app);
});

test("leaves a web project alone even when an app sits beside it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-web-"));
  await writeFile(path.join(root, "package.json"), "{}\n");
  await mkdir(path.join(root, "ios", "App.xcodeproj"), { recursive: true });
  assert.equal(await resolveXcodeProjectRoot(root), null);
});

test("turns exported pages into an inventory the rest of the app already reads", async () => {
  const root = await projectFolder();
  const previews = await mkdtemp(path.join(os.tmpdir(), "ui-sync-previews-"));
  const pages = [
    { id: "pdf-page-1", name: "Truck", pageNumber: 1, width: 393, height: 852, renderSource: "image-renderer", sourceName: "TruckView", previewPath: await previewPng(previews, "one.png") },
    { id: "pdf-page-2", name: "Orders", pageNumber: 2, width: 393, height: 852, renderSource: "window-fallback", sourceName: "OrdersView", previewPath: await previewPng(previews, "two.png") }
  ];
  const statuses = [];
  const inventory = await scanSwiftUiFolder(root, {
    runtimeServer: {},
    resolveConverter: converterFound,
    onStatus: (status) => statuses.push(status.phase),
    runDesignBuild: async ({ simulatorPreference }) => {
      assert.deepEqual(simulatorPreference, { preferredUdid: "5678" });
      return capture(pages);
    },
    preferredUdid: "5678"
  });

  assert.equal(inventory.ok, true);
  assert.equal(inventory.platform, "swiftui");
  assert.equal(inventory.origin, root);
  assert.deepEqual(inventory.pages.map((page) => page.name), ["Truck", "Orders"]);
  // No address: an exported page cannot be reopened by loading a route.
  assert.deepEqual(inventory.pages.map((page) => page.route), ["", ""]);
  assert.match(inventory.pages[0].thumbnail.dataUrl, /^data:image\/png;base64,/);
  assert.deepEqual(inventory.pages[0].vector, {
    pageId: "pdf-page-1", width: 393, height: 852, renderSource: "image-renderer", sourceName: "TruckView"
  });
  // The capture stays with the caller to store; it never becomes page content.
  assert.equal(inventory.capture.pdfDocument.pages.length, 2);
  assert.match(inventory.servedBy, /UI Sync iPhone/);
  assert.deepEqual(statuses, ["starting", "capturing"]);
});

test("reports why an export produced nothing instead of an empty inventory", async () => {
  const root = await projectFolder();
  const outcome = await scanSwiftUiFolder(root, {
    runtimeServer: {},
    resolveConverter: converterFound,
    runDesignBuild: async () => ({ ...capture([]), pdfDocument: null, vectorMessage: "The app ran, but no iOS window produced a PDF capture." })
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.message, /no iOS window produced a PDF capture/);
});

test("says a build failed in the words the build used", async () => {
  const root = await projectFolder();
  const outcome = await scanSwiftUiFolder(root, {
    runtimeServer: {},
    resolveConverter: converterFound,
    runDesignBuild: async () => { throw new Error("No runnable application scheme was found"); }
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.reason, "swiftui-build");
  assert.match(outcome.message, /No runnable application scheme/);
});

test("checks for the vector converter before spending minutes on a build", async () => {
  const root = await projectFolder();
  let built = false;
  const outcome = await scanSwiftUiFolder(root, {
    runtimeServer: {},
    resolveConverter: async () => null,
    runDesignBuild: async () => { built = true; return capture([]); }
  });
  assert.equal(built, false);
  assert.equal(outcome.reason, "poppler");
  assert.match(outcome.message, /brew install poppler/);
});

/**
 * The two capture paths, from the scan's side. `runDesignBuild` and the
 * display-list server are both injected, so what a page ends up carrying can be
 * checked without Xcode, a Simulator, or several minutes of building.
 */
const exportedPage = (id, sourceName) => ({
  id, name: sourceName, width: 390, height: 844,
  previewPath: "/nonexistent.png", renderSource: "image-renderer", sourceName
});

const buildStub = (pages) => async ({ displayListSession }) => ({
  snapshot: { deviceName: "iPhone 17" },
  screenshot: null,
  simulator: { udid: "x" },
  pdfDocument: { pages },
  displayListSession
});

function fakeDisplayListServer(screensByToken) {
  return {
    beginSession: () => ({ token: "t", endpoint: "http://127.0.0.1:1/x", unavailable() {} }),
    waitForScreens: async () => screensByToken,
    endSession() {}
  };
}

const layerTree = { width: 390, height: 844, tree: { kind: "element", name: "Screen", children: [] } };

test("a page carries the layers captured for the view it came from", async () => {
  const result = await scanSwiftUiFolder("/tmp/app", {
    runtimeServer: {},
    displayListServer: fakeDisplayListServer([{ name: "HomeView", ok: true, reason: null, layerTree, warnings: [] }]),
    capturePipeline: "both",
    runDesignBuild: buildStub([exportedPage("pdf-page-1", "HomeView")]),
    resolveConverter: async () => "/usr/bin/pdftocairo"
  });
  assert.equal(result.ok, true);
  assert.equal(result.pages[0].layerTree.width, 390);
  // `both` keeps the exported vectors beside them, which is what makes the two
  // comparable on the same page.
  assert.ok(result.pages[0].vector);
});

test("asking for the render tree alone drops the exported vectors", async () => {
  const result = await scanSwiftUiFolder("/tmp/app", {
    runtimeServer: {},
    displayListServer: fakeDisplayListServer([{ name: "HomeView", ok: true, reason: null, layerTree, warnings: [] }]),
    capturePipeline: "display-list",
    runDesignBuild: buildStub([exportedPage("pdf-page-1", "HomeView")]),
    resolveConverter: async () => "/usr/bin/pdftocairo"
  });
  assert.equal(result.pages[0].vector, null);
  assert.ok(result.pages[0].layerTree);
});

test("a page whose layers did not come back keeps its vectors rather than being empty", async () => {
  const result = await scanSwiftUiFolder("/tmp/app", {
    runtimeServer: {},
    displayListServer: fakeDisplayListServer([]),
    capturePipeline: "display-list",
    runDesignBuild: buildStub([exportedPage("pdf-page-1", "HomeView")]),
    resolveConverter: async () => "/usr/bin/pdftocairo"
  });
  assert.equal(result.pages[0].layerTree, null);
  assert.ok(result.pages[0].vector);
  assert.match(result.capture.warnings.join(" "), /kept its exported vectors/);
});

test("a screen the agent could not read is reported on the page it belongs to", async () => {
  const result = await scanSwiftUiFolder("/tmp/app", {
    runtimeServer: {},
    displayListServer: fakeDisplayListServer([
      { name: "HomeView", ok: false, reason: "the renderer has drawn no display list yet", layerTree: null, warnings: [] }
    ]),
    capturePipeline: "both",
    runDesignBuild: buildStub([exportedPage("pdf-page-1", "HomeView")]),
    resolveConverter: async () => "/usr/bin/pdftocairo"
  });
  assert.match(result.pages[0].layerError, /no display list/);
  assert.match(result.capture.warnings.join(" "), /no display list/);
});

test("without a display-list server a scan is exactly what it was before", async () => {
  const result = await scanSwiftUiFolder("/tmp/app", {
    runtimeServer: {},
    runDesignBuild: buildStub([exportedPage("pdf-page-1", "HomeView")]),
    resolveConverter: async () => "/usr/bin/pdftocairo"
  });
  assert.equal(result.pages[0].layerTree, null);
  assert.ok(result.pages[0].vector);
});

test("a render-tree scan stands on its own when nothing was exported", async () => {
  const result = await scanSwiftUiFolder("/tmp/app", {
    runtimeServer: {},
    displayListServer: fakeDisplayListServer([
      { name: "HomeView", ok: true, reason: null, layerTree, thumbnail: { dataUrl: "data:image/png;base64,iVBORw0KGgo=", width: 390, height: 844 }, warnings: [] },
      { name: "OrdersView", ok: true, reason: null, layerTree, thumbnail: null, warnings: ["an image had no pixels"] }
    ]),
    capturePipeline: "display-list",
    runDesignBuild: async () => ({ snapshot: {}, screenshot: null, pdfDocument: null, vectorMessage: "no pages exported" }),
    // Poppler is not part of this answer, so it must not be asked for.
    resolveConverter: async () => { throw new Error("the converter must not be looked for"); }
  });
  assert.equal(result.ok, true);
  assert.equal(result.platform, "swiftui");
  assert.deepEqual(result.pages.map((page) => page.name), ["HomeView", "OrdersView"]);
  assert.ok(result.pages[0].layerTree);
  assert.equal(result.pages[0].vector, null);
  assert.match(result.capture.warnings.join(" "), /OrdersView: an image had no pixels/);
  // The sidebar has something to show for a page that has no exported PDF.
  assert.match(result.pages[0].thumbnail.dataUrl, /^data:image\/png;base64,/);
  assert.equal(result.pages[1].thumbnail, null);
});

test("nothing exported and nothing captured is still a scan that failed", async () => {
  const result = await scanSwiftUiFolder("/tmp/app", {
    runtimeServer: {},
    displayListServer: fakeDisplayListServer([]),
    capturePipeline: "display-list",
    runDesignBuild: async () => ({ snapshot: {}, pdfDocument: null, vectorMessage: "the app drew nothing" }),
    resolveConverter: async () => "/usr/bin/pdftocairo"
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "swiftui-no-pages");
  assert.match(result.message, /drew nothing/);
});

test("the exported path still needs its converter", async () => {
  const result = await scanSwiftUiFolder("/tmp/app", {
    runtimeServer: {},
    capturePipeline: "vector-pdf",
    runDesignBuild: buildStub([exportedPage("pdf-page-1", "HomeView")]),
    resolveConverter: async () => null
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "poppler");
});
