const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeTargetUrl, parseSitemapPaths } = require("./page-inventory.cjs");

test("accepts the addresses people actually type", () => {
  assert.deepEqual(normalizeTargetUrl("localhost:8000"), { ok: true, origin: "http://localhost:8000", startPath: "/" });
  assert.equal(normalizeTargetUrl("http://127.0.0.1:3000/dashboard").startPath, "/dashboard");
  assert.equal(normalizeTargetUrl("https://staging.example.com").origin, "https://staging.example.com");
  assert.equal(normalizeTargetUrl("  localhost:5173  ").origin, "http://localhost:5173");
});

test("rejects what cannot be scanned", () => {
  assert.equal(normalizeTargetUrl("").ok, false);
  assert.equal(normalizeTargetUrl("   ").ok, false);
  assert.equal(normalizeTargetUrl("file:///Users/me/index.html").ok, false);
  assert.match(normalizeTargetUrl("ht!tp://nope").message, /not a valid address|Only http/);
});

test("reads page addresses from a sitemap and ignores foreign hosts", () => {
  const xml = `<?xml version="1.0"?><urlset>
    <url><loc>http://localhost:8000/</loc></url>
    <url><loc>http://localhost:8000/holdings</loc></url>
    <url><loc>http://localhost:8000/holdings</loc></url>
    <url><loc>https://cdn.example.com/asset</loc></url>
  </urlset>`;
  assert.deepEqual(parseSitemapPaths(xml, "http://localhost:8000"), ["/", "/holdings"]);
  assert.deepEqual(parseSitemapPaths(null, "http://localhost:8000"), []);
  assert.deepEqual(parseSitemapPaths("not xml", "http://localhost:8000"), []);
});

test("keeps a query string a query string", () => {
  // "/?view=settings" must not become the path "/%3Fview=settings", which
  // loads the default view and silently records the wrong screen.
  const resolved = new URL("/?view=settings", "http://localhost:5173");
  assert.equal(resolved.pathname, "/");
  assert.equal(resolved.search, "?view=settings");
  assert.equal(normalizeTargetUrl("http://localhost:5173/?view=settings").startPath, "/?view=settings");
});
