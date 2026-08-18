const { spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { readFile, readdir, stat } = require("node:fs/promises");
const { listTargets } = require("./cdp-session.cjs");

/**
 * Scans an app that is installed rather than one that can be built.
 *
 * Everything else here needs the project: a folder to serve, or an address the
 * developer already has running. A designer handed a build has neither — they
 * have the app, in the Applications folder, and the pages they want are the
 * ones they can see by opening it.
 *
 * Attaching already works (see cdp-session), and it is the same crawl either
 * way; the only thing missing was the launch. Chromium takes a debugging port
 * from the command line, and an installed Electron app is a Chromium: starting
 * its executable with that switch produces exactly the app the person would
 * have opened themselves, with their data behind it, and a port to drive it by.
 *
 * That is also the reason not to hide it or give it a scratch profile. A second
 * copy with an empty profile would be signed out, and an app scanned signed out
 * is a tour of its login screen.
 */

/** How long an app is given to open a window before the launch is called failed. */
const LAUNCH_TIMEOUT = 40_000;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function looksLikeAppBundle(target) {
  return path.extname(String(target ?? "").replace(/\/+$/, "")).toLowerCase() === ".app";
}

async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The executable to start, as the bundle itself declares it.
 *
 * `CFBundleExecutable` is the app's own answer, and reading it beats assuming
 * the executable is named after the bundle — plenty are not. A binary plist
 * (or a missing key) falls back to what is actually in MacOS, which holds one
 * file in every bundle worth scanning.
 */
async function readExecutableName(contents) {
  const declared = await readFile(path.join(contents, "Info.plist"), "utf8")
    .then((plist) => plist.match(/<key>\s*CFBundleExecutable\s*<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim() ?? null)
    .catch(() => null);
  if (declared) return declared;
  const entries = await readdir(path.join(contents, "MacOS")).catch(() => []);
  const usable = entries.filter((entry) => !entry.startsWith("."));
  return usable.length === 1 ? usable[0] : null;
}

/**
 * Whether the interface inside is one a browser can read.
 *
 * The framework is the direct evidence, and the packed application archive is
 * Electron's own format, so either one settles it. An app built on anything
 * else — AppKit, or a system web view — exposes no debugging protocol, and
 * saying so is more use than launching it and waiting for a port that will
 * never open.
 */
async function detectRuntime(contents) {
  if (await exists(path.join(contents, "Frameworks", "Electron Framework.framework"))) return "electron";
  const resources = await readdir(path.join(contents, "Resources")).catch(() => []);
  if (resources.some((entry) => entry.endsWith(".asar"))) return "electron";
  if (await exists(path.join(contents, "Resources", "app", "package.json"))) return "electron";
  return "unknown";
}

/**
 * Reads what an application bundle is, without starting it.
 *
 * Returns null when the path is not a bundle at all, so a plain folder still
 * takes the project route it always did.
 */
async function describeAppBundle(target) {
  const root = String(target ?? "").replace(/\/+$/, "");
  if (!looksLikeAppBundle(root)) return null;
  const contents = path.join(root, "Contents");
  if (!(await exists(contents))) return null;

  const executableName = await readExecutableName(contents);
  return {
    root,
    name: path.basename(root, ".app"),
    runtime: await detectRuntime(contents),
    executable: executableName ? path.join(contents, "MacOS", executableName) : null
  };
}

/** A port the app can have to itself, rather than one that may already be busy. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/**
 * Starts an installed app with a debugging port and waits for its first window.
 *
 * `about:blank` is not that window: an Electron app commonly creates its window
 * before it has anything to show, and attaching there scans a blank rectangle.
 */
async function launchAppBundle(bundle, {
  port,
  timeout = LAUNCH_TIMEOUT,
  launch = spawn,
  targetsOn = listTargets,
  wait = delay
} = {}) {
  if (!bundle?.executable) {
    return { ok: false, message: `${bundle?.name ?? "That app"} does not say which file to start; it cannot be opened this way.` };
  }
  const chosen = port ?? await freePort();

  let child;
  try {
    child = launch(bundle.executable, [`--remote-debugging-port=${chosen}`], { stdio: "ignore" });
  } catch (cause) {
    return { ok: false, message: `${bundle.name} could not be started: ${cause.message}` };
  }

  let ended = null;
  child.on?.("exit", (code) => { ended = { code }; });
  child.on?.("error", (cause) => { ended = { code: null, message: cause.message }; });

  const stop = async () => {
    if (ended) return;
    try {
      child.kill();
    } catch {}
  };

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const targets = await targetsOn(chosen).catch(() => []);
    const windows = targets.filter((target) => target.url && target.url !== "about:blank");
    if (windows.length > 0) return { ok: true, port: chosen, windows, stop };
    // An app that only allows one copy of itself hands its arguments to the
    // copy already running and exits — including the debugging port, which that
    // copy was not started with and will not open. Quitting it is the only way
    // through, and saying that beats waiting out the full timeout.
    if (ended) {
      return {
        ok: false,
        message: `${bundle.name} closed again as soon as it was started, which is what happens when a copy of it is already running. Quit ${bundle.name}, then scan again.`
      };
    }
    await wait(250);
  }

  await stop();
  return {
    ok: false,
    message: `${bundle.name} started but never opened a window Crank could read within ${Math.round(timeout / 1000)} seconds.`
  };
}

module.exports = { describeAppBundle, launchAppBundle, looksLikeAppBundle };
