const test = require("node:test");
const assert = require("node:assert/strict");
const { baselineOf, familyOf, paintOf, renderFigmaSvg } = require("./figma-clipboard.cjs");

const element = (over = {}) => ({
  kind: "element", x: 0, y: 0, width: 100, height: 40, id: "n", name: "Box",
  style: { backgroundColor: "rgb(255, 255, 255)", borderRadius: 8, opacity: 1, clipsContent: false, boxShadow: null },
  children: [],
  ...over
});

const scan = (tree, over = {}) => ({
  pages: [{ id: "p1", name: "Home", layerTree: { width: 200, height: 100, tree }, ...over }]
});

test("a colour with no alpha is not drawn at all", () => {
  // Otherwise every group arrives as an invisible rectangle covering its own
  // children, and the whole screen becomes unselectable.
  assert.equal(paintOf("rgba(0, 0, 0, 0)"), null);
  assert.equal(paintOf("transparent"), null);
  assert.equal(paintOf(""), null);
  assert.deepEqual(paintOf("rgba(0, 145, 255, 0.15)"), { fill: "rgb(0, 145, 255)", opacity: 0.15 });
  assert.deepEqual(paintOf("rgb(255, 255, 255)"), { fill: "rgb(255, 255, 255)", opacity: 1 });
});

test("only the first family survives, because Figma takes one", () => {
  assert.equal(familyOf({ fontFamily: "'SF Pro Text', SF Pro, system-ui" }), "SF Pro Text");
  assert.equal(familyOf({}), "Inter");
});

test("text is placed on its baseline, not on the top of its line box", () => {
  // 16px text on a 24px line: 4px of leading above, then 80% of the size.
  assert.equal(baselineOf(0, { fontSize: 16, lineHeight: 24 }), 4 + 12.8);
});

test("a screen becomes an SVG with its layers inside", async () => {
  const result = await renderFigmaSvg(scan(element({
    children: [{
      kind: "text", x: 10, y: 12, width: 60, height: 16, id: "t", name: "Label",
      text: "Saved", layoutX: 10, layoutWidth: 60,
      style: { color: "rgb(20, 20, 20)", fontSize: 13, fontWeight: 600, lineHeight: 16, fontFamily: "Inter", textAlign: "left" }
    }]
  })));
  assert.equal(result.ok, true);
  assert.match(result.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(result.svg, /<rect [^>]*rx="8"/);
  assert.match(result.svg, /font-size="13" font-weight="600"/);
  assert.match(result.svg, />Saved<\/text>/);
  assert.deepEqual(result.screens, ["Home"]);
});

test("a group with nothing drawn of its own is still a group", async () => {
  const result = await renderFigmaSvg(scan(element({
    style: { backgroundColor: "rgba(0, 0, 0, 0)", borderRadius: 0, opacity: 1 },
    children: [{ kind: "text", x: 4, y: 4, width: 20, height: 10, id: "t", text: "Hi", style: { fontSize: 10 } }]
  })));
  assert.match(result.svg, /<g transform="translate\(0, 0\)"[^>]*>(?!.*<rect)/s);
  assert.match(result.svg, />Hi<\/text>/);
});

test("a layer the capture marked hidden is not pasted", async () => {
  const result = await renderFigmaSvg(scan(element({
    children: [{ kind: "element", x: 0, y: 0, width: 10, height: 10, id: "h", style: { visible: false, backgroundColor: "rgb(255, 0, 0)" }, children: [] }]
  })));
  assert.doesNotMatch(result.svg, /rgb\(255, 0, 0\)/);
});

test("an image travels as its own pixels", async () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const result = await renderFigmaSvg(scan(element({
    children: [{ kind: "image", x: 0, y: 0, width: 20, height: 20, id: "i", dataUrl, style: {} }]
  })));
  assert.match(result.svg, /<image [^>]*href="data:image\/png;base64,iVBORw0KGgo="/);
});

test("text with markup in it cannot break out of the document", async () => {
  const result = await renderFigmaSvg(scan(element({
    children: [{ kind: "text", x: 0, y: 0, width: 50, height: 10, id: "t", text: "<script>&\"'", style: { fontSize: 10 } }]
  })));
  assert.match(result.svg, />&lt;script&gt;&amp;&quot;&apos;<\/text>/);
});

test("several screens are laid out in a row, spaced like the Paper export", async () => {
  const two = { pages: [
    { id: "a", name: "One", layerTree: { width: 100, height: 60, tree: element({ width: 100, height: 60 }) } },
    { id: "b", name: "Two", layerTree: { width: 100, height: 80, tree: element({ width: 100, height: 80 }) } }
  ] };
  const result = await renderFigmaSvg(two);
  assert.deepEqual(result.screens, ["One", "Two"]);
  assert.match(result.svg, /translate\(260, 0\)/);   // 100 + 160 gap
  assert.match(result.svg, /width="360" height="80"/);
});

test("a scan with no captured layers says so, and says it about Figma", async () => {
  const result = await renderFigmaSvg({ pages: [{ id: "a", name: "One", layerTree: null, vector: { pageId: "pdf-page-1" } }] });
  assert.equal(result.ok, false);
  assert.match(result.message, /for Figma/);
  assert.match(result.message, /exported vector pages/);
});

test("one page can be copied on its own", async () => {
  const two = { pages: [
    { id: "a", name: "One", layerTree: { width: 100, height: 60, tree: element() } },
    { id: "b", name: "Two", layerTree: { width: 100, height: 60, tree: element() } }
  ] };
  const result = await renderFigmaSvg(two, { pageId: "b" });
  assert.deepEqual(result.screens, ["Two"]);
});
