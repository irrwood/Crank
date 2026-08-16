const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeSwiftTreeForPdfPage } = require("./swift-page-coordinate.cjs");

test("normalizes runtime text geometry into an ImageRenderer page frame", () => {
  const tree = {
    type: "vstack",
    runtimeFrame: { x: -9, y: 62, width: 420, height: 729 },
    runtimeEnvironment: {
      viewport: { x: 0, y: 0, width: 402, height: 874 },
      displayScale: 3,
      colorScheme: "light",
      dynamicTypeSize: "large",
      layoutDirection: "leftToRight"
    },
    children: [{
      type: "text",
      text: "Title",
      runtimeFrame: { x: 20, y: 90, width: 100, height: 28 },
      runtimeInstances: [{ instanceId: "one", x: 20, y: 90, width: 100, height: 28 }]
    }]
  };
  const normalized = normalizeSwiftTreeForPdfPage(tree, { x: -9, y: 62, width: 420, height: 729 }, { width: 420, height: 729 });
  assert.deepEqual(normalized.runtimeEnvironment.viewport, { x: 0, y: 0, width: 420, height: 729 });
  assert.deepEqual(normalized.runtimeFrame, { x: 0, y: 0, width: 420, height: 729 });
  assert.deepEqual(normalized.children[0].runtimeFrame, { x: 29, y: 28, width: 100, height: 28 });
  assert.deepEqual(normalized.children[0].runtimeInstances[0], { instanceId: "one", x: 29, y: 28, width: 100, height: 28 });
});
