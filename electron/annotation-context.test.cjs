const test = require("node:test");
const assert = require("node:assert/strict");

test("visual annotation context keeps the selected node and source without the captured page", async () => {
  const { formatCrankAnnotationContext } = await import("../shared/annotation-context.js");
  const text = formatCrankAnnotationContext([{
    version: 1,
    id: "annotation-1",
    inventoryId: "a7e388a189175499",
    screenId: "home",
    screenName: "Home",
    comment: "Make this button larger",
    target: {
      kind: "node",
      nodeId: "button-183",
      name: "CheckoutButton",
      point: { x: 0.42, y: 0.61 },
      sourceRef: { file: "CheckoutView.swift", line: 142, column: 3 }
    },
    createdAt: "2026-08-30T00:00:00.000Z"
  }]);

  assert.match(text, /Home, "CheckoutButton"/);
  assert.doesNotMatch(text, /button-183|\(home\)/);
  assert.match(text, /CheckoutView\.swift:142/);
  assert.match(text, /Make this button larger/);
  assert.doesNotMatch(text, /layerTree|data:image/);
});

test("visual annotation context describes a raster point as percentages", async () => {
  const { formatCrankAnnotationContext } = await import("../shared/annotation-context.js");
  const text = formatCrankAnnotationContext([{
    version: 1,
    id: "annotation-2",
    inventoryId: "a7e388a189175499",
    screenId: "image",
    screenName: "Image",
    comment: "Align this area",
    target: { kind: "point", point: { x: 0.126, y: 0.904 } },
    createdAt: "2026-08-30T00:00:00.000Z"
  }]);

  assert.match(text, /page point 13%, 90%/);
});

test("no staged comments add no filler to the next Codex message", async () => {
  const { formatCrankAnnotationContext } = await import("../shared/annotation-context.js");
  assert.equal(formatCrankAnnotationContext([]), "");
});
