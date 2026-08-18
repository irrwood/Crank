const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { declaresWorkspace, normalizeTargetUrl, parseSitemapPaths, scanFolder } = require("./page-inventory.cjs");

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

test("a folder that declares its packages is a workspace, whatever its dev script does", async () => {
  // A monorepo root usually has a dev script, but it orchestrates rather than
  // serves: `pnpm --parallel --filter a --filter b dev` starts two applications
  // and no single address, so treating the root as runnable started that
  // command and then scanned nothing. The project already answers the right
  // question by declaring its packages.
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-workspace-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "monorepo", scripts: { dev: "pnpm --parallel --filter a --filter b dev" }
    }));
    assert.equal(await declaresWorkspace(root), false, "a dev script alone says nothing");

    await writeFile(path.join(root, "pnpm-workspace.yaml"), "packages:\n  - apps/*\n");
    assert.equal(await declaresWorkspace(root), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("npm and yarn declare it in the manifest instead", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-workspace-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", workspaces: ["apps/*"] }));
    assert.equal(await declaresWorkspace(root), true);

    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", workspaces: { packages: ["apps/*"] } }));
    assert.equal(await declaresWorkspace(root), true, "the object form counts too");

    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", workspaces: [] }));
    assert.equal(await declaresWorkspace(root), false, "an empty declaration declares nothing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a folder that merely contains projects is still scanned itself", async () => {
  // A portfolio with a couple of demos in it declares no packages, so dropping
  // it still means "scan this", with the demos registered alongside.
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-site-"));
  try {
    await writeFile(path.join(root, "index.html"), "<h1>Portfolio</h1>");
    assert.equal(await declaresWorkspace(root), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
