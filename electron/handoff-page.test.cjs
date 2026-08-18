const test = require("node:test");
const assert = require("node:assert/strict");
const { addressOf, renderHandoffPage } = require("./handoff-page.cjs");

const inventory = {
  ok: true,
  origin: "http://localhost:5199",
  pages: [
    { id: "state-a", name: "Home", route: "/", recipe: [], depth: 0,
      thumbnail: { dataUrl: "data:image/png;base64,AAAA", width: 100, height: 60 } },
    { id: "state-b", name: "全部记录", route: "/", depth: 1,
      recipe: [{ kind: "click", locator: "#all", label: "全部记录" }],
      thumbnail: { dataUrl: "data:image/png;base64,BBBB", width: 100, height: 60 } },
    { id: "state-c", name: "No shot", route: "/x", recipe: [], depth: 0, thumbnail: null }
  ],
  filtered: [{ label: "Search tasks", from: "Home", reason: "too small", magnitude: 0.007 }],
  skipped: []
};

test("carries its own images so the file stands alone", async () => {
  const html = await renderHandoffPage(inventory);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.ok(!/<img[^>]+src="(?!data:)/.test(html), "no image may point outside the file");
  assert.ok(!/https?:\/\/[^"']*\.(?:css|js)/.test(html), "no external stylesheet or script");
});

test("shows every page with a reproducible address", async () => {
  const html = await renderHandoffPage(inventory);
  assert.match(html, /All pages/);
  assert.match(html, /全部记录/);
  assert.match(html, /click “全部记录”/);
  assert.match(html, /3 pages/);
  assert.match(html, /No screenshot was captured/);
});

test("states the address as steps only when clicks are needed", () => {
  assert.equal(addressOf(inventory.pages[0]), "/");
  assert.equal(addressOf(inventory.pages[1]), "/ → click “全部记录”");
});

test("reports what was left out, with the number that decided it", async () => {
  const html = await renderHandoffPage(inventory);
  assert.match(html, /Search tasks — changed 0\.7% of the screen/);
});

test("escapes page names rather than trusting them", async () => {
  const html = await renderHandoffPage({
    ok: true, origin: "http://x", filtered: [],
    pages: [{ id: "s", name: '<img src=x onerror="alert(1)">', route: "/", recipe: [], depth: 0, thumbnail: null }]
  });
  assert.ok(!html.includes('onerror="alert(1)"'), "a page name must not become markup");
  assert.match(html, /&lt;img src=x/);
});

test("survives an empty scan", async () => {
  const html = await renderHandoffPage({ ok: true, origin: "http://x", pages: [], filtered: [] });
  assert.match(html, /No pages were found/);
});

test("gives a re-skinned page one slot with a toggle", async () => {
  const html = await renderHandoffPage({
    ok: true, origin: "http://x", filtered: [],
    pages: [{
      id: "state-a", name: "Home", route: "/", recipe: [], depth: 0,
      thumbnail: { dataUrl: "data:image/png;base64,LIGHT", width: 10, height: 10 },
      variants: [
        { id: "state-a-variant-1", name: "Dark", route: "/", recipe: [],
          thumbnail: { dataUrl: "data:image/png;base64,DARK", width: 10, height: 10 } },
        { id: "state-a-variant-2", name: "中文", route: "/", recipe: [],
          thumbnail: { dataUrl: "data:image/png;base64,ZH", width: 10, height: 10 } }
      ]
    }]
  });
  // One page in the gallery, three looks inside it.
  assert.equal((html.match(/<figure>/g) ?? []).length, 1);
  assert.match(html, /base64,LIGHT/);
  assert.match(html, /base64,DARK/);
  assert.match(html, /data-look-pick="1"[^>]*>Dark/);
  assert.match(html, /中文/);
  assert.match(html, /hidden/, "only the first look is visible at rest");
});

test("shows no toggle when a page has one look", async () => {
  const html = await renderHandoffPage({
    ok: true, origin: "http://x", filtered: [],
    pages: [{ id: "s", name: "Home", route: "/", recipe: [], depth: 0, variants: [],
      thumbnail: { dataUrl: "data:image/png;base64,A", width: 10, height: 10 } }]
  });
  // The string appears in the inline script regardless; check for a rendered button.
  assert.ok(!/<button[^>]*data-look-pick/.test(html), "a single look needs no switcher");
  assert.ok(!html.includes('class="looks"'), "and no switcher row");
});

test("draws the layers rather than a picture of them", async () => {
  const html = await renderHandoffPage({
    ok: true, origin: "http://x", filtered: [],
    pages: [{
      id: "s", name: "Analytics", route: "/analytics", recipe: [], depth: 0, variants: [],
      thumbnail: { dataUrl: "data:image/png;base64,A", width: 10, height: 10 },
      layerTree: {
        tree: {
          kind: "element", id: "root", x: 0, y: 0, width: 1220, height: 790,
          style: { backgroundColor: "rgb(255, 255, 255)" },
          children: [
            { kind: "text", id: "t", x: 40, y: 32, width: 300, height: 38, text: "Analytics",
              style: { color: "rgb(17, 17, 17)", fontSize: 32, fontWeight: 600 } },
            { kind: "image", id: "i", x: 40, y: 96, width: 200, height: 120, dataUrl: "data:image/webp;base64,CHART" }
          ]
        }
      }
    }]
  });
  assert.match(html, /class="layers"[^>]*style="height:790px;width:1220px"/, "drawn at the size it was captured");
  assert.match(html, /font-size:32px/, "with the captured type");
  assert.match(html, />Analytics</, "and the text as text, selectable and sharp");
  assert.match(html, /base64,CHART/, "images inside the drawing come with it");
  assert.ok(!html.includes("<iframe"), "no foreign document is embedded");
  // The grid still uses the thumbnail for speed.
  assert.match(html, /base64,A/);
});

test("a page name inside the layers cannot become markup", async () => {
  const html = await renderHandoffPage({
    ok: true, origin: "http://x", filtered: [],
    pages: [{
      id: "s", name: "Home", route: "/", recipe: [], depth: 0, variants: [], thumbnail: null,
      layerTree: { tree: { kind: "text", id: "t", x: 0, y: 0, width: 10, height: 10,
        text: '<img src=x onerror="alert(1)">', style: {} } }
    }]
  });
  assert.ok(!html.includes('onerror="alert(1)"'), "captured text is someone else's content");
  assert.match(html, /&lt;img src=x/);
});

test("says so when the layers could not be read", async () => {
  const html = await renderHandoffPage({
    ok: true, origin: "http://x", filtered: [],
    pages: [{ id: "s", name: "Home", route: "/", recipe: [], depth: 0, variants: [],
      layerTree: { error: "The page returned no layer tree." },
      thumbnail: { dataUrl: "data:image/png;base64,B", width: 10, height: 10 } }]
  });
  assert.match(html, /could not be read: The page returned no layer tree/);
});

test("falls back to the thumbnail when no layers were captured", async () => {
  const html = await renderHandoffPage({
    ok: true, origin: "http://x", filtered: [],
    pages: [{ id: "s", name: "Home", route: "/", recipe: [], depth: 0, variants: [], layerTree: null,
      thumbnail: { dataUrl: "data:image/png;base64,B", width: 10, height: 10 } }]
  });
  assert.ok(!html.includes('class="layers"'), "no empty drawing when there is nothing to draw");
  assert.match(html, /base64,B/);
});
