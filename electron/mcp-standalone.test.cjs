const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, unlink, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createInventoryRegistry } = require("./inventory-registry.cjs");
const {
  createStandaloneMcpOperations,
  createWidgetHtmlLoader,
  defaultCrankUserDataDirectory
} = require("./mcp-standalone.cjs");

test("the plugin finds Crank data without asking Electron for a user-data path", () => {
  assert.equal(
    defaultCrankUserDataDirectory({ platform: "darwin", home: "/Users/example", env: {} }),
    "/Users/example/Library/Application Support/Crank"
  );
  assert.equal(
    defaultCrankUserDataDirectory({ platform: "linux", home: "/home/example", env: { XDG_CONFIG_HOME: "/config" } }),
    "/config/Crank"
  );
});

test("an active MCP task keeps its widget after a plugin cache is replaced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-widget-"));
  const widgetPath = path.join(directory, "flow-widget.html");
  await writeFile(widgetPath, "<html>Crank canvas</html>");

  const loadWidgetHtml = await createWidgetHtmlLoader(widgetPath);
  await unlink(widgetPath);

  assert.equal(await loadWidgetHtml(), "<html>Crank canvas</html>");
});

test("saved screens and assets open without a Crank application process", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-standalone-"));
  const registry = createInventoryRegistry(directory);
  const image = `data:image/png;base64,${Buffer.from("saved pixels").toString("base64")}`;
  const saved = await registry.saveInventory("folder", "/Example", {
    ok: true,
    source: { kind: "folder", target: "/Example" },
    pages: [{
      id: "home",
      name: "Home",
      route: "/",
      thumbnail: { dataUrl: image, width: 1440, height: 900 },
      layerTree: {
        width: 1440,
        height: 900,
        tree: {
          id: "root", kind: "element", x: 0, y: 0, width: 1440, height: 900,
          children: [{
            id: "hero", kind: "image", x: 40, y: 40, width: 320, height: 180,
            dataUrl: image, children: []
          }]
        }
      }
    }]
  });
  let runtimeCalls = 0;
  const operations = createStandaloneMcpOperations({
    dataDirectory: directory,
    registry,
    connectRuntime: async () => { runtimeCalls += 1; return null; }
  });

  assert.equal((await operations.listProjects()).length, 1);
  assert.equal((await operations.getInventory(saved.id)).pages[0].name, "Home");
  assert.equal(await operations.getPageImage(saved.id, "home"), image);
  const document = await operations.getPageDocument(saved.id, "home");
  assert.equal(document.kind, "layers");
  assert.equal(document.width, 1440);
  assert.equal(document.dataUrl, image);
  assert.equal(document.layerTree.tree.children[0].dataUrl, image);
  assert.equal(runtimeCalls, 0);
});

test("a damaged bundled runtime does not make saved-flow reads fail", async () => {
  const operations = createStandaloneMcpOperations({
    registry: {
      grouped: async () => [],
      loadInventory: async () => null,
      assets: { dataUrl: async () => null }
    },
    connectRuntime: async () => null
  });
  await assert.rejects(
    operations.scanProject("/Example", null, () => {}),
    /bundled capture runtime/
  );
  assert.deepEqual(await operations.listProjects(), []);
});

test("Figma and Paper actions use the bundled windowless runtime", async () => {
  const calls = [];
  const runtime = {
    copyForPaper: async (...args) => { calls.push(["copyForPaper", ...args]); return { ok: true, screens: ["Home"] }; },
    pushToPaper: async (...args) => { calls.push(["pushToPaper", ...args]); return { ok: true, created: ["Home"], updated: [] }; }
  };
  const operations = createStandaloneMcpOperations({
    registry: {
      grouped: async () => [],
      loadInventory: async () => null,
      assets: { dataUrl: async () => null }
    },
    connectRuntime: async () => runtime
  });

  assert.deepEqual(await operations.copyForPaper("0123456789abcdef", ["home"], "Example"), { ok: true, screens: ["Home"] });
  assert.deepEqual(await operations.pushToPaper("0123456789abcdef", ["home"]), { ok: true, created: ["Home"], updated: [] });
  assert.deepEqual(calls, [
    ["copyForPaper", "0123456789abcdef", ["home"], "Example"],
    ["pushToPaper", "0123456789abcdef", ["home"]]
  ]);
});
