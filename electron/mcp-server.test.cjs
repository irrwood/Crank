const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = require("@modelcontextprotocol/sdk/inMemory.js");
const { createCrankMcpServer, createJobStore, FLOW_WIDGET_URI, summarizeInventory } = require("./mcp-server.cjs");

function operations(overrides = {}) {
  return {
    listProjects: async () => [{ id: "0123456789abcdef", kind: "folder", name: "Example", target: "/Example" }],
    getInventory: async () => null,
    getPage: async () => null,
    getPageImage: async () => null,
    getPageDocument: async () => null,
    openFlow: async () => ({ opened: true }),
    scanProject: async () => ({ ok: false, reason: "test" }),
    scanUrl: async () => ({ ok: false, reason: "test" }),
    scanAttached: async () => ({ ok: false, reason: "test" }),
    sendToFigma: async () => ({ ok: false, message: "test" }),
    getFigmaStatus: async () => ({ state: "waiting" }),
    copyForPaper: async () => ({ ok: false, message: "test" }),
    pushToPaper: async () => ({ ok: false, message: "test" }),
    ...overrides
  };
}

async function connectedServer(fakeOperations, options = {}) {
  const server = createCrankMcpServer(fakeOperations, { loadWidgetHtml: async () => "<html>Crank widget</html>", ...options });
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
    assert.deepEqual(byName.get("get_page_image")._meta.ui.visibility, ["model", "app"]);
    assert.equal(byName.get("get_page_image")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("get_page_document").annotations.readOnlyHint, true);
    assert.deepEqual(byName.get("get_page_document")._meta.ui.visibility, ["app"]);
    assert.equal(byName.get("get_page_document")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("open_flow_canvas").annotations.readOnlyHint, true);
    assert.equal(byName.get("render_flow_canvas").annotations.readOnlyHint, true);
    assert.equal(byName.get("render_flow_canvas")._meta.ui.resourceUri, FLOW_WIDGET_URI);
    assert.equal(byName.get("open_crank_canvas").annotations.readOnlyHint, true);
    assert.deepEqual(byName.get("open_crank_canvas")._meta.ui.visibility, ["model", "app"]);
    assert.equal(byName.get("open_crank_canvas")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("open_crank_review").annotations.readOnlyHint, true);
    assert.deepEqual(byName.get("open_crank_review")._meta.ui.visibility, ["model", "app"]);
    assert.equal(byName.get("open_crank_review")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("get_selection").annotations.readOnlyHint, true);
    assert.equal(byName.get("get_source_context").annotations.readOnlyHint, true);
    assert.deepEqual(byName.get("apply_change")._meta.ui.visibility, ["model", "app"]);
    assert.equal(byName.get("sync_from_code").annotations.readOnlyHint, false);
    assert.deepEqual(byName.get("sync_from_code")._meta.ui.visibility, ["model", "app"]);
    assert.equal(byName.get("sync_from_code")._meta["openai/widgetAccessible"], true);
    assert.deepEqual(byName.get("prepare_flow_changes")._meta.ui.visibility, ["app"]);
    assert.equal(byName.get("prepare_flow_changes")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("scan_project").annotations.readOnlyHint, false);
    assert.equal(byName.get("scan_project").annotations.destructiveHint, false);
    assert.equal(byName.get("send_to_figma").annotations.openWorldHint, true);
    assert.equal(byName.get("send_to_figma")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("get_job")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("get_figma_sync_status")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("copy_for_paper")._meta["openai/widgetAccessible"], true);
    assert.equal(byName.get("push_to_paper")._meta["openai/widgetAccessible"], true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a widget can hydrate a captured page without an Electron asset URL", async () => {
  const preview = `data:image/png;base64,${Buffer.from("captured pixels").toString("base64")}`;
  const { client, server } = await connectedServer(operations({ getPageImage: async () => preview }));
  try {
    const result = await client.callTool({
      name: "get_page_image",
      arguments: { inventory_id: "0123456789abcdef", page_id: "home" }
    });
    const image = result.content.find((block) => block.type === "image");
    assert.deepEqual(image, {
      type: "image",
      data: Buffer.from("captured pixels").toString("base64"),
      mimeType: "image/png"
    });
    assert.equal(JSON.stringify(result).includes("crank-asset://"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a widget receives a scalable page only in tool metadata", async () => {
  const document = {
    kind: "layers",
    width: 1440,
    height: 900,
    layerTree: {
      width: 1440,
      height: 900,
      tree: { id: "root", kind: "element", x: 0, y: 0, width: 1440, height: 900, children: [] }
    },
    dataUrl: "data:image/png;base64,ZmFrZQ=="
  };
  const { client, server } = await connectedServer(operations({ getPageDocument: async () => document }));
  try {
    const result = await client.callTool({
      name: "get_page_document",
      arguments: { inventory_id: "0123456789abcdef", page_id: "home" }
    });
    assert.deepEqual(result.structuredContent, {
      inventoryId: "0123456789abcdef", pageId: "home", kind: "layers", width: 1440, height: 900
    });
    assert.deepEqual(result._meta["crank/pageDocument"], document);
    assert.equal(JSON.stringify(result.structuredContent).includes("tree"), false);
    assert.equal(JSON.stringify(result.structuredContent).includes("ZmFrZQ"), false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the widget can export the saved inventory to Figma and Paper without scanning", async () => {
  const calls = [];
  const { client, server } = await connectedServer(operations({
    sendToFigma: async (...args) => {
      calls.push(["figma", ...args.slice(0, 3)]);
      return { ok: true, pairingCode: "123456", screenCount: 1, requiresPairing: true };
    },
    getFigmaStatus: async (code) => ({ state: "waiting", pairingCode: code }),
    copyForPaper: async (...args) => {
      calls.push(["copy", ...args]);
      return { ok: true, screens: ["Home"] };
    },
    pushToPaper: async (...args) => {
      calls.push(["paper", ...args]);
      return { ok: true, created: ["Home"], updated: [] };
    }
  }));
  try {
    const started = await client.callTool({
      name: "send_to_figma",
      arguments: {
        inventory_id: "0123456789abcdef",
        figma_url: "https://www.figma.com/design/abc/Example",
        page_ids: ["home"]
      }
    });
    let job = started.structuredContent;
    for (let attempt = 0; job.state === "running" && attempt < 10; attempt += 1) {
      await nextTurn();
      job = (await client.callTool({ name: "get_job", arguments: { job_id: job.id } })).structuredContent;
    }
    assert.equal(job.state, "complete");
    assert.equal(job.result.pairingCode, "123456");

    const copied = await client.callTool({
      name: "copy_for_paper",
      arguments: { inventory_id: "0123456789abcdef", page_ids: ["home"], title: "Example" }
    });
    const pushed = await client.callTool({
      name: "push_to_paper",
      arguments: { inventory_id: "0123456789abcdef", page_ids: ["home"] }
    });
    assert.deepEqual(copied.structuredContent, { ok: true, screens: ["Home"] });
    assert.deepEqual(pushed.structuredContent, { ok: true, created: ["Home"], updated: [] });
    assert.deepEqual(calls, [
      ["figma", "0123456789abcdef", "https://www.figma.com/design/abc/Example", ["home"]],
      ["copy", "0123456789abcdef", ["home"], "Example"],
      ["paper", "0123456789abcdef", ["home"]]
    ]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("serves the Codex canvas as an MCP App resource", async () => {
  const { client, server } = await connectedServer(operations(), {
    loadWidgetHtml: () => readFile(path.join(__dirname, "..", "codex", "dist", "flow-widget.html"), "utf8")
  });
  try {
    const resource = await client.readResource({ uri: FLOW_WIDGET_URI });
    assert.equal(FLOW_WIDGET_URI, "ui://crank/native-canvas-v26.html");
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.match(resource.contents[0].text, /Crank for Codex/);
    assert.match(resource.contents[0].text, /get_page_image/);
    assert.match(resource.contents[0].text, /get_page_document/);
    assert.match(resource.contents[0].text, /ui\/update-model-context/);
    assert.match(resource.contents[0].text, /crankAnnotations/);
    assert.match(resource.contents[0].text, /open_crank_review/);
    assert.match(resource.contents[0].text, /ui\/open-link/);
    assert.match(resource.contents[0].text, /Annotate in Codex/);
    assert.match(resource.contents[0].text, /使用 Codex 标注/);
    assert.equal(resource.contents[0].text.includes("setWidgetState"), false);
    assert.equal(resource.contents[0].text.includes("crankSelection"), false);
    assert.match(resource.contents[0].text, /copy_for_paper/);
    assert.match(resource.contents[0].text, /push_to_paper/);
    assert.match(resource.contents[0].text, /send_to_figma/);
    assert.match(resource.contents[0].text, /screen-card__preview/);
    assert.match(resource.contents[0].text, /Vector/);
    assert.match(resource.contents[0].text, /矢量/);
    assert.match(resource.contents[0].text, /ui\/request-display-mode/);
    assert.match(resource.contents[0].text, /ui\/notifications\/host-context-changed/);
    assert.match(resource.contents[0].text, /openai:set_globals/);
    assert.equal(resource.contents[0].text.includes("No Crank visual annotations are staged"), false);
    assert.equal(resource.contents[0].text.includes("Product note"), false);
    assert.equal(resource.contents[0].text.includes("What should change on this screen?"), false);
    assert.equal(resource.contents[0].text.includes("产品备注"), false);
    assert.equal(resource.contents[0].text.includes("这个页面需要怎样修改？"), false);
    assert.equal(resource.contents[0].text.includes(".toolbar .primary"), false);
    assert.equal(resource.contents[0].text.includes("changes sent to Codex"), false);
    assert.equal(resource.contents[0].text.includes("已将 {count} 项改动交给 Codex"), false);
    assert.equal(resource.contents[0].text.includes("apply_change"), false);
    assert.equal(resource.contents[0].text.includes("ui/message"), false);
    assert.equal(resource.contents[0].text.includes('className:"inspector"'), false);
    assert.equal(resource.contents[0].text.includes(".inspector{"), false);
    assert.equal(resource.contents[0].text.includes("crank-asset:\/\/"), false);
    assert.deepEqual(resource.contents[0]._meta.ui.csp, { connectDomains: [], resourceDomains: ["https://crank.tofukanban.uk"] });
    assert.deepEqual(resource.contents[0]._meta["openai/widgetCSP"].resource_domains, ["https://crank.tofukanban.uk"]);
    assert.deepEqual(resource.contents[0]._meta["openai/widgetCSP"].redirect_domains, ["http://127.0.0.1"]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("still answers the canvas URI an older conversation was rendered with", async () => {
  const { client, server } = await connectedServer(operations(), {
    loadWidgetHtml: async () => "<!doctype html><title>Crank for Codex</title>"
  });
  try {
    // Codex stores the resource URI beside every widget it has already drawn,
    // so a version bump must not turn reopening that thread into a failed read.
    const retired = await client.readResource({ uri: "ui://crank/native-canvas-v17.html" });
    assert.equal(retired.contents[0].uri, "ui://crank/native-canvas-v17.html");
    assert.match(retired.contents[0].text, /Crank for Codex/);
    assert.equal(retired.contents[0].mimeType, "text/html;profile=mcp-app");

    // Only the current canvas is advertised: the retired URIs answer reads
    // without turning the resource list into a version history.
    const listed = await client.listResources();
    assert.deepEqual(listed.resources.map((entry) => entry.uri), [FLOW_WIDGET_URI]);
  } finally {
    await client.close();
    await server.close();
  }
});

test("renders a stored inventory without opening the desktop app", async () => {
  const inventory = {
    ok: true,
    source: { kind: "folder", target: "/Examples/Shop" },
    pages: [{ id: "home", name: "Home", route: "/", recipe: [], snapshot: { links: [] }, variants: [] }]
  };
  const { client, server } = await connectedServer(operations({
    getInventory: async () => inventory,
    listProjects: async () => [{
      id: "0123456789abcdef", kind: "folder", name: "Shop", target: "/Examples/Shop",
      figmaUrl: "https://www.figma.com/design/abc/Shop"
    }]
  }));
  try {
    const result = await client.callTool({ name: "render_flow_canvas", arguments: { inventory_id: "0123456789abcdef" } });
    assert.equal(result.structuredContent.observedGraph.project.name, "Shop");
    assert.equal(result.structuredContent.observedGraph.screens[0].name, "Home");
    assert.equal(result.structuredContent.exportSettings.figmaUrl, "https://www.figma.com/design/abc/Shop");
  } finally {
    await client.close();
    await server.close();
  }
});

test("prepares the selected screen as a local Browser review and persists DOM hits", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-browser-review-"));
  const inventory = {
    ok: true,
    source: { kind: "folder", target: root },
    pages: [{
      id: "home", name: "Home", route: "/", recipe: [], variants: [],
      layerTree: {
        width: 320, height: 180,
        tree: {
          id: "root", kind: "element", name: "HomeView", source: "Home.tsx:1:1",
          x: 0, y: 0, width: 320, height: 180, style: {}, children: []
        }
      },
      snapshot: { links: [] }
    }]
  };
  const document = {
    kind: "layers", width: 320, height: 180,
    layerTree: inventory.pages[0].layerTree
  };
  const { client, server } = await connectedServer(operations({
    getInventory: async () => inventory,
    getPageDocument: async () => document
  }));
  try {
    const result = await client.callTool({
      name: "open_crank_review",
      arguments: { inventory_id: "0123456789abcdef", screen_id: "home", locale: "en" }
    });
    assert.equal(result.structuredContent.screenId, "home");
    assert.equal(result.structuredContent.hasEditableLayers, true);
    assert.match(result.structuredContent.url, /^http:\/\/127\.0\.0\.1:\d+\/review\/[a-f0-9]{48}$/);
    const page = await fetch(result.structuredContent.url);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /data-crank-id="root"/);

    const hit = await fetch(`${result.structuredContent.url}/selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        screenId: "home", nodeId: "root", name: "HomeView", source: "Home.tsx:1:1",
        pointer: { x: 20, y: 30, clientX: 80, clientY: 100 }
      })
    });
    assert.equal(hit.status, 204);
    const selected = await client.callTool({ name: "get_selection", arguments: { inventory_id: "0123456789abcdef" } });
    assert.deepEqual(selected.structuredContent.selection.pointer, { x: 20, y: 30, clientX: 80, clientY: 100 });
    assert.deepEqual(selected.structuredContent.selection.sourceRef, {
      file: "Home.tsx", line: 1, column: 1, component: "HomeView"
    });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("prepares a semantic change request but does not edit the project", async () => {
  const inventory = {
    ok: true,
    source: { kind: "folder", target: "/Examples/Shop" },
    pages: [{ id: "home", name: "Home", route: "/", recipe: [], snapshot: { links: [] }, variants: [] }]
  };
  const intent = {
    version: 1,
    project: { name: "Shop", root: "/Examples/Shop", inventoryId: "0123456789abcdef" },
    screens: [
      { id: "home", name: "Landing", route: "/", annotation: "Add a primary checkout action", status: "modified" },
      { id: "checkout", name: "Checkout", route: "/checkout", status: "proposed" }
    ],
    edges: [{
      id: "proposed:home:checkout", fromScreenId: "home", toScreenId: "checkout", status: "proposed",
      trigger: { type: "click", label: "Checkout" }
    }],
    groups: [], annotations: []
  };
  const { client, server } = await connectedServer(operations({ getInventory: async () => inventory }));
  try {
    const result = await client.callTool({
      name: "prepare_flow_changes",
      arguments: { inventory_id: "0123456789abcdef", intent_graph: intent }
    });
    assert.deepEqual(result.structuredContent.manifest.changes.map((change) => change.type), ["add_transition", "add_screen", "update_screen"]);
    assert.match(result.structuredContent.prompt, /Add a Landing → Checkout transition/);
    assert.match(result.structuredContent.prompt, /CRANK_CHANGE_MANIFEST_JSON/);
  } finally {
    await client.close();
    await server.close();
  }
});

test("opens the editable flow through the same desktop operation", async () => {
  let opened = 0;
  const { client, server } = await connectedServer(operations({
    openFlow: async () => {
      opened += 1;
      return { opened: true, mode: "focused" };
    }
  }));
  try {
    const result = await client.callTool({ name: "open_flow_canvas", arguments: {} });
    assert.deepEqual(result.structuredContent, { opened: true, mode: "focused" });
    assert.equal(opened, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("a standalone server cannot accidentally open the desktop window", async () => {
  const { client, server } = await connectedServer(operations(), { includeDesktopWindowTool: false });
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools.some((tool) => tool.name === "open_flow_canvas"), false);
    assert.equal(tools.tools.some((tool) => tool.name === "render_flow_canvas"), true);
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
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-scan-job-"));
  let finish;
  const pending = new Promise((resolve) => { finish = resolve; });
  const { client, server } = await connectedServer(operations({
    scanProject: async (_root, _workspace, progress) => {
      progress({ phase: "scanning", name: "Home" });
      await pending;
      return { ok: true, pages: [], source: { kind: "folder", target: root } };
    }
  }));
  try {
    const started = await client.callTool({ name: "scan_project", arguments: { path: root } });
    assert.equal(started.structuredContent.state, "running");
    const jobId = started.structuredContent.id;
    await nextTurn();
    const running = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
    assert.deepEqual(running.structuredContent.progress, { phase: "scanning", name: "Home" });

    finish();
    let completed;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      completed = await client.callTool({ name: "get_job", arguments: { job_id: jobId } });
      if (completed.structuredContent.state !== "running") break;
    }
    assert.equal(completed.structuredContent.state, "complete");
    assert.equal(completed.structuredContent.result.pageCount, 0);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the repository canvas persists selection and resolves it back to exact source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-native-canvas-"));
  await writeFile(path.join(root, "Home.tsx"), [
    "export function Home() {",
    "  return <button>Continue</button>;",
    "}"
  ].join("\n"));
  const inventory = {
    ok: true,
    source: { kind: "folder", target: root },
    pages: [{
      id: "home", name: "Home", route: "/", recipe: [], variants: [],
      layerTree: {
        width: 1200, height: 800,
        tree: { id: "root", kind: "element", source: "Home.tsx:1:1", children: [] }
      },
      snapshot: { links: [{ href: "/next", label: "Continue" }] }
    }, {
      id: "next", name: "Next", route: "/next", recipe: [], variants: [],
      layerTree: {
        width: 1200, height: 800,
        tree: { id: "next-root", kind: "element", source: "Home.tsx:2:3", children: [] }
      },
      snapshot: { links: [] }
    }]
  };
  const fake = operations({
    listProjects: async () => [{ id: "0123456789abcdef", kind: "folder", name: "Example", target: root, lastScannedAt: "2026-08-29T12:00:00.000Z" }],
    getInventory: async () => inventory
  });
  const { client, server } = await connectedServer(fake);
  try {
    const opened = await client.callTool({ name: "open_crank_canvas", arguments: { repo_path: root } });
    const intent = opened.structuredContent.intentGraph;
    assert.equal(opened.structuredContent.scene.selection, null);
    assert.deepEqual(intent.screens[0].sourceRef, { file: "Home.tsx", line: 1, column: 1 });

    await client.callTool({
      name: "save_canvas_state",
      arguments: {
        inventory_id: "0123456789abcdef",
        intent_graph: intent,
        scene: {
          view: "map",
          showPreviews: true,
          nodes: [{ id: "home", x: 42, y: 84 }],
          selection: { kind: "screen", screenId: "home" }
        }
      }
    });
    const selected = await client.callTool({ name: "get_selection", arguments: { repo_path: root } });
    assert.deepEqual(selected.structuredContent.selection, { kind: "screen", screenId: "home" });
    const flow = await client.callTool({ name: "get_flow_selection", arguments: { repo_path: root } });
    assert.equal(flow.structuredContent.context.screen.name, "Home");
    assert.equal(flow.structuredContent.context.outgoing[0].toScreenId, "next");
    const source = await client.callTool({ name: "get_source_context", arguments: { repo_path: root } });
    assert.equal(source.structuredContent.context.sourceRef.file, "Home.tsx");
    assert.match(source.structuredContent.context.text, /2:   return <button>Continue<\/button>;/);

    const changed = structuredClone(intent);
    changed.screens[0].annotation = "Make the action larger";
    changed.screens[0].status = "modified";
    const applied = await client.callTool({
      name: "apply_change",
      arguments: { inventory_id: "0123456789abcdef", intent_graph: changed }
    });
    assert.equal(applied.structuredContent.manifest.changes[0].type, "update_screen");
    assert.deepEqual(applied.structuredContent.manifest.affectedSources, [{ file: "Home.tsx", line: 1, column: 1 }]);
    const changes = JSON.parse(await readFile(path.join(root, ".crank", "changes.json"), "utf8"));
    assert.equal(changes.manifest.changes[0].description.includes("Make the action larger"), true);
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
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
