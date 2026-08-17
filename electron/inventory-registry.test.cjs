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

test("packages under one folder read as one project", () => {
  const at = (target) => ({ id: targetId("folder", target), kind: "folder", target, name: nameFor("folder", target) });
  const grouped = groupTargets([
    at("/repos/momo/apps/desktop"),
    at("/repos/momo/apps/site"),
    at("/elsewhere/solo")
  ]);
  assert.equal(grouped.length, 2);
  const group = grouped.find((entry) => entry.kind === "group");
  assert.equal(group.name, "apps");
  assert.deepEqual(group.children.map((child) => child.name), ["desktop", "site"]);
  assert.ok(grouped.some((entry) => entry.name === "solo" && entry.kind === "folder"));
});

test("a lone folder is not dressed up as a group", () => {
  const grouped = groupTargets([
    { id: "1", kind: "folder", target: "/repos/only/app", name: "app" }
  ]);
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "folder");
});

test("names a url by its host and path", () => {
  assert.equal(nameFor("url", "http://localhost:8787"), "localhost:8787");
  assert.equal(nameFor("url", "http://localhost:5173/admin"), "localhost:5173/admin");
  assert.equal(nameFor("folder", "/Users/me/app/"), "app");
});
