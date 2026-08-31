const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, writeFile, access } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { STALE_AFTER_MS, claimWorkspace, processIsAlive } = require("./design-build-lock.cjs");

const workspace = () => mkdtemp(path.join(os.tmpdir(), "crank-build-lock-"));
const lockIn = (dir) => path.join(dir, ".crank-build.lock");
const exists = async (file) => access(file).then(() => true, () => false);

test("a claim is written down, and taken back on release", async () => {
  const dir = await workspace();
  const release = await claimWorkspace(dir, { label: "a scan" });
  const held = JSON.parse(await readFile(lockIn(dir), "utf8"));
  assert.equal(held.pid, process.pid);
  assert.equal(held.label, "a scan");

  await release();
  assert.equal(await exists(lockIn(dir)), false);
});

test("releasing twice is not an error", async () => {
  const dir = await workspace();
  const release = await claimWorkspace(dir);
  await release();
  await release();
});

test("a build already running is refused, in a sentence", async () => {
  const dir = await workspace();
  // Held by this process, which is certainly alive.
  await claimWorkspace(dir, { label: "the Crank window" });
  await assert.rejects(
    () => claimWorkspace(dir, { pid: process.pid + 1 }),
    /already being built by the Crank window/
  );
});

test("a lock left by a process that is gone does not wedge the project", async () => {
  const dir = await workspace();
  // A pid that cannot be running: the kernel refuses this one.
  await writeFile(lockIn(dir), JSON.stringify({ pid: 2147483646, startedAt: Date.now(), label: "a crashed scan" }));
  const release = await claimWorkspace(dir);
  assert.equal(JSON.parse(await readFile(lockIn(dir), "utf8")).pid, process.pid);
  await release();
});

test("a build that has been running for hours is treated as stuck", async () => {
  const dir = await workspace();
  // Alive — this very process — but started long enough ago to be hung.
  await writeFile(lockIn(dir), JSON.stringify({
    pid: process.pid,
    startedAt: Date.now() - STALE_AFTER_MS - 1000,
    label: "a scan"
  }));
  const release = await claimWorkspace(dir, { pid: process.pid + 1 });
  assert.equal(JSON.parse(await readFile(lockIn(dir), "utf8")).pid, process.pid + 1);
  await release();
});

test("a lock file nobody can parse is not a lock nobody can clear", async () => {
  const dir = await workspace();
  await writeFile(lockIn(dir), "{ this was truncated");
  const release = await claimWorkspace(dir);
  assert.equal(JSON.parse(await readFile(lockIn(dir), "utf8")).pid, process.pid);
  await release();
});

test("releasing does not remove a claim that was taken over", async () => {
  const dir = await workspace();
  // Ours, then someone else takes it as stale while we are still holding it.
  const release = await claimWorkspace(dir);
  await writeFile(lockIn(dir), JSON.stringify({ pid: process.pid + 1, startedAt: Date.now(), label: "a later scan" }));
  await release();
  assert.equal(await exists(lockIn(dir)), true);
  assert.equal(JSON.parse(await readFile(lockIn(dir), "utf8")).pid, process.pid + 1);
});

test("this process counts as alive and an impossible one does not", () => {
  assert.equal(processIsAlive(process.pid), true);
  assert.equal(processIsAlive(2147483646), false);
  assert.equal(processIsAlive(null), false);
  assert.equal(processIsAlive(-1), false);
});
