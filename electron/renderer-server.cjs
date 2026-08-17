const path = require("node:path");
const { access, readFile } = require("node:fs/promises");
const { createRequire } = require("node:module");

/**
 * Serves an Electron app's interface as an ordinary web page.
 *
 * Running an Electron project's dev script launches the desktop app, and the
 * dev server dies with its window — closing it mid-scan takes the scan with
 * it. The renderer is just a Chromium page, so it is served directly instead:
 * no window opens, nothing can be closed by accident.
 *
 * This works only where the renderer already tolerates running outside
 * Electron. Projects commonly arrange that themselves with a browser bridge
 * that stubs the preload API when it is absent.
 */

// Most specific first. The root index.html is last because plenty of projects
// have one; for an Electron project it is the renderer, and missing it means
// running the dev script instead, which launches a second copy of the app.
const rendererEntries = [
  "src/renderer/index.html",
  "renderer/index.html",
  "src/index.html",
  "index.html"
];

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function detectElectronRenderer(root) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  if (!dependencies.electron && !dependencies["electron-vite"]) return null;
  for (const entry of rendererEntries) {
    if (await exists(path.join(root, entry))) return { root, entry, rendererRoot: path.dirname(path.join(root, entry)) };
  }
  return null;
}

/**
 * Starts Vite directly on the renderer directory using the project's own Vite
 * and React plugin, so its config and versions are the ones that apply.
 */
async function startRendererServer(root, { port = 0 } = {}) {
  const detected = await detectElectronRenderer(root);
  if (!detected) return { ok: false, reason: "not-electron", message: "This project has no Electron renderer to serve." };

  let projectRequire;
  try {
    projectRequire = createRequire(path.join(root, "package.json"));
  } catch {
    return { ok: false, reason: "no-manifest", message: "No package.json was found in this project." };
  }

  let createServer;
  let react;
  try {
    ({ createServer } = await import(projectRequire.resolve("vite")));
  } catch {
    return {
      ok: false,
      reason: "dependencies-missing",
      message: "Vite is not installed in this project. Install dependencies, then try again."
    };
  }
  try {
    react = (await import(projectRequire.resolve("@vitejs/plugin-react"))).default;
  } catch {
    react = null;
  }

  let server;
  try {
    server = await createServer({
      configFile: false,
      root: detected.rendererRoot,
      plugins: react ? [react()] : [],
      server: { port, host: "127.0.0.1" },
      clearScreen: false,
      logLevel: "warn"
    });
    await server.listen();
  } catch (cause) {
    return {
      ok: false,
      reason: "exited",
      message: `The renderer could not be served: ${cause instanceof Error ? cause.message : String(cause)}`
    };
  }

  const url = server.resolvedUrls?.local?.[0];
  if (!url) {
    await server.close().catch(() => {});
    return { ok: false, reason: "exited", message: "The renderer server started but reported no address." };
  }

  return {
    ok: true,
    url,
    origin: new URL(url).origin,
    attached: false,
    command: `vite (renderer only, from ${path.relative(root, detected.rendererRoot) || "."})`,
    stop: () => { server.close().catch(() => {}); }
  };
}

module.exports = { detectElectronRenderer, startRendererServer };
