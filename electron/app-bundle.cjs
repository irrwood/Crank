const { execFile, spawn } = require("node:child_process");
const net = require("node:net");
const path = require("node:path");
const { readFile, readdir, rm, stat } = require("node:fs/promises");
const os = require("node:os");
const { createHash } = require("node:crypto");
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

/**
 * The copy of this app that is already running, if there is one.
 *
 * An app that allows only one of itself hands its arguments to the copy already
 * running and exits — including the debugging port, which that copy was never
 * started with. Inferring that from a quick exit was close enough to be
 * misleading: an app that failed for any other reason was reported as already
 * running. Asking the process list is the actual evidence, and it also answers
 * the more useful question — whether the copy already running has a debugging
 * port of its own, because then there is nothing to start at all.
 */
async function runningInstance(executable, { processes = listProcesses, argumentsOf = readArguments } = {}) {
  const lines = await processes().catch(() => []);
  for (const line of lines) {
    const trimmed = line.trim();
    const at = trimmed.indexOf(" ");
    if (at < 0) continue;
    // Matched on the executable itself rather than on the command line, which
    // cannot be split reliably — every path in it may contain spaces, an app
    // opened with a document carries that document in it, and an app's helpers
    // carry the app's own path in their arguments.
    if (trimmed.slice(at + 1) !== executable) continue;
    const pid = Number(trimmed.slice(0, at));
    const port = String(await argumentsOf(pid).catch(() => "")).match(/--remote-debugging-port=(\d+)/)?.[1];
    return { pid, port: port ? Number(port) : null };
  }
  return null;
}

function listProcesses() {
  return run("ps", ["-axo", "pid=,comm="]).then((output) => output.split("\n"));
}

function readArguments(pid) {
  return run("ps", ["-p", String(pid), "-o", "command="]);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { maxBuffer: 8_000_000 }, (cause, stdout) => {
      if (cause) reject(cause);
      else resolve(String(stdout));
    });
  });
}

/**
 * The icon the app carries in its own bundle.
 *
 * A page declares a favicon and a scan takes it from there, but that is the
 * icon of a window; an installed app is known by the one on it in the Dock and
 * in Applications. It also exists before anything has been scanned, so the row
 * can wear it from the moment the app is dropped.
 *
 * Read from the file the bundle names, rather than asked of the system:
 * `app.getFileIcon` never returned at all here, and nativeImage decodes no
 * .icns — it answered 0×0 for a perfectly good icon. `sips` is macOS's own
 * converter and ships with it.
 */
async function readAppIcon(root, { convert = convertWithSips } = {}) {
  const contents = path.join(String(root ?? ""), "Contents");
  const declared = await readFile(path.join(contents, "Info.plist"), "utf8")
    .then((plist) => plist.match(/<key>\s*CFBundleIconFile\s*<\/key>\s*<string>([^<]+)<\/string>/)?.[1]?.trim() ?? null)
    .catch(() => null);

  const named = declared ? [declared.endsWith(".icns") ? declared : `${declared}.icns`] : [];
  // Some bundles name no icon, or name one that is not there; the Resources
  // folder holds exactly one .icns in almost every case.
  const found = (await readdir(path.join(contents, "Resources")).catch(() => []))
    .filter((entry) => entry.endsWith(".icns"));
  for (const candidate of [...named, ...found]) {
    const icns = path.join(contents, "Resources", candidate);
    if (!(await exists(icns))) continue;
    const png = path.join(os.tmpdir(), `crank-icon-${createHash("sha256").update(icns).digest("hex").slice(0, 16)}.png`);
    try {
      await convert(icns, png);
      const bytes = await readFile(png);
      await rm(png, { force: true });
      if (bytes.length > 0) return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      await rm(png, { force: true }).catch(() => {});
    }
  }
  return null;
}

/** 128px: crisp at the 28px the list draws it, and small enough to store. */
function convertWithSips(icns, png) {
  return new Promise((resolve, reject) => {
    execFile("sips", ["-s", "format", "png", "-Z", "128", icns, "--out", png], { timeout: 8000 }, (cause) => {
      if (cause) reject(cause);
      else resolve();
    });
  });
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
  wait = delay,
  running = runningInstance
} = {}) {
  if (!bundle?.executable) {
    return { ok: false, message: `${bundle?.name ?? "That app"} does not say which file to start; it cannot be opened this way.` };
  }

  const already = await running(bundle.executable).catch(() => null);
  if (already?.port) {
    // Already open with a debugging port — started that way by the person, or
    // left over from an earlier scan. Either way it is the copy with their data
    // in it, and starting a second one is both impossible and unwanted.
    const windows = (await targetsOn(already.port).catch(() => []))
      .filter((target) => target.url && target.url !== "about:blank");
    // Not stopped afterwards: Crank did not open this one.
    if (windows.length > 0) return { ok: true, port: already.port, windows, adopted: true, stop: async () => {} };
  }
  if (already) {
    return {
      ok: false,
      message: `${bundle.name} is already running, and a copy that is already running cannot be given a debugging port. Quit ${bundle.name}, then scan again.`
    };
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

  // Waited on, not merely asked for: an app takes a moment to close, and a
  // scan started straight after one that has just finished would otherwise find
  // the dying copy still in the process list and report it as already running.
  const stop = async () => {
    if (ended) return;
    try {
      child.kill();
    } catch {}
    for (let waited = 0; !ended && waited < 4_000; waited += 100) await wait(100);
    if (!ended) {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  };

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const targets = await targetsOn(chosen).catch(() => []);
    const windows = targets.filter((target) => target.url && target.url !== "about:blank");
    if (windows.length > 0) return { ok: true, port: chosen, windows, stop };
    // Nothing to attach to and nothing left running: say that it closed, and
    // what it said on the way out, rather than guessing at why.
    if (ended) {
      return {
        ok: false,
        message: `${bundle.name} closed again as soon as it was opened${ended.message ? `: ${ended.message}` : ""}. Nothing was left running to scan.`
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

module.exports = { describeAppBundle, launchAppBundle, looksLikeAppBundle, readAppIcon, runningInstance };
