const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, mkdir, chmod } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { findInterpreter, parseComposeEnvironment, portOf } = require("./foreign-server.cjs");

test("finds the project's own interpreter and takes its directory as the workdir", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-foreign-run-"));
  const backend = path.join(root, "v3_backend");
  await mkdir(path.join(backend, ".venv", "bin"), { recursive: true });
  const python = path.join(backend, ".venv", "bin", "python");
  await writeFile(python, "#!/bin/sh\n");
  await chmod(python, 0o755);
  try {
    const found = await findInterpreter(root);
    assert.equal(found.python, python);
    // A venv sits at the root of the Python project, so it settles the cwd.
    assert.equal(found.workingDirectory, backend);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reports nothing when the project has no environment of its own", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-foreign-none-"));
  try {
    assert.equal(await findInterpreter(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reads the environment a compose file declares", () => {
  const compose = [
    "services:", "  app:", "    ports:", '      - "8787:8787"', "    environment:",
    "      # Set this for a populated demo", "      - CATFOLIO_DEMO=1",
    "      - TZ=UTC", "    restart: unless-stopped", "volumes:", "  data:"
  ].join("\n");
  assert.deepEqual(parseComposeEnvironment(compose), { CATFOLIO_DEMO: "1", TZ: "UTC" });
  assert.deepEqual(parseComposeEnvironment(null), {});
});

test("takes the port from the command before the declared default", () => {
  assert.equal(portOf("uvicorn app:app --port 9000", 8787), 9000);
  assert.equal(portOf("uvicorn app:app", 8787), 8787);
  assert.equal(portOf(null, null), null);
});
