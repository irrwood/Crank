/**
 * Running a built Mac app the way the Simulator runs an iOS one.
 *
 * `simctl` installs, launches, relaunches and screenshots a phone app. On this
 * Mac there is no such thing to ask: the product is a folder with a binary in
 * it, so it is started directly rather than through `open`. Starting the binary
 * is what makes the arguments, the environment and the process identity this
 * export's own — `open` hands all three to whatever copy is already running.
 */

const { spawn } = require("node:child_process");
const path = require("node:path");

/** The binary inside a `.app`, named by the bundle rather than assumed. */
async function macAppExecutable(appPath, { readBundleValue } = {}) {
  const read = readBundleValue || defaultBundleValue;
  const name = (await read(appPath, "CFBundleExecutable")).trim();
  if (!name) throw new Error(`${path.basename(appPath)} has no executable to launch`);
  return path.join(appPath, "Contents", "MacOS", name);
}

function defaultBundleValue(appPath, key) {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/plutil", ["-extract", key, "raw", "-o", "-", path.join(appPath, "Contents", "Info.plist")]);
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(output) : reject(new Error(`Could not read ${key} from ${appPath}`))));
  });
}

/**
 * Starts a Mac app and hands back the handle that stops it again.
 *
 * The app is left running on purpose: the capture happens while it is up, and
 * the caller stops it when the page it was launched for has been exported.
 */
async function launchMacApp({ appPath, args = [], env = {}, spawnProcess = spawn, readBundleValue } = {}) {
  const executable = await macAppExecutable(appPath, { readBundleValue });
  const child = spawnProcess(executable, args, {
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: false
  });
  let exited = false;
  const ended = new Promise((resolve) => {
    child.on("exit", () => { exited = true; resolve(); });
    child.on("error", () => { exited = true; resolve(); });
  });
  return {
    executable,
    pid: child.pid ?? null,
    get running() { return !exited; },
    async stop() {
      if (exited || child.pid == null) return;
      // Asked to quit first: a Mac app that is killed outright leaves its
      // window server state behind, and the next launch inherits it.
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      const settled = await Promise.race([ended, new Promise((resolve) => setTimeout(() => resolve("timeout"), 2_000))]);
      if (settled === "timeout") {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
        await ended;
      }
    }
  };
}

module.exports = { launchMacApp, macAppExecutable };
