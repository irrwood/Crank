const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtemp, rm, writeFile, mkdir } = require("node:fs/promises");
const { existsSync, readFileSync, statSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  buildRunArgs,
  ensureLauncherOnPath,
  chooseDevScript,
  detectPackageManager,
  extractConfiguredPort,
  parseServerUrl,
  parseServerUrls,
  probeUrl,
  resolveDevCommand,
  resolveLauncher,
  startDevServer
} = require("./dev-server.cjs");

async function makeProject(manifest, extraFiles = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-dev-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  for (const [relative, contents] of Object.entries(extraFiles)) {
    const target = path.join(root, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  return root;
}

test("prefers dev over other runnable scripts", () => {
  assert.equal(chooseDevScript({ start: "x", dev: "vite" }), "dev");
  assert.equal(chooseDevScript({ start: "x", serve: "y" }), "start");
  assert.equal(chooseDevScript({ build: "tsc" }), null);
  assert.equal(chooseDevScript({ dev: "   " }), null);
  assert.equal(chooseDevScript(null), null);
});

test("detects the package manager from the lockfile", async () => {
  const pnpm = await makeProject({ name: "a" }, { "pnpm-lock.yaml": "" });
  const yarn = await makeProject({ name: "b" }, { "yarn.lock": "" });
  const bare = await makeProject({ name: "c" });
  try {
    assert.equal(await detectPackageManager(pnpm), "pnpm");
    assert.equal(await detectPackageManager(yarn), "yarn");
    assert.equal(await detectPackageManager(bare), "npm");
  } finally {
    await Promise.all([pnpm, yarn, bare].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("reads only an explicitly pinned port", () => {
  assert.equal(extractConfiguredPort("vite --port 4000"), 4000);
  assert.equal(extractConfiguredPort("vite --port=4100"), 4100);
  assert.equal(extractConfiguredPort("next dev -p 3100"), 3100);
  assert.equal(extractConfiguredPort("PORT=8080 react-scripts start"), 8080);
  assert.equal(extractConfiguredPort("vite"), null);
  assert.equal(extractConfiguredPort("next dev --port 99999"), null);
});

test("parses the announced url from dev server output", () => {
  assert.equal(parseServerUrl("  ➜  Local:   http://localhost:5173/"), "http://localhost:5173/");
  assert.equal(parseServerUrl("- Local:        http://localhost:3000"), "http://localhost:3000/");
  assert.equal(parseServerUrl("listening on http://0.0.0.0:8080/app"), "http://127.0.0.1:8080/");
  assert.equal(parseServerUrl("compiled successfully"), null);
  assert.equal(parseServerUrl(null), null);
});

test("ignores the port-less url a package manager echoes from the script source", () => {
  const banner = "\n> dev\n> node -e \"h.listen(0,()=>console.log('http://localhost:'+h.address().port+'/'))\"\n";
  assert.deepEqual(parseServerUrls(banner), []);
  assert.deepEqual(
    parseServerUrls(`${banner}Local: http://localhost:5173/`),
    ["http://localhost:5173/"]
  );
});

test("parses the coloured url vite actually prints", () => {
  // Captured verbatim from `npm run dev` on a Vite 6 project: the port is bolded,
  // so escape codes sit between the colon and the digits.
  const viteOutput = "  \u001B[32m➜\u001B[39m  \u001B[1mLocal\u001B[22m:   "
    + "\u001B[36mhttp://localhost:\u001B[1m4319\u001B[22m/\u001B[39m\n"
    + "\u001B[2m  \u001B[32m➜\u001B[39m  \u001B[1mNetwork\u001B[22m\u001B[2m: use \u001B[22m\u001B[1m--host\u001B[22m\u001B[2m to expose\u001B[22m\n";
  assert.deepEqual(parseServerUrls(viteOutput), ["http://localhost:4319/"]);
});

test("ignores a url echoed inside the script source, port and all", () => {
  // UI Sync's own dev script mentions 127.0.0.1:5173, so previewing a project
  // whose script names a URL must not latch onto whoever owns that port.
  const banner = "\n> ui-sync-desktop@0.1.0 dev\n"
    + "> concurrently -k \"vite --host 127.0.0.1\" \"wait-on http://127.0.0.1:5173 && "
    + "UI_SYNC_DEV_SERVER_URL=http://127.0.0.1:5173 electron .\"\n\n";
  assert.deepEqual(parseServerUrls(banner), []);
  assert.deepEqual(
    parseServerUrls(`${banner}  ➜  Local:   http://localhost:5199/`),
    ["http://localhost:5199/"]
  );
});

test("falls back to corepack when a package manager is only a shell alias", () => {
  // pnpm/yarn are commonly aliases onto corepack, so spawning them directly is
  // ENOENT even though they work when typed into a terminal.
  const npm = resolveLauncher("npm");
  assert.equal(npm.command, "npm");
  assert.deepEqual(npm.args, []);

  const pnpm = resolveLauncher("pnpm");
  assert.ok(pnpm, "pnpm must resolve either directly or through corepack");
  assert.ok(
    pnpm.command === "pnpm" || (pnpm.command === "corepack" && pnpm.args[0] === "pnpm"),
    `unexpected launcher: ${JSON.stringify(pnpm)}`
  );
  assert.deepEqual(buildRunArgs(pnpm, "dev").slice(-2), ["run", "dev"]);
});

test("refuses to start without a dev script or dependencies", async () => {
  const noScript = await makeProject({ name: "a", scripts: { build: "tsc" } });
  const noDeps = await makeProject({ name: "b", scripts: { dev: "vite" } });
  try {
    assert.equal((await resolveDevCommand(noScript)).reason, "no-dev-script");
    assert.equal((await resolveDevCommand(noDeps)).reason, "dependencies-missing");
    assert.equal((await resolveDevCommand(path.join(noDeps, "missing"))).reason, "no-manifest");
  } finally {
    await Promise.all([noScript, noDeps].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("resolves a runnable command once dependencies exist", async () => {
  const root = await makeProject(
    { name: "app", scripts: { dev: "vite --port 4200" } },
    { "node_modules/.keep": "", "pnpm-lock.yaml": "" }
  );
  try {
    const resolved = await resolveDevCommand(root);
    assert.equal(resolved.ok, true);
    assert.equal(resolved.command, "pnpm run dev");
    assert.equal(resolved.configuredPort, 4200);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attaches to a server already listening on the pinned port", async () => {
  const server = http.createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const root = await makeProject(
    { name: "app", scripts: { dev: `vite --port ${port}` } },
    { "node_modules/.keep": "" }
  );
  try {
    assert.equal(await probeUrl(`http://127.0.0.1:${port}/`), true);
    const started = await startDevServer(root);
    assert.equal(started.ok, true);
    assert.equal(started.attached, true, "should reuse the running server instead of spawning");
    assert.equal(started.origin, `http://127.0.0.1:${port}`);
    assert.equal(started.stop, undefined, "an attached server must not be owned by UI Sync");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("reports a failing dev script instead of hanging", async () => {
  const root = await makeProject(
    { name: "app", scripts: { dev: "node -e \"process.exit(1)\"" } },
    { "node_modules/.keep": "" }
  );
  try {
    const started = await startDevServer(root, { startTimeoutMs: 20000 });
    assert.equal(started.ok, false);
    assert.equal(started.reason, "exited");
    assert.match(started.message, /exited before serving a page/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attaches when the dev script reports an already-running server and exits", async () => {
  // vinext refuses to start twice: it prints where the running server is, then
  // exits non-zero. The printed URL is the project's own tooling talking, so it
  // is trusted once a probe confirms it answers.
  const server = http.createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const root = await makeProject(
    {
      name: "app",
      scripts: {
        dev: `node -e "console.log('Another dev server is already running.');`
          + `console.log('  - Local: http://localhost:${port}');process.exit(1)"`
      }
    },
    { "node_modules/.keep": "" }
  );
  try {
    const started = await startDevServer(root, { startTimeoutMs: 20000 });
    assert.equal(started.ok, true, `expected attach, got ${started.reason}: ${started.message}`);
    assert.equal(started.attached, true);
    assert.equal(started.origin, `http://localhost:${port}`);
    assert.equal(started.stop, undefined, "a server UI Sync did not start must not be stoppable by it");
  } finally {
    await rm(root, { recursive: true, force: true });
    await new Promise((resolve) => server.close(resolve));
  }
});

test("starts a real server and reports its url", async () => {
  const root = await makeProject(
    {
      name: "app",
      scripts: {
        dev: "node -e \"const h=require('http').createServer((q,s)=>s.end('hi'));h.listen(0,'127.0.0.1',()=>console.log('Local: http://localhost:'+h.address().port+'/'))\""
      }
    },
    { "node_modules/.keep": "" }
  );
  let started;
  try {
    started = await startDevServer(root, { startTimeoutMs: 20000 });
    assert.equal(started.ok, true);
    assert.equal(started.attached, false);
    assert.match(started.url, /^http:\/\/localhost:\d+\/$/);
    assert.equal(await probeUrl(started.url), true);
  } finally {
    started?.stop?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("puts the package manager on PATH for the script's own child processes", () => {
  // A monorepo root script like "pnpm --parallel --filter … dev" calls pnpm
  // again under sh, where a shell alias does not exist.
  const before = { PATH: "/usr/bin" };
  const after = ensureLauncherOnPath("pnpm", before);
  if (after.PATH === before.PATH) return; // pnpm is a real binary here; nothing to shim
  const [directory] = after.PATH.split(path.delimiter);
  const shim = path.join(directory, "pnpm");
  assert.ok(existsSync(shim), "a forwarding executable must exist");
  assert.match(readFileSync(shim, "utf8"), /exec corepack pnpm/);
  assert.ok(statSync(shim).mode & 0o111, "the shim must be executable");
  assert.match(after.PATH, /\/usr\/bin$/, "the original PATH must still be there");
});

test("leaves PATH alone when the package manager is a real binary", () => {
  const before = { PATH: "/usr/bin" };
  assert.equal(ensureLauncherOnPath("npm", before).PATH, "/usr/bin");
});

test("a project with nothing installed is told which command to run, and where", async () => {
  // The usual state of a repository someone just cloned. "Install them in this
  // project" was true and useless: it named neither the package manager nor the
  // folder, and the package manager is something the project itself declares.
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-deps-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "vite" } }));
    await writeFile(path.join(root, "pnpm-lock.yaml"), "");

    const outcome = await resolveDevCommand(root);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.reason, "dependencies-missing");
    assert.equal(outcome.install.command, "pnpm install", "the lockfile chooses the package manager");
    assert.equal(outcome.install.source, "pnpm-lock.yaml", "and is cited, so the suggestion is not a guess");
    assert.equal(outcome.install.root, root);
    assert.match(outcome.message, /pnpm install/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("with no lockfile it still answers, and says what it went on", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-deps-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "x", scripts: { dev: "vite" } }));
    const outcome = await resolveDevCommand(root);
    assert.equal(outcome.install.command, "npm install");
    assert.equal(outcome.install.source, "package.json");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
