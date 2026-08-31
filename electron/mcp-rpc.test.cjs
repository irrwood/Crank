const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createMcpRpcClient, createMcpRpcServer } = require("./mcp-rpc.cjs");

function fakeOperations() {
  return {
    listProjects: async () => [{ id: "one", name: "Example" }],
    getInventory: async (id) => ({ ok: true, id }),
    getPage: async (_id, pageId) => ({ id: pageId }),
    getPageImage: async () => null,
    getPageDocument: async (_id, pageId) => ({ kind: "layers", pageId }),
    openFlow: async () => ({ opened: true, mode: "focused" }),
    scanProject: async (root) => ({ ok: true, root }),
    scanUrl: async (url) => ({ ok: true, url }),
    scanAttached: async (port) => ({ ok: true, port }),
    sendToFigma: async () => ({ ok: true, pairingCode: "123456" }),
    getFigmaStatus: async () => ({ state: "waiting" }),
    copyForPaper: async (_id, pageIds) => ({ ok: true, screens: pageIds ?? ["all"] }),
    pushToPaper: async (_id, pageIds) => ({ ok: true, created: pageIds ?? ["all"] })
  };
}

test("an MCP process delegates to the Crank instance that owns the bridges", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-mcp-rpc-"));
  const tokenPath = path.join(directory, "token");
  const server = createMcpRpcServer({ operations: fakeOperations(), tokenPath, port: 0 });
  try {
    await server.start();
    const client = await createMcpRpcClient({ tokenPath, port: server.port });
    assert.ok(client);
    assert.deepEqual(await client.listProjects(), [{ id: "one", name: "Example" }]);
    assert.deepEqual(await client.scanProject("/Example", null), { ok: true, root: "/Example" });
    assert.deepEqual(await client.openFlow(), { opened: true, mode: "focused" });
    assert.deepEqual(await client.getPageDocument("one", "home"), { kind: "layers", pageId: "home" });
    assert.deepEqual(await client.copyForPaper("one", ["home"], "Example"), { ok: true, screens: ["home"] });
    assert.deepEqual(await client.pushToPaper("one", ["home"]), { ok: true, created: ["home"] });
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("the loopback relay refuses a caller without its per-machine token", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-mcp-rpc-"));
  const tokenPath = path.join(directory, "token");
  const server = createMcpRpcServer({ operations: fakeOperations(), tokenPath, port: 0 });
  try {
    await server.start();
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(response.status, 401);
    assert.match((await readFile(tokenPath, "utf8")).trim(), /^[a-f0-9]{64}$/);
  } finally {
    await server.stop();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a missing relay is not mistaken for an empty Crank instance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-mcp-rpc-"));
  try {
    assert.equal(await createMcpRpcClient({ tokenPath: path.join(directory, "missing"), port: 1 }), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
