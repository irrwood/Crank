const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { PNG } = require("pngjs");
const { looksLikeXcodeProject, scanSwiftUiFolder } = require("./swiftui-inventory.cjs");

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
