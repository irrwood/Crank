const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { chmod, mkdtemp, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  bundledRuntimeArchive,
  createBundledRuntimeConnector,
  extractRuntime
} = require("./mcp-runtime-client.cjs");

test("the bundled runtime path belongs to the plugin, not Applications", () => {
  assert.equal(
    bundledRuntimeArchive("/Plugin", "darwin", "arm64"),
    "/Plugin/runtime/darwin-arm64/Crank Runtime.zip"
  );
});

test("the macOS runtime archive is expanded with symlink-preserving ditto", async () => {
  const calls = [];
  const destination = path.join(os.tmpdir(), "crank-runtime-extraction-test");
  await extractRuntime("/Plugin/runtime/darwin-arm64/Crank Runtime.zip", destination, "darwin", async (...args) => {
    calls.push(args);
  });
  assert.deepEqual(calls, [[
    "ditto",
    ["-x", "-k", "/Plugin/runtime/darwin-arm64/Crank Runtime.zip", destination]
  ]]);
});

test("a missing bundled runtime is reported without looking for Crank.app", async () => {
  const connector = createBundledRuntimeConnector({
    executable: "/Plugin/runtime/darwin-arm64/missing",
    dataDirectory: "/Data"
  });
  await assert.rejects(connector.connect(), /bundled capture runtime is missing/);
});

test("the plugin starts its private runtime with isolated RPC coordinates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-runtime-test-"));
  const executable = path.join(directory, "runtime");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  const spawned = [];
  const child = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    child.exitCode = 0;
    child.emit("exit", 0, signal);
  };
  const expected = { scanProject() {} };
  const connector = createBundledRuntimeConnector({
    executable,
    dataDirectory: directory,
    start(command, args, options) {
      spawned.push({ command, args, options });
      return child;
    },
    connect: async () => expected
  });
  assert.equal(await connector.connect(), expected);
  assert.equal(spawned[0].command, executable);
  assert.deepEqual(spawned[0].args, ["--mcp-runtime"]);
  assert.equal(spawned[0].options.env.CRANK_USER_DATA_DIR, directory);
  assert.match(spawned[0].options.env.CRANK_MCP_RPC_TOKEN_PATH, /crank-codex-runtime-/);
  assert.match(spawned[0].options.env.CRANK_MCP_RPC_PORT, /^\d+$/);
  await connector.stop();
  assert.equal(child.killed, true);
});
