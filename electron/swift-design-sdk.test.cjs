const assert = require("node:assert/strict");
const test = require("node:test");
const { readFile } = require("node:fs/promises");
const path = require("node:path");

test("ships a debug-only SwiftUI design-node SDK with non-greedy measurement", async () => {
  const source = await readFile(path.join(__dirname, "..", "swift-sdk", "UISyncDesignNode.swift"), "utf8");
  assert.match(source, /#if DEBUG/);
  assert.match(source, /\.background\s*\{/);
  assert.match(source, /proxy\.frame\(in: \.named\("DesignCanvas"\)\)/);
  assert.match(source, /coordinateSpace\(name: "DesignCanvas"\)/);
  assert.match(source, /case interact/);
  assert.match(source, /case select/);
  assert.doesNotMatch(source, /GeometryReader\s*\{[^}]*content/s);
});
