const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { describeAppBundle, launchAppBundle, looksLikeAppBundle } = require("./app-bundle.cjs");

/** Builds the parts of a real bundle the reader actually looks at. */
async function fakeBundle(root, name, { executable = name, runtime = "electron", plist = true } = {}) {
  const bundle = path.join(root, `${name}.app`);
  const contents = path.join(bundle, "Contents");
  await mkdir(path.join(contents, "MacOS"), { recursive: true });
  await mkdir(path.join(contents, "Resources"), { recursive: true });
  await writeFile(path.join(contents, "MacOS", executable), "");
  if (plist) {
    await writeFile(path.join(contents, "Info.plist"), [
      '<?xml version="1.0" encoding="UTF-8"?>',
      "<plist><dict>",
      "  <key>CFBundleExecutable</key>",
      `  <string>${executable}</string>`,
      "</dict></plist>"
    ].join("\n"));
  }
  if (runtime === "electron") {
    await mkdir(path.join(contents, "Frameworks", "Electron Framework.framework"), { recursive: true });
  }
  return bundle;
}

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-bundle-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** A child process that behaves the way spawn's does, without starting anything. */
function fakeChild() {
  const handlers = new Map();
  return {
    killed: false,
    on(name, handler) { handlers.set(name, handler); },
    emit(name, value) { handlers.get(name)?.(value); },
    kill() { this.killed = true; }
  };
}

test("reads what an app is without starting it", async () => {
  await withTemporaryDirectory(async (root) => {
    const bundle = await fakeBundle(root, "Ledger");
    const read = await describeAppBundle(bundle);
    assert.equal(read.name, "Ledger");
    assert.equal(read.runtime, "electron");
    assert.equal(read.executable, path.join(bundle, "Contents", "MacOS", "Ledger"));
  });
});

test("takes the executable the bundle declares, not the name it happens to have", async () => {
  await withTemporaryDirectory(async (root) => {
    // Plenty of real apps ship an executable named nothing like the bundle.
    const bundle = await fakeBundle(root, "Ledger", { executable: "ledger-desktop" });
    assert.equal((await describeAppBundle(bundle)).executable, path.join(bundle, "Contents", "MacOS", "ledger-desktop"));
  });
});

test("falls back to what is in MacOS when the plist cannot be read", async () => {
  await withTemporaryDirectory(async (root) => {
    // A binary plist is not text, and every bundle worth scanning holds exactly
    // one executable anyway.
    const bundle = await fakeBundle(root, "Ledger", { executable: "Ledger Helper", plist: false });
    assert.equal((await describeAppBundle(bundle)).executable, path.join(bundle, "Contents", "MacOS", "Ledger Helper"));
  });
});

test("an app packed as an archive counts as one Crank can read", async () => {
  await withTemporaryDirectory(async (root) => {
    const bundle = await fakeBundle(root, "Slacklike", { runtime: "none" });
    // Slack ships app-arm64.asar rather than app.asar; the archive is the
    // evidence, not its name.
    await writeFile(path.join(bundle, "Contents", "Resources", "app-arm64.asar"), "");
    assert.equal((await describeAppBundle(bundle)).runtime, "electron");
  });
});

test("an app with no web runtime inside says so instead of looking scannable", async () => {
  await withTemporaryDirectory(async (root) => {
    const bundle = await fakeBundle(root, "Notes", { runtime: "none" });
    assert.equal((await describeAppBundle(bundle)).runtime, "unknown");
  });
});

test("a project folder is not an application", async () => {
  await withTemporaryDirectory(async (root) => {
    await mkdir(path.join(root, "project"));
    assert.equal(await describeAppBundle(path.join(root, "project")), null);
    // Named like a bundle, but nothing inside it: still not one.
    await mkdir(path.join(root, "Empty.app"));
    assert.equal(await describeAppBundle(path.join(root, "Empty.app")), null);
    assert.equal(looksLikeAppBundle("/Applications/Ledger.app/"), true);
    assert.equal(looksLikeAppBundle("/Users/me/project"), false);
  });
});

test("starts the app with a debugging port and waits for a window worth reading", async () => {
  const child = fakeChild();
  const seen = [];
  const answers = [[], [{ id: "1", url: "about:blank", title: "" }], [{ id: "2", url: "file:///Apps/L.app/index.html", title: "Ledger" }]];
  const launched = await launchAppBundle({ name: "Ledger", executable: "/Apps/L.app/Contents/MacOS/Ledger" }, {
    port: 9333,
    launch: (executable, args) => { seen.push([executable, ...args]); return child; },
    targetsOn: () => Promise.resolve(answers.shift() ?? []),
    wait: () => Promise.resolve()
  });
  assert.deepEqual(seen, [["/Apps/L.app/Contents/MacOS/Ledger", "--remote-debugging-port=9333"]]);
  assert.equal(launched.ok, true);
  assert.equal(launched.port, 9333);
  // A window with nothing in it yet is not the app; attaching there would scan
  // a blank rectangle.
  assert.deepEqual(launched.windows.map((window) => window.title), ["Ledger"]);
  await launched.stop();
  assert.equal(child.killed, true, "Crank opened this copy, so Crank closes it");
});

test("an app that is already running is named as the reason, not waited out", async () => {
  const child = fakeChild();
  const launched = await launchAppBundle({ name: "Ledger", executable: "/Apps/L.app/Contents/MacOS/Ledger" }, {
    port: 9333,
    launch: () => { queueMicrotask(() => child.emit("exit", 0)); return child; },
    targetsOn: () => Promise.resolve([]),
    wait: () => Promise.resolve()
  });
  assert.equal(launched.ok, false);
  assert.match(launched.message, /already running/);
  assert.match(launched.message, /Quit Ledger/);
});

test("a port that never opens ends the wait rather than hanging on it", async () => {
  const child = fakeChild();
  const launched = await launchAppBundle({ name: "Ledger", executable: "/Apps/L.app/Contents/MacOS/Ledger" }, {
    port: 9333,
    timeout: 0,
    launch: () => child,
    targetsOn: () => Promise.resolve([]),
    wait: () => Promise.resolve()
  });
  assert.equal(launched.ok, false);
  assert.match(launched.message, /never opened a window/);
  assert.equal(child.killed, true, "an app that will not be scanned is not left running");
});

test("an app that says nothing about what to start is refused before anything is opened", async () => {
  const launched = await launchAppBundle({ name: "Ledger", executable: null }, { launch: () => { throw new Error("nothing should be started"); } });
  assert.equal(launched.ok, false);
});
