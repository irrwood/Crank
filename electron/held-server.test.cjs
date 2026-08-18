const test = require("node:test");
const assert = require("node:assert/strict");
const { holdServer } = require("./held-server.cjs");

/** Stands in for withProjectServer: hands the job an origin, stops after. */
const serving = (origin, log) => async (root, options, job) => {
  log.push(`started ${root}`);
  try {
    return await job(origin, { seedPaths: [] });
  } finally {
    log.push("stopped");
  }
};

test("the server stays up until whoever is reading lets go", async () => {
  const log = [];
  const held = holdServer("/repos/site", { run: serving("http://127.0.0.1:4400", log) });

  assert.equal(await held.ready, "http://127.0.0.1:4400");
  assert.deepEqual(log, ["started /repos/site"], "and is still up while the page is open");

  held.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["started /repos/site", "stopped"]);
});

test("a project that cannot be served says so instead of hanging", async () => {
  const failing = async () => ({ ok: false, message: "This folder is a workspace." });
  await assert.rejects(holdServer("/repos/mono", { run: failing }).ready, /workspace/);

  const thrown = async () => { throw new Error("the dev server never came up"); };
  await assert.rejects(holdServer("/repos/broken", { run: thrown }).ready, /never came up/);
});

test("releasing twice, or before it is up, is not an error", async () => {
  const log = [];
  const held = holdServer("/repos/site", { run: serving("http://x", log) });
  held.release();
  await held.ready;
  held.release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(log, ["started /repos/site", "stopped"]);
});
