const test = require("node:test");
const assert = require("node:assert/strict");
const { childIdsOf, nodeIdOf, payloadOf, pushToPaper } = require("./paper-mcp.cjs");

const tree = (name) => ({
  kind: "element", name, x: 0, y: 0, width: 390, height: 844,
  style: { backgroundColor: "rgb(255,255,255)" },
  children: [{ kind: "text", name: "T", x: 24, y: 40, width: 200, height: 28, text: name, style: { fontSize: 20 } }]
});

const inventory = {
  pages: [
    { id: "a", name: "Home", layerTree: { width: 390, height: 844, tree: tree("Home") } },
    { id: "b", name: "记录", layerTree: { width: 390, height: 844, tree: tree("记录") } }
  ]
};

/** A stand-in for Paper Desktop, recording what it was asked to do. */
function fakePaper({ artboards = [], children = {}, fail = {} } = {}) {
  const calls = [];
  let made = 0;
  return {
    calls,
    connect: async () => ({
      async call(name, args) {
        calls.push({ args, name });
        if (fail[name]) throw new Error(fail[name]);
        if (name === "get_basic_info") return { structuredContent: { artboards, fileName: "Product" } };
        if (name === "get_children") return { structuredContent: { children: children[args.nodeId] ?? [] } };
        if (name === "create_artboard") return { structuredContent: { id: `made-${++made}` } };
        return { structuredContent: { ok: true } };
      },
      async close() {}
    })
  };
}

test("makes an artboard per screen and draws the layers into it", async () => {
  const paper = fakePaper();
  const result = await pushToPaper(inventory, { connect: paper.connect });
  assert.equal(result.ok, true);
  assert.deepEqual(result.created, ["Home", "记录"]);
  assert.deepEqual(result.updated, []);
  const boards = paper.calls.filter((call) => call.name === "create_artboard");
  assert.deepEqual(boards.map((call) => call.args.name), ["Home", "记录"]);
  assert.equal(boards[0].args.styles.width, "390px");
  const writes = paper.calls.filter((call) => call.name === "write_html");
  assert.equal(writes.length, 2);
  assert.equal(writes[0].args.mode, "insert-children");
  assert.equal(writes[0].args.targetNodeId, "made-1");
  assert.match(writes[0].args.html, /position:absolute/);
});

test("places new artboards clear of what is already on the canvas", async () => {
  const paper = fakePaper({ artboards: [{ id: "theirs", name: "Moodboard", width: 1200, worldX: 0, worldY: -400 }] });
  await pushToPaper(inventory, { connect: paper.connect });
  // Paper ignores a position handed to create_artboard, so the board is moved
  // after it exists. Level with the top of the work already there.
  // One call for every board, not one each: Paper meters MCP by the call.
  const placed = paper.calls.filter((call) => call.name === "update_styles");
  assert.equal(placed.length, 1);
  assert.deepEqual(placed[0].args.updates.map((update) => update.styles), [
    { left: "1280px", top: "-400px" },
    { left: `${1280 + 390 + 80}px`, top: "-400px" }
  ]);
});

test("draws the screen even when it could not be placed", async () => {
  const paper = fakePaper({ fail: { update_styles: "no" } });
  const result = await pushToPaper(inventory, { connect: paper.connect });
  assert.deepEqual(result.created, ["Home", "记录"]);
});

test("refills an artboard of the same name instead of drawing a second one", async () => {
  const paper = fakePaper({
    artboards: [{ id: "old", name: "Home", width: 390, worldX: 0, worldY: 0 }],
    children: { old: [{ id: "c1" }, { id: "c2" }] }
  });
  const result = await pushToPaper(inventory, { connect: paper.connect });
  assert.deepEqual(result.updated, ["Home"]);
  assert.deepEqual(result.created, ["记录"]);
  const cleared = paper.calls.find((call) => call.name === "delete_nodes");
  assert.deepEqual(cleared.args.nodeIds, ["c1", "c2"]);
  // The artboard itself survives, so a screen the person moved stays put.
  assert.ok(!paper.calls.some((call) => call.name === "delete_nodes" && call.args.nodeIds.includes("old")));
  assert.ok(paper.calls.some((call) => call.name === "write_html" && call.args.targetNodeId === "old"));
});

test("takes the working mark off when it is done", async () => {
  const paper = fakePaper();
  await pushToPaper(inventory, { connect: paper.connect });
  assert.ok(paper.calls.some((call) => call.name === "finish_working_on_nodes"));
});

test("names a screen Paper refused and still pushes the rest", async () => {
  const paper = fakePaper();
  let first = true;
  const connect = async () => {
    const session = await paper.connect();
    return {
      ...session,
      async call(name, args) {
        if (name === "write_html" && first) { first = false; throw new Error("that artboard is locked"); }
        return session.call(name, args);
      }
    };
  };
  const result = await pushToPaper(inventory, { connect });
  assert.deepEqual(result.created, ["记录"]);
  assert.deepEqual(result.failed, [{ name: "Home", reason: "that artboard is locked" }]);
  assert.equal(result.ok, true);
});

test("says Paper is not open rather than failing with a socket error", async () => {
  const result = await pushToPaper(inventory, { connect: async () => { throw new Error("ECONNREFUSED"); } });
  assert.equal(result.ok, false);
  assert.match(result.message, /Open Paper Desktop/);
});

test("carries nothing when the scan has no layers, and says why", async () => {
  const result = await pushToPaper(
    { pages: [{ id: "x", name: "Blank", layerTree: null, layerError: "The page never settled" }] },
    { connect: async () => { throw new Error("should not have been asked"); } }
  );
  assert.equal(result.ok, false);
  assert.match(result.message, /never settled/);
});

test("reads an answer however Paper hands it over", () => {
  assert.deepEqual(payloadOf({ structuredContent: { a: 1 } }), { a: 1 });
  assert.deepEqual(payloadOf({ content: [{ type: "text", text: '{"a":2}' }] }), { a: 2 });
  assert.equal(nodeIdOf({ node: { id: "n-7" } }), "n-7");
  assert.equal(nodeIdOf({ nodeId: "n-8" }), "n-8");
  assert.deepEqual(childIdsOf([{ id: "c" }]), ["c"]);
  assert.deepEqual(childIdsOf({ nodes: [{ id: "d" }] }), ["d"]);
});
