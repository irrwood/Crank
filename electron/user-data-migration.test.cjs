const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, mkdir, writeFile, readFile, rm } = require("node:fs/promises");
const { carryUserData } = require("./user-data-migration.cjs");

const withDirs = async (run) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "crank-move-"));
  const before = path.join(base, "UI Sync");
  const after = path.join(base, "Crank");
  await mkdir(before, { recursive: true });
  await mkdir(after, { recursive: true });
  try { await run(before, after); } finally { await rm(base, { recursive: true, force: true }); }
};

test("a rename does not lose what the app remembers", async () => {
  await withDirs(async (before, after) => {
    await writeFile(path.join(before, "inventory-targets.json"), '[{"id":"a"}]');
    await mkdir(path.join(before, "inventories"));
    await writeFile(path.join(before, "inventories", "a.json"), '{"ok":true}');
    await mkdir(path.join(before, "baselines"));
    await writeFile(path.join(before, "baselines", "a.json"), '{"screens":{}}');

    const { carried } = await carryUserData(before, after);
    assert.ok(carried.includes("inventory-targets.json"));
    assert.ok(carried.includes("inventories"));
    assert.equal(await readFile(path.join(after, "inventories", "a.json"), "utf8"), '{"ok":true}');
    // Copied, not moved: an older build run afterwards still finds its own.
    assert.equal(await readFile(path.join(before, "inventory-targets.json"), "utf8"), '[{"id":"a"}]');
  });
});

test("newer work is never overwritten by older", async () => {
  await withDirs(async (before, after) => {
    await writeFile(path.join(before, "inventory-targets.json"), "old");
    await writeFile(path.join(after, "inventory-targets.json"), "new");
    const { carried } = await carryUserData(before, after);
    assert.deepEqual(carried, [], "what is already there is left alone");
    assert.equal(await readFile(path.join(after, "inventory-targets.json"), "utf8"), "new");
  });
});

test("nothing to carry is not a failure", async () => {
  await withDirs(async (_before, after) => {
    assert.deepEqual((await carryUserData(path.join(after, "nope"), after)).carried, []);
    assert.deepEqual((await carryUserData(after, after)).carried, [], "the same directory is a no-op");
  });
});
