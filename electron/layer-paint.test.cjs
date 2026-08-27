const test = require("node:test");
const assert = require("node:assert/strict");

/**
 * `shared/` has no runner of its own, and what a layer looks like is decided
 * there for the window, the handoff file and everything sent to a design tool
 * at once — so it is tested with the rest of the exports rather than not at all.
 */
const painted = async (layer) => {
  const paint = await import("../shared/layer-paint.js");
  return paint.paintLayer(layer);
};

const box = (style, extra = {}) => ({ kind: "element", x: 0, y: 0, width: 100, height: 100, style, children: [], ...extra });

test("a shadow on a drawn box stays a box shadow", async () => {
  const result = await painted(box({ backgroundColor: "rgb(255, 255, 255)", boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 8px 0px" }));
  assert.equal(result.style.boxShadow, "rgba(0, 0, 0, 0.2) 0px 2px 8px 0px");
  assert.equal(result.style.filter, undefined);
});

test("a shadow on a box that draws nothing follows what is inside it", async () => {
  // SwiftUI's `.shadow()` arrives as an effect wrapped around the thing it
  // shades, so the wrapper is transparent and a box shadow would be a
  // rectangle around a circle.
  const result = await painted(box({ backgroundColor: "rgba(0, 0, 0, 0)", boxShadow: "rgba(8, 112, 219, 0.14) 0px 10px 36px 0px" }));
  assert.equal(result.style.boxShadow, undefined);
  assert.equal(result.style.filter, "drop-shadow(0px 10px 36px rgba(8, 112, 219, 0.14))");
});

test("a border is an edge to cast from, even with no fill", async () => {
  const result = await painted(box({ borderTopWidth: 1, borderTopColor: "rgb(0,0,0)", boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 8px" }));
  assert.equal(result.style.boxShadow, "rgba(0, 0, 0, 0.2) 0px 2px 8px");
});

test("two shadows on a transparent box both follow the shape", async () => {
  const result = await painted(box({ boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 8px, rgba(255, 0, 0, 0.5) 1px 1px 2px" }));
  assert.equal(result.style.filter, "drop-shadow(0px 2px 8px rgba(0, 0, 0, 0.2)) drop-shadow(1px 1px 2px rgba(255, 0, 0, 0.5))");
});

test("an inset shadow is left as it is, having no outside to cast", async () => {
  const result = await painted(box({ boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 8px inset" }));
  assert.equal(result.style.boxShadow, "rgba(0, 0, 0, 0.2) 0px 2px 8px inset");
});

test("a shadow written in a way this cannot read is kept rather than dropped", async () => {
  const result = await painted(box({ boxShadow: "some-future-syntax" }));
  assert.equal(result.style.boxShadow, "some-future-syntax");
  assert.equal(result.style.filter, undefined);
});

const text = (style) => ({ kind: "text", x: 0, y: 0, width: 100, height: 20, text: "Hi", style });

test("a measured web run keeps the family the browser actually used", async () => {
  const result = await painted(text({ resolvedFontFamily: "SF Pro Rounded", fontSize: 14 }));
  assert.equal(result.style.fontFamily, '"SF Pro Rounded", sans-serif');
});

test("a SwiftUI run is drawn in the stack it asked for, not in nothing at all", async () => {
  const result = await painted(text({ fontFamilies: ["SF Pro Text", "SF Pro", "system-ui"], fontSize: 22 }));
  assert.equal(result.style.fontFamily, '"SF Pro Text", "SF Pro", system-ui');
});

test("a keyword family is left unquoted, being a class of font and not one", async () => {
  const result = await painted(text({ fontFamilies: ["ui-rounded", "-apple-system", "Helvetica Neue"], fontSize: 12 }));
  assert.equal(result.style.fontFamily, 'ui-rounded, -apple-system, "Helvetica Neue", sans-serif');
});

test("a run with no font named is left to the page, as before", async () => {
  const result = await painted(text({ fontSize: 12 }));
  assert.equal(result.style.fontFamily, undefined);
});

test("a run measured as one line is drawn as one line", async () => {
  const result = await painted({ kind: "text", x: 0, y: 0, width: 84, height: 26, text: "坏猫很闲",
    style: { fontSize: 22, lineHeight: 26.4 } });
  assert.equal(result.style.whiteSpace, "nowrap");
});

test("a run that already wrapped in the app still wraps", async () => {
  const result = await painted({ kind: "text", x: 0, y: 0, width: 200, height: 53, text: "a longer paragraph",
    style: { fontSize: 22, lineHeight: 26.4 } });
  assert.equal(result.style.whiteSpace, "pre-wrap");
});

test("a material is drawn as frosted glass, not as tinted glass", async () => {
  const result = await painted(box({ backgroundColor: "rgba(246, 246, 246, 0.36)", backdropBlur: 15, backdropSaturation: 1.8 }));
  assert.equal(result.style.backdropFilter, "blur(15px) saturate(1.8)");
  assert.equal(result.style.background, "rgba(246, 246, 246, 0.36)");
});

test("a blur on content and a shadow off it share one filter", async () => {
  const result = await painted(box({ blur: 8, boxShadow: "rgba(0, 0, 0, 0.2) 0px 2px 8px" }));
  assert.equal(result.style.filter, "blur(8px) drop-shadow(0px 2px 8px rgba(0, 0, 0, 0.2))");
});

test("a box with neither is left with no filter at all", async () => {
  const result = await painted(box({ backgroundColor: "rgb(255, 255, 255)" }));
  assert.equal(result.style.filter, undefined);
  assert.equal(result.style.backdropFilter, undefined);
});

test("editor transforms and visibility apply to every kind of layer", async () => {
  const result = await painted({
    kind: "image",
    x: 8,
    y: 12,
    width: 100,
    height: 80,
    dataUrl: "data:image/png;base64,AA==",
    style: { flipX: true, opacity: 0.4, rotation: 15, visible: false }
  });
  assert.equal(result.style.opacity, 0.4);
  assert.equal(result.style.transform, "rotate(15deg) scaleX(-1)");
  assert.equal(result.style.transformOrigin, "center");
  assert.equal(result.style.visibility, "hidden");
});

test("hiding only the fill keeps the layer and its geometry", async () => {
  const result = await painted(box({ backgroundColor: "rgb(20, 30, 40)", fillVisible: false, opacity: 0.8 }));
  assert.equal(result.style.background, "transparent");
  assert.equal(result.style.opacity, 0.8);
  assert.equal(result.style.width, "100px");
});
