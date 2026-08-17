const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, mkdir } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInventoryRegistry, groupTargets, nameFor, targetId } = require("./inventory-registry.cjs");

const withRegistry = async (run) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ui-sync-reg-"));
  try {
    await run(createInventoryRegistry(directory), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test("remembers a target so it need not be dragged in again", async () => {
  await withRegistry(async (registry) => {
    await registry.remember("folder", "/Users/me/app");
    const [entry] = await registry.list();
    assert.equal(entry.name, "app");
    assert.equal(entry.kind, "folder");
    assert.equal(entry.pageCount, null, "not scanned yet");

    await registry.remember("folder", "/Users/me/app", { pageCount: 13, scannedAt: "2026-08-17T00:00:00.000Z" });
    const [updated] = await registry.list();
    assert.equal((await registry.list()).length, 1, "the same folder must not be added twice");
    assert.equal(updated.pageCount, 13);
    assert.equal(updated.lastScannedAt, "2026-08-17T00:00:00.000Z");
  });
});

test("keeps the scan so reopening does not mean rescanning", async () => {
  await withRegistry(async (registry) => {
    const inventory = { ok: true, origin: "http://x", pages: [{ id: "a" }, { id: "b" }] };
    const id = await registry.saveInventory("folder", "/Users/me/app", inventory);
    assert.deepEqual(await registry.loadInventory(id), inventory);
    const [entry] = await registry.list();
    assert.equal(entry.pageCount, 2, "the saved page count shows without loading the whole inventory");
    assert.ok(entry.lastScannedAt);
  });
});

test("forgetting a target drops its stored scan too", async () => {
  await withRegistry(async (registry) => {
    const id = await registry.saveInventory("url", "http://localhost:8787", { pages: [{ id: "a" }] });
    await registry.forget(id);
    assert.deepEqual(await registry.list(), []);
    assert.equal(await registry.loadInventory(id), null, "the cache must not outlive the entry");
  });
});

test("a damaged list does not throw", async () => {
  await withRegistry(async (registry, directory) => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "inventory-targets.json"), "{ not json");
    assert.deepEqual(await registry.list(), []);
  });
});

test("packages picked out of a workspace nest under it", async () => {
  await withRegistry(async (registry) => {
    await registry.remember("folder", "/repos/momo");
    await registry.remember("folder", "/repos/momo/apps/desktop", { parent: "/repos/momo" });
    await registry.remember("folder", "/repos/momo/apps/site", { parent: "/repos/momo" });
    await registry.remember("folder", "/elsewhere/solo");

    const grouped = await registry.grouped();
    assert.equal(grouped.length, 2, "one workspace and one loose project");
    const group = grouped.find((entry) => entry.kind === "group");
    assert.equal(group.name, "momo");
    assert.deepEqual(group.children.map((child) => child.name), ["desktop", "site"]);
    assert.equal(group.root.name, "momo", "the workspace's own scan sits inside its group");
    assert.ok(!grouped.some((entry) => entry.kind === "folder" && entry.name === "momo"),
      "and is not repeated outside it");
    assert.ok(grouped.some((entry) => entry.name === "solo" && entry.kind === "folder"));
  });
});

test("sharing a folder on disk is not a relationship", async () => {
  await withRegistry(async (registry) => {
    // Everything under ~/Documents would otherwise become one "Documents"
    // project, which says only where the files were saved.
    await registry.remember("folder", "/Users/me/Documents/BubbleFan");
    await registry.remember("folder", "/Users/me/Documents/cv");
    await registry.remember("folder", "/Users/me/Documents/w3p-meme");

    const grouped = await registry.grouped();
    assert.equal(grouped.length, 3, "three unrelated projects stay three rows");
    assert.ok(grouped.every((entry) => entry.kind === "folder"));
  });
});

test("a workspace with one package still nests it", async () => {
  await withRegistry(async (registry) => {
    await registry.remember("folder", "/repos/one/packages/ui", { parent: "/repos/one" });
    const grouped = await registry.grouped();
    assert.equal(grouped[0].kind, "group");
    assert.equal(grouped[0].root, null, "the workspace itself was never scanned");
    assert.deepEqual(grouped[0].children.map((child) => child.name), ["ui"]);
  });
});

test("names a url by its host and path", () => {
  assert.equal(nameFor("url", "http://localhost:8787"), "localhost:8787");
  assert.equal(nameFor("url", "http://localhost:5173/admin"), "localhost:5173/admin");
  assert.equal(nameFor("folder", "/Users/me/app/"), "app");
});

test("keeps what was sent to Figma, so a pull has something to compare against", async () => {
  await withRegistry(async (registry) => {
    const baselines = {
      "state-a": [{ id: "root", selector: ".app", kind: "element", width: 1200, height: 800 }]
    };
    const id = await registry.saveFigmaBaseline("folder", "/repos/app", baselines, { fileKey: "abc123" });
    const stored = await registry.loadFigmaBaseline(id);
    assert.deepEqual(stored.screens, baselines);
    assert.equal(stored.fileKey, "abc123");
    assert.ok(stored.pushedAt, "when it was sent decides which side moved since");

    await registry.forget(id);
    assert.equal(await registry.loadFigmaBaseline(id), null, "a forgotten project keeps no baseline");
  });
});

test("replaces the sent baseline with what Figma says it holds, and names the frames", async () => {
  await withRegistry(async (registry) => {
    const id = await registry.saveFigmaBaseline("url", "http://localhost:5173", {
      home: [{ id: "root", kind: "text", fontSize: 17.4 }],
      about: [{ id: "root", kind: "element", width: 900 }]
    }, { fileKey: "abc123" });

    await registry.recordFigmaPush(id, {
      frames: { home: { nodeId: "12:3", frameName: "Home" } },
      screens: { home: [{ id: "root", kind: "text", fontSize: 17 }] }
    });

    const stored = await registry.loadFigmaBaseline(id);
    assert.equal(stored.screens.home[0].fontSize, 17, "Figma rounded it, and Figma is what a pull compares against");
    assert.equal(stored.screens.about[0].width, 900, "a page the push did not report keeps the baseline it was sent with");
    assert.deepEqual(stored.frames.home, { nodeId: "12:3", frameName: "Home" });
    assert.equal(stored.fileKey, "abc123", "the file it landed in survives the update");
  });
});

test("a dropped page stays dropped, and is forgotten with its project", async () => {
  await withRegistry(async (registry) => {
    const id = await registry.saveInventory("url", "http://localhost:5173", { ok: true, pages: [] });
    assert.deepEqual(await registry.dropped(id), [], "nothing is dropped to begin with");

    await registry.drop(id, "page-404");
    await registry.drop(id, "page-debug");
    await registry.drop(id, "page-404");
    assert.deepEqual(await registry.dropped(id), ["page-404", "page-debug"], "dropping twice is not two entries");

    await registry.forget(id);
    assert.deepEqual(await registry.dropped(id), [], "a forgotten project keeps no list");
  });
});
