const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile, mkdir } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { detectElectronRenderer, startRendererServer } = require("./renderer-server.cjs");

async function project(manifest, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-renderer-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify(manifest));
  for (const [relative, contents] of Object.entries(files)) {
    await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
    await writeFile(path.join(root, relative), contents);
  }
  return root;
}

test("recognises an Electron project by its renderer entry", async () => {
  const electron = await project(
    { name: "app", devDependencies: { electron: "^43.0.0" } },
    { "src/renderer/index.html": "<!doctype html>" }
  );
  const web = await project({ name: "web", dependencies: { react: "^18.0.0" } }, { "index.html": "<!doctype html>" });
  const headless = await project({ name: "cli", devDependencies: { electron: "^43.0.0" } });
  try {
    const detected = await detectElectronRenderer(electron);
    assert.ok(detected);
    assert.equal(path.basename(detected.rendererRoot), "renderer");
    assert.equal(await detectElectronRenderer(web), null, "a plain web app is not served this way");
    assert.equal(await detectElectronRenderer(headless), null, "no renderer entry means nothing to serve");
  } finally {
    await Promise.all([electron, web, headless].map((root) => rm(root, { recursive: true, force: true })));
  }
});

test("reports missing dependencies instead of throwing", async () => {
  const root = await project(
    { name: "app", devDependencies: { electron: "^43.0.0" } },
    { "src/renderer/index.html": "<!doctype html>" }
  );
  try {
    const started = await startRendererServer(root);
    assert.equal(started.ok, false);
    assert.equal(started.reason, "dependencies-missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("declines a project with no Electron renderer", async () => {
  const root = await project({ name: "web", dependencies: { react: "^18.0.0" } });
  try {
    const started = await startRendererServer(root);
    assert.equal(started.ok, false);
    assert.equal(started.reason, "not-electron");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
