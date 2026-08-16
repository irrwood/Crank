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

test("carries its own images so the file stands alone", () => {
  const html = renderHandoffPage(inventory);
  assert.match(html, /data:image\/png;base64,AAAA/);
  assert.ok(!/<img[^>]+src="(?!data:)/.test(html), "no image may point outside the file");
  assert.ok(!/https?:\/\/[^"']*\.(?:css|js)/.test(html), "no external stylesheet or script");
});

test("shows every page with a reproducible address", () => {
  const html = renderHandoffPage(inventory);
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

test("reports what was left out, with the number that decided it", () => {
  const html = renderHandoffPage(inventory);
  assert.match(html, /Search tasks — changed 0\.7% of the screen/);
});

test("escapes page names rather than trusting them", () => {
  const html = renderHandoffPage({
    ok: true, origin: "http://x", filtered: [],
    pages: [{ id: "s", name: '<img src=x onerror="alert(1)">', route: "/", recipe: [], depth: 0, thumbnail: null }]
  });
  assert.ok(!html.includes('onerror="alert(1)"'), "a page name must not become markup");
  assert.match(html, /&lt;img src=x/);
});

test("survives an empty scan", () => {
  const html = renderHandoffPage({ ok: true, origin: "http://x", pages: [], filtered: [] });
  assert.match(html, /No pages were found/);
});
