const test = require("node:test");
const assert = require("node:assert/strict");
const { SOURCE_ATTRIBUTE, createSourceAnchorPlugin, parseSourceAnchor } = require("./source-anchors.cjs");

// Babel parses the JSX and leaves it as JSX; only this plugin's effect shows,
// which is what is being tested.
const babel = require("@babel/core");

const transform = (code, filename, root = "/repo") => babel.transformSync(code, {
  filename,
  configFile: false,
  babelrc: false,
  parserOpts: { plugins: ["jsx", "typescript"] },
  plugins: [createSourceAnchorPlugin(root)]
}).code;

test("every element says which file and line it was written on", () => {
  const out = transform(`export const A = () => <div><span>hi</span></div>;`, "/repo/src/A.jsx");
  assert.match(out, /data-ui-sync-src="src\/A\.jsx:1:\d+"/);
  assert.equal((out.match(/data-ui-sync-src/g) ?? []).length, 2, "the span gets one too");
});

test("the path is relative, so no home directory reaches a handoff page", () => {
  const out = transform(`export const A = () => <div />;`, "/Users/someone/Documents/app/src/A.jsx", "/Users/someone/Documents/app");
  assert.ok(!out.includes("/Users/someone"), out);
  assert.match(out, /src\/A\.jsx/);
});

test("code outside the project is left alone", () => {
  const out = transform(`export const A = () => <div />;`, "/elsewhere/node_modules/lib/x.jsx", "/repo");
  assert.ok(!out.includes(SOURCE_ATTRIBUTE));
});

test("an element that already carries one is not given a second", () => {
  const out = transform(`export const A = () => <div data-ui-sync-src="kept" />;`, "/repo/src/A.jsx");
  assert.equal((out.match(/data-ui-sync-src/g) ?? []).length, 1);
  assert.match(out, /"kept"/);
});

test("an anchor names a place that can be edited", () => {
  assert.deepEqual(parseSourceAnchor("src/components/Header.tsx:42:7"), {
    file: "src/components/Header.tsx", line: 42, column: 7
  });
  assert.equal(parseSourceAnchor("nonsense"), null);
});
