const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");

/** Loads the preload against a stub bridge and returns what it exposed. */
function load() {
  const invoked = [];
  let exposed = null;
  const electron = {
    contextBridge: { exposeInMainWorld: (_name, api) => { exposed = api; } },
    ipcRenderer: { invoke: async (channel, ...args) => { invoked.push(channel); return { channel, args }; } }
  };
  const source = readFileSync(path.join(__dirname, "self-scan-preload.cjs"), "utf8");
  vm.runInNewContext(source, {
    require: (name) => (name === "electron" ? electron : require(name)),
    module: { exports: {} }, console, Error, Promise, Set
  });
  return { api: exposed, invoked };
}

test("the copy being scanned can read the real inventory", async () => {
  const { api, invoked } = load();
  await api.listInventoryTargets();
  await api.listProjects();
  await api.openInventory("abc");
  assert.equal(invoked.join(","), "inventory:targets,projects:list,inventory:open");
});

test("nothing it can click changes anything", async () => {
  const { api, invoked } = load();
  // A crawl clicks everything it finds. With the real bridge these are real:
  // Rescan starts scans inside a scan, Remove forgets a project.
  await api.scanFolder("/repos/anything");
  await api.scanUrl("http://localhost:3000");
  await api.sendInventoryToFigma({}, "https://figma.com/design/x");
  await api.dropPage({}, "page-1");
  await api.recapturePage({}, {});
  await api.explorePage({}, {}, []);
  assert.equal(invoked.length, 0, `these reached the main process: ${invoked.join(", ")}`);
});

test("a refused action answers in the shape the interface expects", async () => {
  const { api } = load();
  const scan = await api.scanFolder("/x");
  assert.equal(scan.ok, false);
  assert.match(scan.message, /scanning itself/);
  const recording = await api.stopRecording();
  assert.equal(recording.ok, true);
  assert.equal(recording.pages.length, 0);
  assert.equal(await api.chooseFolder(), null);
  assert.equal(typeof api.onScanStatus(() => {}), "function", "unsubscribing must not throw");
});

test("every method the interface calls exists", () => {
  const { api } = load();
  const used = [
    "listProjects", "listInventoryTargets", "openInventory", "scanUrl", "scanFolder", "scanAttached",
    "startRecording", "stopRecording", "recapturePage", "explorePage", "dropPage", "sendInventoryToFigma",
    "getFigmaExportStatus", "chooseFolder", "forgetInventoryTarget", "exportHandoffPage", "revealFile",
    "onScanStatus", "onScanLifecycle", "onScanProgress", "onRecorded", "copyText", "openFigma",
    "showFigmaPlugin", "getDroppedPath", "listDebugWindows"
  ];
  for (const name of used) assert.equal(typeof api[name], "function", `${name} is missing`);
});
