const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_SCREENS, renderPaperDocument } = require("./paper-export.cjs");

const box = (extra = {}) => ({
  kind: "element", name: "Root", x: 0, y: 0, width: 390, height: 844,
  style: { backgroundColor: "rgb(255, 255, 255)", borderRadius: 0 },
  children: [
    { kind: "text", name: "Title", x: 24, y: 60, width: 200, height: 28, text: "全部记录",
      style: { color: "rgb(20, 20, 20)", fontSize: 22, fontWeight: 600 } },
    { kind: "image", name: "Shot", x: 24, y: 120, width: 342, height: 200, dataUrl: "data:image/png;base64,AAAA" }
  ],
  ...extra
});

const inventory = {
  origin: "http://localhost:5199",
  pages: [
    { id: "state-a", name: "Home", route: "/", recipe: [], depth: 0,
      layerTree: { width: 390, height: 844, tree: box() } },
    { id: "state-b", name: "记录", route: "/log", recipe: [], depth: 1,
      layerTree: { width: 390, height: 844, tree: box() } },
    { id: "state-c", name: "No layers", route: "/x", recipe: [], depth: 0,
      layerTree: null, layerError: "The page never stopped moving" }
  ]
};

test("pastes every captured screen, side by side", async () => {
  const result = await renderPaperDocument(inventory);
  assert.equal(result.ok, true);
  assert.deepEqual(result.screens, ["Home", "记录"]);
  assert.match(result.html, /data-name="Home"/);
  assert.match(result.html, /data-name="记录"/);
  // The second screen starts past the first one plus the gap, so the two do
  // not land on top of each other.
  assert.match(result.html, /left:550px/);
});

test("is plain HTML and CSS, which is the whole reason Paper can read it", async () => {
  const { html } = await renderPaperDocument(inventory);
  assert.match(html, /<div[^>]+style="[^"]*position:absolute/);
  assert.match(html, /全部记录/);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.ok(!/<script/i.test(html), "nothing executable may be pasted into a design tool");
  assert.ok(!/<link/i.test(html), "no stylesheet may be reached for");
});

test("carries a screen's identity so a later push could find it again", async () => {
  const { html } = await renderPaperDocument(inventory);
  assert.match(html, /data-crank-screen="state-a"/);
});

test("names the pages it left out, and why", async () => {
  const result = await renderPaperDocument(inventory);
  assert.deepEqual(result.missing, ["No layers"]);
  assert.deepEqual(result.missingReasons, ["The page never stopped moving"]);
});

test("copies one page when one is asked for", async () => {
  const result = await renderPaperDocument(inventory, { pageId: "state-b" });
  assert.deepEqual(result.screens, ["记录"]);
  assert.ok(!result.html.includes('data-name="Home"'));
});

test("refuses a page that is no longer in the scan", async () => {
  const result = await renderPaperDocument(inventory, { pageId: "gone" });
  assert.equal(result.ok, false);
  assert.match(result.message, /no longer in this scan/);
});

test("reports a scan with nothing captured instead of pasting empty boxes", async () => {
  const result = await renderPaperDocument({ pages: [inventory.pages[2]] });
  assert.equal(result.ok, false);
  assert.match(result.message, /never stopped moving/);
});

test("tells an iOS vector scan how to get layers, rather than reporting none", async () => {
  const result = await renderPaperDocument({
    platform: "swiftui",
    pages: [{ id: "state-v", name: "Today", route: "", recipe: [], depth: 0, layerTree: null,
      vector: { pageId: "pdf-page-1", width: 390, height: 844 } }]
  });
  assert.equal(result.ok, false);
  assert.match(result.message, /display list/);
});

test("says a paste is too big rather than pasting half of it", async () => {
  const heavy = {
    pages: [{
      id: "heavy", name: "Heavy", route: "/", recipe: [], depth: 0,
      layerTree: {
        width: 390, height: 844,
        tree: box({ children: Array.from({ length: 200 }, (_, index) => ({
          kind: "image", name: `Shot ${index}`, x: 0, y: index, width: 390, height: 100,
          dataUrl: `data:image/png;base64,${"A".repeat(120_000)}`
        })) })
      }
    }]
  };
  const result = await renderPaperDocument(heavy);
  assert.equal(result.ok, false);
  assert.match(result.message, /more than one paste carries/);
});

test("carries no more screens than a send does, and names the rest", async () => {
  const many = {
    pages: Array.from({ length: MAX_SCREENS + 2 }, (_, index) => ({
      id: `state-${index}`, name: `Page ${index}`, route: "/", recipe: [], depth: 0,
      layerTree: { width: 390, height: 844, tree: box({ children: [] }) }
    }))
  };
  const result = await renderPaperDocument(many);
  assert.equal(result.screens.length, MAX_SCREENS);
  assert.deepEqual(result.dropped, [`Page ${MAX_SCREENS}`, `Page ${MAX_SCREENS + 1}`]);
});
