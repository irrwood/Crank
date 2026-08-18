const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { beginDesignEditCheckpoint, commitDesignEditIteration, resolveDesignEditCheckpoint, runGit } = require("./design-edit-checkpoint.cjs");

async function createRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-design-edit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init", "-b", "main"]);
  await runGit(root, ["config", "user.email", "ui-sync@example.invalid"]);
  await runGit(root, ["config", "user.name", "UI Sync Test"]);
  await writeFile(path.join(root, "Screen.swift"), "before\n");
  await runGit(root, ["add", "Screen.swift"]);
  await runGit(root, ["commit", "-m", "Initial"]);
  return root;
}

test("creates an isolated checkpoint and fast-forwards an accepted edit", async (t) => {
  const root = await createRepository(t);
  const checkpoint = await beginDesignEditCheckpoint(root, new Date("2026-08-13T12:00:00.000Z"));
  assert.equal(checkpoint.branchName, "ui-sync/design-edit-20260813t120000z");
  await writeFile(path.join(root, "Screen.swift"), "after\n");
  const iteration = await commitDesignEditIteration(checkpoint, 1);
  assert.deepEqual(iteration.changedFiles, ["Screen.swift"]);
  await resolveDesignEditCheckpoint(checkpoint, "accept");
  assert.equal(await runGit(root, ["branch", "--show-current"]), "main");
  assert.equal(await readFile(path.join(root, "Screen.swift"), "utf8"), "after\n");
});

test("restores the starting commit when a human rejects the edit", async (t) => {
  const root = await createRepository(t);
  const checkpoint = await beginDesignEditCheckpoint(root, new Date("2026-08-13T12:01:00.000Z"));
  await writeFile(path.join(root, "Screen.swift"), "unwanted\n");
  await commitDesignEditIteration(checkpoint, 1);
  await resolveDesignEditCheckpoint(checkpoint, "reject");
  assert.equal(await runGit(root, ["branch", "--show-current"]), "main");
  assert.equal(await readFile(path.join(root, "Screen.swift"), "utf8"), "before\n");
});

test("refuses to start from a dirty project", async (t) => {
  const root = await createRepository(t);
  await writeFile(path.join(root, "Screen.swift"), "dirty\n");
  await assert.rejects(() => beginDesignEditCheckpoint(root), /Commit or stash/);
});
