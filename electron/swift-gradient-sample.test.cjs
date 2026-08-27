const test = require("node:test");
const assert = require("node:assert/strict");
const { PNG } = require("pngjs");
const { createScreenshotSampler } = require("./swift-gradient-sample.cjs");

/**
 * A screen 402x874 points, shot at 2x like a real device, painted with a
 * top-to-bottom gradient — and optionally with something sitting on top of it,
 * the way a real background has a card and a button on it.
 */
function shot({ scale = 2, top = [230, 240, 255], bottom = [255, 255, 255], widget = null, width = 402, height = 874 } = {}) {
  const png = new PNG({ width: Math.round(width * scale), height: Math.round(height * scale) });
  for (let y = 0; y < png.height; y += 1) {
    const mix = y / (png.height - 1);
    for (let x = 0; x < png.width; x += 1) {
      const index = (png.width * y + x) << 2;
      const inWidget = widget
        && x >= widget.x * scale && x < (widget.x + widget.width) * scale
        && y >= widget.y * scale && y < (widget.y + widget.height) * scale;
      const colour = inWidget
        ? widget.colour
        : [0, 1, 2].map((channel) => Math.round(top[channel] + (bottom[channel] - top[channel]) * mix));
      png.data[index] = colour[0];
      png.data[index + 1] = colour[1];
      png.data[index + 2] = colour[2];
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
}

const viewport = { width: 402, height: 874 };
const screen = { x: 0, y: 0, width: 402, height: 874 };

test("reads a background's colours off the picture the app drew", () => {
  const sampler = createScreenshotSampler(shot(), viewport);
  const fill = sampler.fillFor(screen);
  assert.equal(fill.kind, "gradient");
  assert.equal(fill.vertical, true);
  const first = fill.stops[0].colour;
  const last = fill.stops[fill.stops.length - 1].colour;
  assert.ok(Math.abs(first.b - 255) <= 2 && first.r < 240, `top should be the pale blue, got ${JSON.stringify(first)}`);
  assert.ok(last.r > 250 && last.g > 250, `bottom should be near white, got ${JSON.stringify(last)}`);
});

test("what sits on the background does not become the background", () => {
  // A card down the middle of the screen, wide but not most of any row.
  const covered = createScreenshotSampler(shot({ widget: { colour: [255, 0, 0], height: 800, width: 160, x: 120, y: 20 } }), viewport);
  const plain = createScreenshotSampler(shot(), viewport);
  const a = covered.fillFor(screen).stops.map((stop) => stop.colour);
  const b = plain.fillFor(screen).stops.map((stop) => stop.colour);
  assert.deepEqual(a, b);
});

test("a flat area is reported flat rather than as a gradient of one colour", () => {
  const sampler = createScreenshotSampler(shot({ bottom: [230, 240, 255] }), viewport);
  const fill = sampler.fillFor(screen);
  assert.equal(fill.kind, "flat");
  assert.deepEqual(fill.flat, { r: 230, g: 240, b: 255 });
});

test("a side-to-side gradient is read across, not down", () => {
  const png = new PNG({ width: 402, height: 874 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (png.width * y + x) << 2;
      png.data[index] = Math.round((x / (png.width - 1)) * 255);
      png.data[index + 1] = 40;
      png.data[index + 2] = 40;
      png.data[index + 3] = 255;
    }
  }
  const sampler = createScreenshotSampler(PNG.sync.write(png).toString("base64"), viewport);
  assert.equal(sampler.fillFor(screen).vertical, false);
});

test("a shape too small to read is left alone", () => {
  const sampler = createScreenshotSampler(shot(), viewport);
  assert.equal(sampler.fillFor({ x: 10, y: 10, width: 4, height: 90 }), null);
});

test("a picture of a differently shaped screen is not sampled", () => {
  // A shot taken before a rotation is a picture of something else.
  assert.equal(createScreenshotSampler(shot({ height: 402, width: 874 }), viewport), null);
});

test("no picture, or one that cannot be read, is no sampler", () => {
  assert.equal(createScreenshotSampler(null, viewport), null);
  assert.equal(createScreenshotSampler("not-a-png", viewport), null);
  assert.equal(createScreenshotSampler(shot(), { width: 0, height: 0 }), null);
});
