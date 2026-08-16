const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildSwiftVisualPayload, cropPixels, isOpaqueSwiftNode } = require("./swift-visual-assets.cjs");

test("classifies opaque runtime views without flattening normal editable nodes", () => {
  assert.equal(isOpaqueSwiftNode({ type: "custom", name: "Map", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 100, height: 100 } }), true);
  assert.equal(isOpaqueSwiftNode({ type: "text", name: "Text", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 100, height: 20 } }), false);
});

test("converts point-space runtime frames into clamped screenshot pixels", () => {
  assert.deepEqual(cropPixels(
    { x: 390, y: 850, width: 20, height: 20 },
    { viewport: { x: 0, y: 0, width: 393, height: 852 }, displayScale: 3 }
  ), { x: 1170, y: 2550, width: 9, height: 6 });
});

test("builds a hidden page reference plus local fallback assets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ui-sync-visual-"));
  const screenshotPath = path.join(directory, "screen.png");
  const vectorPath = path.join(directory, "screen.svg");
  await writeFile(screenshotPath, Buffer.from([137, 80, 78, 71]));
  await writeFile(vectorPath, '<svg width="393" height="852"><path d="M0 0h393v852H0z"/></svg>');
  const screen = {
    id: "home",
    runtimeCapture: { state: "captured", isVisualReference: true },
    uiTree: {
      type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 393, height: 852 },
      children: [
        { type: "text", text: "Editable", runtimeStatus: "captured", runtimeFrame: { x: 20, y: 20, width: 80, height: 20 } },
        { type: "custom", name: "WebView", syncId: "swift/1111111111111111", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 100, width: 393, height: 400 } }
      ]
    }
  };
  const payload = await buildSwiftVisualPayload(screen, {
    path: screenshotPath,
    viewport: { x: 0, y: 0, width: 393, height: 852 },
    displayScale: 3
  }, { cropper: async () => Buffer.from([1, 2, 3]), vector: { svgPath: vectorPath } });
  assert.match(payload.visualReferenceAssetId, /^swift-reference-/);
  assert.equal(payload.uiTree.children[0].visualMode, "editable");
  assert.equal(payload.uiTree.children[1].visualMode, "snapshot-fallback");
  assert.equal(payload.assets.size, 2);
  assert.match(payload.vectorSvg, /<svg width="393"/);
});

test("keeps the selected page vector for a captured non-reference screen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ui-sync-page-vector-"));
  const vectorPath = path.join(directory, "page.svg");
  await writeFile(vectorPath, '<svg width="100" height="200"><path d="M0 0h100v200H0z"/></svg>');
  const fallbackSvg = '<svg width="100" height="200"><path filter="url(#shadow)" d="M0 0h100v200H0z"/></svg>';
  const nativeShadows = [{ marker: "ui-sync-shadow-0", color: { r: 0, g: 0, b: 0, a: 0.25 }, offset: { x: 0, y: 6 }, radius: 10, spread: 0 }];
  const vectorEffects = [{ id: "swift/page/shadow", syncId: "swift/page", type: "DROP_SHADOW", frame: { x: 10, y: 10, width: 80, height: 80 }, radius: 10, colorToken: "black", opacity: 0.25, offset: { x: 0, y: 6 } }];
  const payload = await buildSwiftVisualPayload({
    id: "page-2",
    runtimeCapture: { state: "captured", isVisualReference: false },
    uiTree: { type: "text", text: "Page two" }
  }, null, { vector: { svgPath: vectorPath, fallbackSvg, nativeShadows, vectorEffects } });
  assert.match(payload.vectorSvg, /<path/);
  assert.equal(payload.vectorFallbackSvg, fallbackSvg);
  assert.deepEqual(payload.vectorNativeShadows, nativeShadows);
  assert.deepEqual(payload.vectorEffects, vectorEffects);
  assert.equal(payload.visualReferenceAssetId, null);
});
