const test = require("node:test");
const assert = require("node:assert/strict");
const { parseBoxShadow, parseShadow, splitShadows } = require("./box-shadow.cjs");

test("reads the form the browser actually hands back", () => {
  const [shadow] = parseBoxShadow("rgba(0, 0, 0, 0.08) 0px 2px 10px 0px");
  assert.equal(shadow.type, "DROP_SHADOW");
  assert.deepEqual(shadow.offset, { x: 0, y: 2 });
  assert.equal(shadow.radius, 5, "CSS blur is the whole spread; Figma's radius is half");
  assert.equal(shadow.spread, 0);
  assert.equal(Math.round(shadow.color.a * 100) / 100, 0.08);
});

test("commas inside rgba do not split one shadow into two", () => {
  const shadows = parseBoxShadow("rgba(0, 0, 0, 0.2) 0px 1px 2px 0px, rgba(0, 0, 0, 0.1) 0px 8px 24px 0px");
  assert.equal(shadows.length, 2);
  assert.deepEqual(shadows.map((s) => s.offset.y), [1, 8]);
  assert.equal(splitShadows("rgb(1, 2, 3) 0px 0px").length, 1);
});

test("an inner shadow is a different kind of effect, not a misplaced one", () => {
  assert.equal(parseShadow("rgba(0, 0, 0, 0.3) 0px 2px 4px 0px inset").type, "INNER_SHADOW");
  assert.equal(parseShadow("inset rgb(0, 0, 0) 1px 1px").type, "INNER_SHADOW");
});

test("negative offsets and spread survive", () => {
  const shadow = parseShadow("rgba(10, 20, 30, 0.5) -4px -8px 12px 3px");
  assert.deepEqual(shadow.offset, { x: -4, y: -8 });
  assert.equal(shadow.radius, 6);
  assert.equal(shadow.spread, 3);
});

test("what cannot be read is left out rather than guessed", () => {
  // A shadow drawn in the wrong place is worse than no shadow.
  assert.equal(parseShadow("none"), null);
  assert.equal(parseShadow("currentcolor 0px 2px"), null, "an unresolved colour is not a colour");
  assert.equal(parseShadow("rgb(0, 0, 0)"), null, "no offsets at all");
  assert.deepEqual(parseBoxShadow("none"), []);
  assert.deepEqual(parseBoxShadow(null), []);
});
