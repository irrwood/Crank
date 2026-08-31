const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createRepoCanvasStore } = require("./repo-canvas-store.cjs");

const inventoryId = "0123456789abcdef";
const graph = {
  version: 1,
  project: { name: "Example", inventoryId },
  screens: [{
    id: "home", name: "Home", route: "/", status: "observed",
    sourceRef: { file: "src/Home.tsx", line: 3, column: 5 }
  }],
  edges: [], groups: [], annotations: []
};

test("a repository owns its Crank flow, scene, changes, and bounded assets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-repo-canvas-"));
  const store = createRepoCanvasStore(root, { clock: () => "2026-08-29T12:00:00.000Z" });
  const opened = await store.open(inventoryId, graph);
  assert.equal(opened.flow.stateVersion, 0);
  assert.equal(opened.scene.selection, null);

  const intent = structuredClone(graph);
  intent.screens[0].name = "Landing";
  await store.writeFlow(inventoryId, graph, intent);
  await store.writeScene({
    inventoryId, view: "map", showPreviews: true,
    nodes: [{ id: "home", x: 120, y: 80 }],
    selection: {
      kind: "node", screenId: "home", nodeId: "button-183", sourceRef: graph.screens[0].sourceRef,
      pointer: { x: 28, y: 44, clientX: 120, clientY: 180 }
    }
  });
  await store.writeChanges(inventoryId, {
    version: "1.0", flow: "Example", summary: "Rename Home.",
    changes: [{ type: "update_screen", description: "Rename Home." }],
    annotations: [], affectedSources: [graph.screens[0].sourceRef]
  });
  const asset = await store.writeAsset("home", `data:image/png;base64,${Buffer.from("pixels").toString("base64")}`);

  assert.deepEqual(asset, { path: `assets/${asset.path.split("/").at(-1)}`, mimeType: "image/png" });
  assert.equal(await store.readAsset("home"), `data:image/png;base64,${Buffer.from("pixels").toString("base64")}`);
  assert.equal((await store.readFlow()).intentGraph.screens[0].name, "Landing");
  assert.equal((await store.readScene()).nodes[0].x, 120);
  assert.equal((await store.readScene()).selection.pointer.y, 44);
  assert.equal((await store.readChanges()).manifest.affectedSources[0].file, "src/Home.tsx");
  await readFile(path.join(root, ".crank", "flow.json"));
  await readFile(path.join(root, ".crank", "scene.json"));
  await readFile(path.join(root, ".crank", "changes.json"));
});

test("source context cannot escape the repository", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-source-context-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "Home.tsx"), ["one", "two", "const button = true;", "four"].join("\n"));
  const store = createRepoCanvasStore(root);
  const context = await store.readSourceContext({ file: "src/Home.tsx", line: 3, column: 1 }, 1);
  assert.equal(context.text, "2: two\n3: const button = true;\n4: four");
  await assert.rejects(
    store.readSourceContext({ file: "../outside.ts", line: 1, column: 1 }),
    /outside this repository/
  );
});

test("invalid repository-owned state is rejected instead of becoming canvas data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-invalid-scene-"));
  await mkdir(path.join(root, ".crank"));
  await writeFile(path.join(root, ".crank", "scene.json"), JSON.stringify({ version: 1, inventoryId, nodes: "not nodes" }));
  const store = createRepoCanvasStore(root);
  await assert.rejects(store.readScene(), /Invalid \.crank\/scene\.json/);
});
