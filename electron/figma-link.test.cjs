const test = require("node:test");
const assert = require("node:assert/strict");
const { parseFigmaDesignUrl } = require("./figma-link.cjs");

test("parses a Figma design and exact frame link", () => {
  const result = parseFigmaDesignUrl(
    "https://www.figma.com/design/ov2QEgsVLGAQWxstH3jXhQ/Sample?node-id=63-1995&t=abc",
    true
  );
  assert.deepEqual(result, {
    fileKey: "ov2QEgsVLGAQWxstH3jXhQ",
    fileName: "Sample",
    nodeId: "63:1995"
  });
});

test("accepts a file link without a selected frame", () => {
  const result = parseFigmaDesignUrl("https://figma.com/design/fileKey/Travel-App");
  assert.equal(result.fileName, "Travel App");
  assert.equal(result.nodeId, null);
});

test("rejects non-Figma hosts and missing frame selections", () => {
  assert.throws(() => parseFigmaDesignUrl("https://example.com/design/key/File"), /figma.com/);
  assert.throws(() => parseFigmaDesignUrl("https://figma.com/design/key/File", true), /exact Figma frame/);
});
