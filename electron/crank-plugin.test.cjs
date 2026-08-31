const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const { mkdir, mkdtemp, readFile, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { createInventoryRegistry } = require("./inventory-registry.cjs");
const { FLOW_WIDGET_URI } = require("./mcp-server.cjs");
const { availablePort, bundledRuntimeArchive } = require("./mcp-runtime-client.cjs");

const sourcePlugin = process.env.CRANK_PLUGIN_TEST_ROOT
  ? path.resolve(process.env.CRANK_PLUGIN_TEST_ROOT)
  : path.join(__dirname, "..", "plugins", "crank");

test("the packaged plugin opens a saved flow with plain Node and survives a damaged capture dependency", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-plugin-"));
  const registry = createInventoryRegistry(directory);
  const image = `data:image/png;base64,${Buffer.from("plugin pixels").toString("base64")}`;
  const saved = await registry.saveInventory("folder", "/Examples/Shop", {
    ok: true,
    source: { kind: "folder", target: "/Examples/Shop" },
    pages: [{
      id: "home", name: "Home", route: "/", recipe: [], variants: [], snapshot: { links: [] },
      thumbnail: { dataUrl: image, width: 1200, height: 800 }
    }]
  });
  // A local install is copied into Codex's cache, so accepting an explicit
  // package root lets release verification exercise those copied bytes rather
  // than accidentally proving only that the source checkout works.
  const plugin = sourcePlugin;
  const entry = path.join(plugin, "scripts", "start-crank-mcp.cjs");
  await readFile(entry);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: plugin,
    env: {
      CRANK_USER_DATA_DIR: directory,
      CRANK_CAPTURE_RUNTIME_EXECUTABLE: path.join(directory, "missing-runtime")
    },
    stderr: "pipe"
  });
  const client = new Client({ name: "crank-packaged-plugin-test", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "open_flow_canvas"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "render_flow_canvas"), true);
    assert.equal(tools.tools.some((tool) => tool.name === "open_crank_review"), true);
    const projects = await client.callTool({ name: "list_projects", arguments: {} });
    assert.equal(projects.structuredContent.projects[0].id, saved.id);

    const canvas = await client.callTool({ name: "render_flow_canvas", arguments: { inventory_id: saved.id } });
    assert.equal(canvas.structuredContent.observedGraph.screens[0].name, "Home");
    const resource = await client.readResource({ uri: FLOW_WIDGET_URI });
    assert.match(resource.contents[0].text, /Crank for Codex/);
    assert.equal(resource.contents[0].text.includes('className:"inspector"'), false);
    assert.equal(resource.contents[0].text.includes(".inspector{"), false);

    const scan = await client.callTool({ name: "scan_project", arguments: { path: "/Examples/Shop" } });
    let job;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      job = await client.callTool({ name: "get_job", arguments: { job_id: scan.structuredContent.id } });
      if (job.structuredContent.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(job.structuredContent.state, "error");
    assert.match(job.structuredContent.error, /bundled capture runtime is missing/);

    const stillConnected = await client.callTool({ name: "get_inventory", arguments: { inventory_id: saved.id } });
    assert.equal(stillConnected.structuredContent.pageCount, 1);
  } finally {
    await client.close();
  }
});

test("the packaged plugin scans with its bundled runtime and never exposes a desktop-window action", {
  skip: !existsSync(bundledRuntimeArchive(sourcePlugin))
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crank-plugin-runtime-"));
  const project = path.join(directory, "Example");
  const port = await availablePort();
  await mkdir(path.join(project, "node_modules"), { recursive: true });
  await writeFile(path.join(project, "package.json"), JSON.stringify({
    name: "crank-runtime-fixture",
    private: true,
    scripts: { dev: `PORT=${port} node server.cjs` }
  }));
  await writeFile(path.join(project, "server.cjs"), `
    const http = require("node:http");
    const port = Number(process.env.PORT);
    http.createServer((request, response) => {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(request.url === "/next"
        ? "<!doctype html><title>Next</title><main><h1>Next screen</h1></main>"
        : "<!doctype html><title>Home</title><main><h1>Home screen</h1><a href='/next'>Next</a></main>");
    }).listen(port, "127.0.0.1", () => console.log("http://127.0.0.1:" + port + "/"));
  `);
  const entry = path.join(sourcePlugin, "scripts", "start-crank-mcp.cjs");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: sourcePlugin,
    env: { CRANK_USER_DATA_DIR: directory },
    stderr: "pipe"
  });
  const client = new Client({ name: "crank-bundled-runtime-test", version: "1" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "open_flow_canvas"), false);
    const started = await client.callTool({ name: "scan_project", arguments: { path: project } });
    let job;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      job = await client.callTool({ name: "get_job", arguments: { job_id: started.structuredContent.id } });
      if (job.structuredContent.state !== "running") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(job.structuredContent.state, "complete", job.structuredContent.error ?? "scan did not complete");
    assert.equal(job.structuredContent.result.ok, true);
    assert.ok(job.structuredContent.result.pageCount >= 1);
    const canvas = await client.callTool({
      name: "render_flow_canvas",
      arguments: { inventory_id: job.structuredContent.result.id }
    });
    assert.ok(canvas.structuredContent.observedGraph.screens.length >= 1);
  } finally {
    await client.close();
  }
});
