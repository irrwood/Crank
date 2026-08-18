const assert = require("node:assert/strict");
const test = require("node:test");
const {
  buildVisualEditPrompt,
  compareDesignStates,
  createResizeIntent,
  desiredSnapshots,
  extractDesignNodes,
  semanticIntentBatchSchema
} = require("./visual-editing.cjs");

const node = {
  id: "trip-card",
  name: "Trip Card",
  frame: { x: 16, y: 180, width: 320, height: 108 },
  cornerRadius: 12,
  backgroundColor: "#FFFFFF",
  fontSize: 17,
  sourceHint: "TripDetailScreen.swift:18",
  text: "Hotel",
  pageName: "Trip detail",
  measurement: { frame: "runtime", properties: "declared" }
};

const context = {
  device: "iPhone 16 Pro",
  canvasWidth: 393,
  containerWidth: 361,
  safeAreaInsets: { leading: 0, trailing: 0 },
  dynamicTypeSize: "large",
  siblings: { "flight-card": 320 }
};

test("records a relational resize with a derived delta and device context", () => {
  const operation = createResizeIntent({ id: "edit-1", node: node.id, axis: "horizontal", from: 320, to: 360, context });
  assert.equal(operation.delta, 40);
  assert.equal(operation.context.containerWidth, 361);
  assert.equal(operation.operation, "resize");
});

test("extracts runtime design nodes and distinguishes unavailable properties", () => {
  const nodes = extractDesignNodes({
    screens: [{
      name: "Home",
      runtimeCapture: { isVisualReference: true },
      uiTree: {
        type: "vstack",
        syncId: "swift/1111111111111111",
        sourceFile: "Home.swift",
        sourceRange: { line: 8 },
        runtimeFrame: { x: 16, y: 80, width: 361, height: 240 },
        runtimeStatus: "captured",
        children: [{
          type: "text",
          text: "Trips",
          syncId: "swift/2222222222222222",
          sourceFile: "Home.swift",
          sourceRange: { line: 10 },
          runtimeFrame: { x: 32, y: 96, width: 80, height: 24 },
          runtimeStatus: "captured",
          fontSize: 17
        }]
      }
    }]
  });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].sourceHint, "Home.swift:8");
  assert.equal(nodes[0].measurement.properties, "unavailable");
  assert.equal(nodes[1].measurement.properties, "declared");
});

test("builds desired snapshots without mutating runtime measurements", () => {
  const operations = [
    createResizeIntent({ id: "edit-1", node: node.id, axis: "horizontal", from: 320, to: 360, context }),
    { id: "edit-2", node: node.id, operation: "set_property", property: "cornerRadius", from: 12, value: 20 }
  ];
  const desired = desiredSnapshots([node], operations);
  assert.equal(desired[0].frame.width, 360);
  assert.equal(desired[0].cornerRadius, 20);
  assert.equal(node.frame.width, 320);
});

test("compares desired and actual properties with a point tolerance", () => {
  const operation = createResizeIntent({ id: "edit-1", node: node.id, axis: "horizontal", from: 320, to: 360, context });
  const result = compareDesignStates([node], [operation], [{ ...node, frame: { ...node.frame, width: 361 } }]);
  assert.equal(result.converged, true);
  assert.deepEqual(result.checks[0], { operationId: "edit-1", node: "trip-card", property: "width", desired: 360, actual: 361, delta: 1, passed: true });
});

test("requires a confirmed non-empty intent batch and creates an adaptive-first Codex prompt", () => {
  const operation = createResizeIntent({ id: "edit-1", node: node.id, axis: "horizontal", from: 320, to: 360, context });
  const batch = semanticIntentBatchSchema.parse({
    version: 1,
    projectRoot: "/tmp/Trip",
    pageName: "Trip detail",
    createdAt: "2026-08-13T12:00:00.000Z",
    operations: [operation]
  });
  const prompt = buildVisualEditPrompt({ project: { name: "Trip", kind: "swiftui", framework: "SwiftUI" }, batch, nodes: [node] });
  assert.match(prompt, /Prefer adaptive implementations/);
  assert.match(prompt, /"containerWidth": 361/);
  assert.match(prompt, /Do not commit/);
});

test("accepts source-derived layers and text edits without requiring a PNG capture", () => {
  const structuralNode = {
    ...node,
    id: "swift/1234567890abcdef/0",
    text: "Original title",
    measurement: { frame: "structural", properties: "declared" }
  };
  const batch = semanticIntentBatchSchema.parse({
    version: 1,
    projectRoot: "/tmp/Trip",
    pageName: "Trip detail",
    createdAt: "2026-08-13T12:00:00.000Z",
    nodes: [structuralNode],
    operations: [{
      id: "edit-text",
      node: structuralNode.id,
      operation: "set_property",
      property: "text",
      from: "Original title",
      value: "Updated title"
    }]
  });
  const desired = desiredSnapshots(batch.nodes, batch.operations);
  assert.equal(desired[0].measurement.frame, "structural");
  assert.equal(desired[0].text, "Updated title");
});
