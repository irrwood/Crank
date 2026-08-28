const test = require("node:test");
const assert = require("node:assert/strict");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createCrankMcpServer, createJobStore, summarizeInventory } = require("./mcp-server.cjs");

function operations(overrides = {}) {
  return {
    listProjects: async () => [{ id: "0123456789abcdef", kind: "folder", name: "Example", target: "/Example" }],
    getInventory: async () => null,
    getPage: async () => null,
    getPageImage: async () => null,
    scanProject: async () => ({ ok: false, reason: "test" }),
    scanUrl: async () => ({ ok: false, reason: "test" }),
    scanAttached: async () => ({ ok: false, reason: "test" }),
    sendToFigma: async () => ({ ok: false, message: "test" }),
    getFigmaStatus: async () => ({ state: "waiting" }),
    ...overrides
  };
}

async function connectedServer(fakeOperations) {
  const server = createCrankMcpServer(fakeOperations);
  const client = new Client({ name: "crank-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { client, server };
}

test("exposes read tools separately from actions an agent should confirm", async () => {
  const { client, server } = await connectedServer(operations());
  try {
    const tools = await client.listTools();
    const byName = new Map(tools.tools.map((tool) => [tool.name, tool]));
    assert.equal(byName.get("list_projects").annotations.readOnlyHint, true);
    assert.equal(byName.get("get_page_image").annotations.readOnlyHint, true);
    assert.equal(byName.get("scan_project").annotations.readOnlyHint, false);
    assert.equal(byName.get("scan_project").annotations.destructiveHint, false);
    assert.equal(byName.get("send_to_figma").annotations.openWorldHint, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("returns remembered projects without making an agent parse prose", async () => {
  const { client, server } = await connectedServer(operations());
  try {
    const result = await client.callTool({ name: "list_projects", arguments: {} });
    assert.deepEqual(result.structuredContent, {
      projects: [{ id: "0123456789abcdef", kind: "folder", name: "Example", target: "/Example" }]
    });
  } finally {
    await client.close();
    await server.close();
  }
});

test("a long scan returns a job before the scan finishes", async () => {
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { client, server } = await connectedServer(operations({
    scanProject: async (_root, _workspace, progress) => {
      progress({ phase: "scanning", name: "Home" });
      await pending;
      return { ok: true, pages: [], source: { kind: "folder", target: "/Example" } };
    }
  }));
  try {
    const started = await client.callTool({ name: "scan_project", arguments: { path: "/Example" } });
    assert.equal(started.structuredContent.state, "running");
    const jobId = started.structuredContent.id;
    await nextTurn();
    const running = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    assert.deepEqual(running.structuredContent.progress, { phase: "scanning", name: "Home" });

    finish();
    await nextTurn();
    const completed = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    assert.equal(completed.structuredContent.state, "complete");
    assert.equal(completed.structuredContent.result.pageCount, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("summaries keep page identity but leave large captures out of model context", () => {
  const summary = summarizeInventory({
    ok: true,
    pages: [{
      id: "page-home", name: "Home", route: "/", depth: 0, recipe: [], variants: [],
      thumbnail: { dataUrl: "data:image/png;base64,AAAA", width: 100, height: 100 },
      layerTree: { width: 100, height: 100, tree: { kind: "element", children: [] } },
      snapshot: { html: "a very large document" }
    }]
  });
  assert.equal(summary.pages[0].hasImage, true);
  assert.equal(summary.pages[0].hasEditableLayers, true);
  assert.equal("snapshot" in summary.pages[0], false);
  assert.equal("layerTree" in summary.pages[0], false);
});

test("job failures are retained as readable errors", async () => {
  const jobs = createJobStore({ createId: () => "00000000-0000-4000-8000-000000000000" });
  jobs.start("scan", async () => { throw new Error("the project did not start"); });
  await nextTurn();
  assert.deepEqual(jobs.get("00000000-0000-4000-8000-000000000000"), {
    id: "00000000-0000-4000-8000-000000000000",
    kind: "scan",
    state: "error",
    createdAt: jobs.get("00000000-0000-4000-8000-000000000000").createdAt,
    updatedAt: jobs.get("00000000-0000-4000-8000-000000000000").updatedAt,
    progress: null,
    result: null,
    error: "the project did not start"
  });
});
