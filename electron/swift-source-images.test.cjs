const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { PNG } = require("pngjs");
const { assetCatalogIndex, referencedImageNames, resolveSwiftSourceImages, swiftStructBodies, translatedFrame } = require("./swift-source-images.cjs");

test("finds named SwiftUI and UIKit image resources inside their owning view", () => {
  const source = `
    struct EmptyStateSpinner: View {
      static let image = UIImage(named: "huaicat")
      var body: some View { Image(uiImage: Self.image!) }
    }
    struct Logo: View { var body: some View { Image("brand-mark") } }
  `;
  const declarations = swiftStructBodies(source);
  assert.deepEqual(declarations.map((item) => item.sourceName), ["EmptyStateSpinner", "Logo"]);
  assert.deepEqual(referencedImageNames(declarations[0].body), ["huaicat"]);
  assert.deepEqual(referencedImageNames(declarations[1].body), ["brand-mark"]);
});

test("maps a source image frame into the exported PDF coordinate space", () => {
  assert.deepEqual(translatedFrame(
    { x: 102, y: 274.5, width: 198, height: 198 },
    { environment: { viewport: { x: 0, y: 0, width: 402, height: 874 } } },
    { x: 0, y: 0, width: 402, height: 874, outputWidth: 804, outputHeight: 1748 }
  ), { x: 204, y: 549, width: 396, height: 396 });
});

test("indexes Asset Catalog logical namespaces and prefers the highest-resolution original PNG", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-assets-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const catalog = path.join(root, "Assets.xcassets");
  const header = path.join(catalog, "header");
  const layer = path.join(header, "layer");
  const imageset = path.join(layer, "8 Road.imageset");
  await mkdir(imageset, { recursive: true });
  const namespace = JSON.stringify({ info: { version: 1, author: "xcode" }, properties: { "provides-namespace": true } });
  await writeFile(path.join(header, "Contents.json"), namespace);
  await writeFile(path.join(layer, "Contents.json"), namespace);
  await writeFile(path.join(imageset, "Contents.json"), JSON.stringify({
    images: [
      { filename: "Road.png", idiom: "universal", scale: "1x" },
      { filename: "Road@3x.png", idiom: "universal", scale: "3x" }
    ],
    info: { version: 1, author: "xcode" }
  }));
  await writeFile(path.join(imageset, "Road.png"), PNG.sync.write(new PNG({ width: 2, height: 2 })));
  await writeFile(path.join(imageset, "Road@3x.png"), PNG.sync.write(new PNG({ width: 6, height: 6 })));

  const index = await assetCatalogIndex(root);
  assert.equal(index.get("header/layer/8 Road"), path.join(imageset, "Road@3x.png"));
  assert.equal(index.get("8 Road"), path.join(imageset, "Road@3x.png"));

  const plans = await resolveSwiftSourceImages(root, {
    environment: { viewport: { x: 0, y: 0, width: 100, height: 200 } },
    nodes: [{
      syncId: "swift/1234567890abcdef", sourceFile: "Header.swift", sourceName: "BrandHeader",
      pageSourceName: "TruckView", kind: "Image", assetName: "header/layer/8 Road", instanceId: "one",
      frame: { x: 10, y: 20, width: 30, height: 40 }
    }]
  }, "TruckView");
  const positioned = plans.filter((plan) => plan.frame);
  const originals = plans.filter((plan) => plan.originalAsset);
  assert.equal(positioned.length, 1);
  assert.equal(originals.length, 1);
  assert.equal(positioned[0].assetName, "header/layer/8 Road");
  assert.equal(positioned[0].width, 6);
  assert.deepEqual(positioned[0].frame, { x: 10, y: 20, width: 30, height: 40 });
});
