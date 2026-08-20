const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { describeAppBundle, launchAppBundle, looksLikeAppBundle, readAppIcon, runningInstance } = require("./app-bundle.cjs");

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
    kill(signal) { this.killed = true; if (signal) this.signal = signal; }
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
    running: async () => null,
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

test("closing the app waits for it to actually go", async () => {
  const child = fakeChild();
  const launched = await launchAppBundle({ name: "Ledger", executable: "/Apps/L.app/Contents/MacOS/Ledger" }, {
    port: 9333,
    launch: () => child,
    running: async () => null,
    targetsOn: () => Promise.resolve([{ id: "1", url: "client://app/", title: "Ledger" }]),
    // The app takes a moment to close; without waiting, a scan started straight
    // afterwards finds the dying copy and calls it "already running".
    wait: async () => { child.emit("exit", 0); }
  });
  await launched.stop();
  assert.equal(child.killed, true);
  assert.equal(child.signal, undefined, "a app that closes when asked is not forced");
});

test("an app that will not close is made to", async () => {
  const child = fakeChild();
  const launched = await launchAppBundle({ name: "Ledger", executable: "/Apps/L.app/Contents/MacOS/Ledger" }, {
    port: 9333,
    launch: () => child,
    running: async () => null,
    targetsOn: () => Promise.resolve([{ id: "1", url: "client://app/", title: "Ledger" }]),
    wait: async () => {}
  });
  await launched.stop();
  assert.equal(child.signal, "SIGKILL");
});

test("an app that is already running is checked for, not guessed at", async () => {
  // Inferring this from a quick exit was close enough to be misleading: an app
  // that failed for any other reason came back reported as already running.
  const launched = await launchAppBundle({ name: "Ledger", executable: "/Apps/L.app/Contents/MacOS/Ledger" }, {
    launch: () => { throw new Error("nothing should be started"); },
    running: async () => ({ pid: 501, port: null })
  });
  assert.equal(launched.ok, false);
  assert.match(launched.message, /already running/);
  assert.match(launched.message, /Quit Ledger/);
});

test("a copy already open with a debugging port is scanned where it stands", async () => {
  // Started that way by the person, or left over from an earlier scan: either
  // way it is the copy with their data in it, and a second one cannot be had.
  let killed = false;
  const launched = await launchAppBundle({ name: "Ledger", executable: "/Apps/L.app/Contents/MacOS/Ledger" }, {
    launch: () => { throw new Error("nothing should be started"); },
    running: async () => ({ pid: 501, port: 9222 }),
    targetsOn: (port) => Promise.resolve(port === 9222 ? [{ id: "7", url: "client://app/", title: "Ledger" }] : [])
  });
  assert.equal(launched.ok, true);
  assert.equal(launched.port, 9222);
  assert.equal(launched.adopted, true);
  await launched.stop();
  assert.equal(killed, false, "Crank did not open this copy, so it does not close it");
});

test("an app that closes on its own says so, without blaming a copy that is not there", async () => {
  const child = fakeChild();
  const launched = await launchAppBundle({ name: "Ledger", executable: "/Apps/L.app/Contents/MacOS/Ledger" }, {
    port: 9333,
    launch: () => { queueMicrotask(() => child.emit("exit", 0)); return child; },
    running: async () => null,
    targetsOn: () => Promise.resolve([]),
    wait: () => Promise.resolve()
  });
  assert.equal(launched.ok, false);
  assert.match(launched.message, /closed again as soon as it was opened/);
  assert.doesNotMatch(launched.message, /already running/);
});

test("reads a running copy and its debugging port out of the process list", async () => {
  const executable = "/Applications/ChatWise.app/Contents/MacOS/ChatWise";
  // Matched on the executable, not the command line: the helpers carry the
  // app's own path in their arguments, and an app opened with a document
  // carries the document in its own.
  const processes = async () => [
    "  76479 /Applications/ChatWise.app/Contents/Frameworks/ChatWise Helper.app/Contents/MacOS/ChatWise Helper",
    `  76478 ${executable}`,
    "  76480 /usr/sbin/notifyd"
  ];
  assert.deepEqual(
    await runningInstance(executable, { processes, argumentsOf: async () => `${executable} --remote-debugging-port=59167` }),
    { pid: 76478, port: 59167 }
  );
  assert.deepEqual(
    await runningInstance(executable, { processes, argumentsOf: async () => `${executable} /Users/me/notes.md` }),
    { pid: 76478, port: null },
    "running without a port is still running"
  );
  assert.equal(await runningInstance("/Applications/Nothing.app/Contents/MacOS/Nothing", { processes }), null);
});

test("an app that says nothing about what to start is refused before anything is opened", async () => {
  const launched = await launchAppBundle({ name: "Ledger", executable: null }, { launch: () => { throw new Error("nothing should be started"); } });
  assert.equal(launched.ok, false);
});

test("takes the icon the bundle names, and only falls back when it has to", async () => {
  // The icon is in the bundle: asking the system for it never returned here,
  // and nativeImage decodes no .icns — it answered 0×0 for a good icon.
  await withTemporaryDirectory(async (root) => {
    const bundle = await fakeBundle(root, "Ledger");
    const resources = path.join(bundle, "Contents", "Resources");
    await writeFile(path.join(resources, "icon.icns"), "");
    await writeFile(path.join(resources, "document.icns"), "");
    await writeFile(path.join(bundle, "Contents", "Info.plist"), [
      "<plist><dict>",
      "  <key>CFBundleExecutable</key><string>Ledger</string>",
      // Named without its extension, which is how plenty of bundles write it.
      "  <key>CFBundleIconFile</key><string>icon</string>",
      "</dict></plist>"
    ].join("\n"));

    const converted = [];
    const icon = await readAppIcon(bundle, {
      convert: async (icns, png) => { converted.push(icns); await writeFile(png, Buffer.from([1, 2, 3])); }
    });
    assert.deepEqual(converted, [path.join(resources, "icon.icns")]);
    assert.match(icon, /^data:image\/png;base64,/);
  });
});

test("a bundle that names no icon still has one found in it", async () => {
  await withTemporaryDirectory(async (root) => {
    const bundle = await fakeBundle(root, "Ledger");
    await writeFile(path.join(bundle, "Contents", "Resources", "whatever.icns"), "");
    const converted = [];
    await readAppIcon(bundle, {
      convert: async (icns, png) => { converted.push(path.basename(icns)); await writeFile(png, Buffer.from([1])); }
    });
    assert.deepEqual(converted, ["whatever.icns"]);
  });
});

test("and one with no icon at all says so rather than half an answer", async () => {
  await withTemporaryDirectory(async (root) => {
    const bundle = await fakeBundle(root, "Ledger");
    assert.equal(await readAppIcon(bundle, { convert: async () => { throw new Error("nothing to convert"); } }), null);
  });
});
