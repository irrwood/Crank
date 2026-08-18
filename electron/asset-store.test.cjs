const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, rm, readdir } = require("node:fs/promises");
const { createAssetStore, externalise, referencesIn } = require("./asset-store.cjs");

const withStore = async (run) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-assets-"));
  try { await run(createAssetStore(directory), directory); } finally { await rm(directory, { recursive: true, force: true }); }
};

const png = (body) => `data:image/png;base64,${Buffer.from(body).toString("base64")}`;

test("the same picture is one file however many pages show it", async () => {
  await withStore(async (store) => {
    const logo = png("a logo");
    const first = await store.put(logo);
    const second = await store.put(logo);
    assert.equal(first, second, "the same bytes are the same reference");
    assert.match(first, /^crank-asset:\/\/[a-f0-9]{40}\.png$/);
    assert.equal((await readdir(store.root)).length, 1, "and one file on disk");

    await store.put(png("something else"));
    assert.equal((await readdir(store.root)).length, 2);
  });
});

test("what was stored comes back byte for byte", async () => {
  await withStore(async (store) => {
    const reference = await store.put(png("exact bytes"));
    assert.equal((await store.read(reference)).toString(), "exact bytes");
    assert.equal(await store.dataUrl(reference), png("exact bytes"));
    assert.equal(await store.read("crank-asset://" + "0".repeat(40) + ".png"), null, "a reference to nothing is null, not a throw");
    assert.equal(await store.put("not a data url"), null);
  });
});

test("a scan keeps its shape, with the pictures lifted out of it", async () => {
  await withStore(async (store) => {
    const shared = png("shared across pages");
    const scan = {
      ok: true,
      pages: [
        { id: "a", thumbnail: { dataUrl: shared, width: 1220 }, layerTree: { tree: { kind: "image", dataUrl: shared } } },
        { id: "b", thumbnail: { dataUrl: shared, width: 1220 }, layerTree: { tree: { kind: "element", children: [{ kind: "image", dataUrl: png("only here") }] } } }
      ]
    };
    const lifted = await externalise(scan, store);

    assert.equal(JSON.stringify(lifted).includes("base64"), false, "no picture is left inline");
    assert.equal(lifted.pages[0].thumbnail.width, 1220, "everything else is untouched");
    assert.equal(lifted.pages[0].thumbnail.dataUrl, lifted.pages[1].thumbnail.dataUrl, "one reference for one picture");
    assert.equal(lifted.pages[0].layerTree.tree.dataUrl, lifted.pages[0].thumbnail.dataUrl,
      "and the same picture in the tree is the same reference again");
    assert.equal((await readdir(store.root)).length, 2, "two distinct pictures, two files");
  });
});

test("nothing live is swept away", async () => {
  await withStore(async (store) => {
    const kept = await store.put(png("still referenced"));
    await store.put(png("orphaned"));
    assert.equal((await readdir(store.root)).length, 2);

    // Assets outlive the scan that introduced them, because another project may
    // share them — so only what nothing points at is removed.
    const { removed } = await store.collect(referencesIn({ pages: [{ icon: kept }] }));
    assert.equal(removed, 1);
    assert.deepEqual(await readdir(store.root), [kept.replace("crank-asset://", "")]);
    assert.ok(await store.read(kept), "and the kept one still reads");
  });
});

test("a picture inlined in markup is the same picture as one in the layers", async () => {
  await withStore(async (store) => {
    const photo = png("a photograph");
    const scan = {
      pages: [{
        // The captured document carries the picture inside itself, twice, and
        // the layer tree carries the same bytes again.
        snapshot: { html: `<img src="${photo}"><div style="background:url(${photo})">x</div>` },
        layerTree: { tree: { kind: "image", dataUrl: photo } }
      }]
    };
    const lifted = await externalise(scan, store);

    assert.equal(JSON.stringify(lifted).includes("base64"), false, "nothing is left inline, markup included");
    assert.equal((await readdir(store.root)).length, 1, "one picture, one file, however it was written");
    assert.equal(lifted.pages[0].snapshot.html.match(/crank-asset:\/\/\w+\.png/g).length, 2);
    assert.ok(lifted.pages[0].snapshot.html.includes(lifted.pages[0].layerTree.tree.dataUrl),
      "the markup and the layers point at the same one");
    assert.match(lifted.pages[0].snapshot.html, /^<img src="crank-asset/, "and the markup is otherwise untouched");

    // An exported file runs where the store does not exist, so it goes back whole.
    const { internalise } = require("./asset-store.cjs");
    const restored = await internalise(lifted, store);
    assert.equal(restored.pages[0].snapshot.html, scan.pages[0].snapshot.html, "byte for byte, both of them");
  });
});

test("markup keeps whatever the store could not take", async () => {
  await withStore(async (store) => {
    const html = '<img src="data:image/png;base64,!!not base64!!"><p>kept</p>';
    const lifted = await externalise({ snapshot: { html } }, store);
    assert.equal(lifted.snapshot.html.includes("<p>kept</p>"), true);
  });
});

test("a picture is kept while only the markup still mentions it", async () => {
  await withStore(async (store) => {
    const lifted = await externalise({ pages: [{ snapshot: { html: `<img src="${png("only in markup")}">` } }] }, store);
    assert.deepEqual(await store.collect(referencesIn(lifted)), { removed: 0 });
    assert.equal((await readdir(store.root)).length, 1);
  });
});
