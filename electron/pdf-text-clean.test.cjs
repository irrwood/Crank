const assert = require("node:assert/strict");
const test = require("node:test");
const { PNG } = require("pngjs");
const { compareTextCleanPng } = require("./pdf-text-clean.cjs");

function page() {
  const png = new PNG({ width: 100, height: 100 });
  png.data.fill(255);
  return png;
}

function paint(png, left, top, right, bottom, value = 0) {
  for (let y = top; y < bottom; y += 1) for (let x = left; x < right; x += 1) {
    const offset = (y * png.width + x) * 4;
    png.data[offset] = value;
    png.data[offset + 1] = value;
    png.data[offset + 2] = value;
    png.data[offset + 3] = 255;
  }
}

test("accepts a text-clean render when differences stay inside captured text", () => {
  const normal = page();
  const clean = page();
  paint(normal, 20, 20, 35, 28);
  const result = compareTextCleanPng(normal, clean, [{ x: 20, y: 20, width: 15, height: 8 }], { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(result.safe, true);
  assert.equal(result.outsideChanged, 0);
});

test("rejects a text-clean render when the visual scene changes elsewhere", () => {
  const normal = page();
  const clean = page();
  paint(normal, 20, 20, 35, 28);
  paint(clean, 60, 50, 90, 80);
  const result = compareTextCleanPng(normal, clean, [{ x: 20, y: 20, width: 15, height: 8 }], { x: 0, y: 0, width: 100, height: 100 });
  assert.equal(result.safe, false);
  assert.equal(result.reason, "visual-baseline-changed");
});
