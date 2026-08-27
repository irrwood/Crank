const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readdir } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { createSnapshotStore } = require("./snapshot-store.cjs");
const { lighten, linksIn, snapshotReferencesIn, withSnapshots } = require("./inventory-lite.cjs");

const store = async () => createSnapshotStore(await mkdtemp(path.join(tmpdir(), "crank-snap-")));

const page = (id, html) => ({
  id, name: id, route: "/", recipe: [], depth: 0,
  layerTree: { width: 100, height: 100, tree: { kind: "element" } },
  snapshot: { html, bytes: html.length, stats: { rasterised: [] } }
});

const DOC = `<!doctype html><html><body>
  <a href="/settings" class="nav"><span>设置</span></a>
  <a href="/log">All   records</a>
  <div>not a link</div>
</body></html>`;

test("reads the links the flow view draws, without a DOM", () => {
  assert.deepEqual(linksIn(DOC), [
    { href: "/settings", label: "设置" },
    { href: "/log", label: "All records" }
  ]);
});

test("a page with no markup has no links rather than throwing", () => {
  assert.deepEqual(linksIn(null), []);
  assert.deepEqual(linksIn(""), []);
});

test("the document leaves the scan and the links stay in it", async () => {
  const snapshots = await store();
  const light = await lighten({ pages: [page("home", DOC)] }, snapshots);
  const snapshot = light.pages[0].snapshot;
  assert.equal(snapshot.html, undefined);
  assert.match(snapshot.ref, /^crank-snapshot:\/\/[a-f0-9]{40}\.html$/);
  assert.equal(snapshot.links.length, 2);
  assert.equal(snapshot.bytes, DOC.length);
  // Everything else about the page is untouched.
  assert.equal(light.pages[0].layerTree.width, 100);
});

test("what left can be read back, byte for byte", async () => {
  const snapshots = await store();
  const light = await lighten({ pages: [page("home", DOC)] }, snapshots);
  const full = await withSnapshots(light, snapshots);
  assert.equal(full.pages[0].snapshot.html, DOC);
});

test("the same document twice is one file", async () => {
  const snapshots = await store();
  await lighten({ pages: [page("a", DOC), page("b", DOC)] }, snapshots);
  assert.equal((await readdir(snapshots.root)).length, 1);
});

test("a variant's document is put away too", async () => {
  const snapshots = await store();
  const withVariant = {
    pages: [{ ...page("home", DOC), variants: [{ id: "home-dark", name: "Dark", snapshot: { html: DOC, bytes: DOC.length } }] }]
  };
  const light = await lighten(withVariant, snapshots);
  assert.equal(light.pages[0].variants[0].snapshot.html, undefined);
  assert.match(light.pages[0].variants[0].snapshot.ref, /^crank-snapshot:/);
});

test("a page that never had markup is left as it was", async () => {
  const snapshots = await store();
  const light = await lighten({ pages: [{ id: "a", snapshot: null }, { id: "b" }] }, snapshots);
  assert.equal(light.pages[0].snapshot, null);
  assert.equal(light.pages[1].snapshot, null);
});

test("a document that has gone leaves the page readable rather than failing", async () => {
  const snapshots = await store();
  const full = await withSnapshots({ pages: [{ id: "a", snapshot: { ref: `crank-snapshot://${"0".repeat(40)}.html`, bytes: 10 } }] }, snapshots);
  assert.equal(full.pages[0].snapshot.html, undefined);
  assert.equal(full.pages[0].snapshot.bytes, 10);
});

test("a sweep can tell which documents are still pointed at", async () => {
  const snapshots = await store();
  const light = await lighten({ pages: [page("home", DOC)] }, snapshots);
  const live = snapshotReferencesIn(light);
  assert.equal(live.size, 1);
  assert.deepEqual(await snapshots.collect(live), { removed: 0 });
  assert.deepEqual(await snapshots.collect(new Set()), { removed: 1 });
  assert.equal(await snapshots.read(light.pages[0].snapshot.ref), null);
});
