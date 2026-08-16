const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { mkdtemp, rm, writeFile, mkdir } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  chooseDevScript,
  detectPackageManager,
  extractConfiguredPort,
  parseServerUrl,
  parseServerUrls,
  probeUrl,
  resolveDevCommand,
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
