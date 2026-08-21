const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { launchMacApp, macAppExecutable } = require("./macos-app-host.cjs");

async function appBundle({ executableName = "App" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-mac-app-"));
  const appPath = path.join(root, "App.app");
  await mkdir(path.join(appPath, "Contents", "MacOS"), { recursive: true });
  // A binary that stays up until it is asked to stop, which is what an app the
  // capture runs against does.
  await writeFile(
    path.join(appPath, "Contents", "MacOS", executableName),
    "#!/bin/sh\nwhile true; do sleep 0.2; done\n",
    { mode: 0o755 }
  );
  return appPath;
}

const bundleValue = (name) => async () => `${name}\n`;

test("launches the binary the bundle names, not the folder", async () => {
  const appPath = await appBundle({ executableName: "Focus Flow" });
  assert.equal(
    await macAppExecutable(appPath, { readBundleValue: bundleValue("Focus Flow") }),
    path.join(appPath, "Contents", "MacOS", "Focus Flow")
  );
});

test("says so rather than launching nothing when the bundle names no binary", async () => {
  const appPath = await appBundle();
  await assert.rejects(
    () => macAppExecutable(appPath, { readBundleValue: bundleValue("  ") }),
    /no executable/
  );
});

test("passes the page arguments and stops the app again", async () => {
  const appPath = await appBundle();
  const running = await launchMacApp({
    appPath,
    args: ["-uiSyncPageSourceName", "HomeView"],
    env: { UI_SYNC_PAGE_INDEX: "2" },
    readBundleValue: bundleValue("App")
  });
  assert.ok(running.pid, "the app should have a process of its own to stop");
  assert.equal(running.running, true);
  await running.stop();
  assert.equal(running.running, false);
});

test("hands the arguments and environment to the process it starts", async () => {
  const appPath = await appBundle();
  const seen = [];
  await launchMacApp({
    appPath,
    args: ["-designMode", "YES"],
    env: { UI_SYNC_PAGE_SOURCE_NAME: "SettingsView" },
    readBundleValue: bundleValue("App"),
    spawnProcess: (executable, args, options) => {
      seen.push({ executable, args, page: options.env.UI_SYNC_PAGE_SOURCE_NAME });
      return spawn("/bin/sh", ["-c", "exit 0"], { stdio: "ignore" });
    }
  });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].args, ["-designMode", "YES"]);
  assert.equal(seen[0].page, "SettingsView");
  assert.match(seen[0].executable, /App\.app\/Contents\/MacOS\/App$/);
});
