const assert = require("node:assert/strict");
const test = require("node:test");
const { createFigmaBridge } = require("./figma-bridge.cjs");

test("serves a pairing job and records automatic frame mappings", async () => {
  const connectionToken = "a".repeat(64);
  let completion = null;
  const bridge = createFigmaBridge({
    port: 0,
    onComplete: async (context, result) => {
      completion = { context, result };
    }
  });
  await bridge.start();
  const session = bridge.enqueue({
    projectId: "0123456789abcdef01234567",
    projectName: "Sample",
    figmaFileName: "Sample Design",
    screens: [{ id: "screen-one", name: "Home", sourceType: "screen", currentNodeId: null, renderMode: "structured", uiTree: { type: "text", text: "Home" } }]
  }, { root: "/tmp/sample" }, connectionToken);

  assert.match(session.pairingCode, /^\d{6}$/);
  assert.equal(bridge.getStatus(session.pairingCode).state, "waiting");
  const jobResponse = await fetch(`http://localhost:${bridge.port}/v1/jobs/${session.pairingCode}`);
  assert.equal(jobResponse.status, 200);
  const pairedJob = await jobResponse.json();
  assert.equal(pairedJob.screens[0].name, "Home");
  assert.equal(pairedJob.connectionToken, connectionToken);
  assert.equal(bridge.getStatus(session.pairingCode).state, "running");

  const rememberedResponse = await fetch(`http://localhost:${bridge.port}/v1/connections/${connectionToken}/job?fileName=${encodeURIComponent("Sample Design")}`);
  assert.equal(rememberedResponse.status, 200);
  assert.equal((await rememberedResponse.json()).pairingCode, session.pairingCode);

  const completeResponse = await fetch(`http://localhost:${bridge.port}/v1/jobs/${session.pairingCode}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      fileName: "Sample Design",
      mappings: [{
        screenId: "screen-one",
        nodeId: "12:34",
        frameName: "Home",
        disposition: "created",
        contentDisposition: "rendered"
      }]
    })
  });
  assert.equal(completeResponse.status, 200);
  assert.equal(bridge.getStatus(session.pairingCode).state, "complete");
  assert.equal(bridge.getStatus(session.pairingCode).renderedCount, 1);
  assert.equal(completion.context.root, "/tmp/sample");
  assert.equal(completion.result.mappings[0].nodeId, "12:34");
  const idleResponse = await fetch(`http://localhost:${bridge.port}/v1/connections/${connectionToken}/job?fileName=${encodeURIComponent("Sample Design")}`);
  assert.equal(idleResponse.status, 204);

  bridge.enqueue({
    projectId: "fedcba987654321001234567",
    projectName: "Another Project",
    figmaFileName: "Another Design",
    screens: [{ id: "screen-two", name: "Settings", sourceType: "screen", currentNodeId: null, renderMode: "structured", uiTree: { type: "text", text: "Settings" } }]
  }, { root: "/tmp/another" }, connectionToken);
  const otherProjectResponse = await fetch(`http://localhost:${bridge.port}/v1/connections/${connectionToken}/job?fileName=${encodeURIComponent("Another Design")}`);
  assert.equal(otherProjectResponse.status, 200);
  assert.equal((await otherProjectResponse.json()).projectName, "Another Project");
  await bridge.stop();
});

test("rejects malformed automatic mapping jobs", () => {
  const bridge = createFigmaBridge({ port: 0, onComplete: async () => {} });
  assert.throws(() => bridge.enqueue({ projectId: "path-leak", screens: [] }, {}, "invalid"));
});

test("validates measured web text without dropping font or line geometry", async () => {
  const token = "d".repeat(64);
  const bridge = createFigmaBridge({ port: 0, onComplete: async () => {} });
  await bridge.start();
  const session = bridge.enqueue({
    projectId: "222222222222222222222222",
    projectName: "React App",
    figmaFileName: "Measured Text",
    screens: [{
      id: "home", name: "Home", sourceType: "screen", currentNodeId: null, renderMode: "editable-dom", width: 1280, height: 720,
      domTree: {
        kind: "element", id: "root", selector: "#root", name: "Root", x: 0, y: 0, width: 1280, height: 720,
        style: {
          backgroundColor: "rgba(0, 0, 0, 0)", borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)",
          borderBottomColor: "rgba(0, 0, 0, 0)", borderLeftColor: "rgba(0, 0, 0, 0)", borderTopWidth: 0, borderRightWidth: 0,
          borderBottomWidth: 0, borderLeftWidth: 0, borderRadius: 0, opacity: 1, clipsContent: false
        },
        children: [{
          kind: "text", id: "root/text:0", selector: ".title", name: "Text", text: "Measured text", sourceText: "Measured text",
          x: 24, y: 24, width: 160, height: 28, layoutWidth: 160, layoutX: 24, wrapMode: "nowrap", lineCount: 1,
          lineBreakOffsets: [8],
          lineRects: [{ x: 0, y: 0, width: 160, height: 28 }],
          style: {
            color: "rgb(0, 0, 0)", fontSize: 22, fontWeight: 700, lineHeight: 28, letterSpacing: 0, textAlign: "left",
            fontFamilies: ["Inter", "sans-serif"], resolvedFontFamily: "Inter", fontStyle: "normal", fontStretch: "100%",
            whiteSpace: "nowrap", wordBreak: "normal", overflowWrap: "normal", direction: "ltr", writingMode: "horizontal-tb"
          }
        }]
      }
    }]
  }, { root: "/tmp/react" }, token);
  const response = await fetch(`http://localhost:${bridge.port}/v1/jobs/${session.pairingCode}`);
  const job = await response.json();
  const text = job.screens[0].domTree.children[0];
  assert.equal(text.style.resolvedFontFamily, "Inter");
  assert.equal(text.lineCount, 1);
  assert.deepEqual(text.lineBreakOffsets, [8]);
  assert.deepEqual(text.lineRects, [{ x: 0, y: 0, width: 160, height: 28 }]);
  await bridge.stop();
});

test("serves local application snapshots without exposing a filesystem path", async () => {
  const token = "c".repeat(64);
  const bridge = createFigmaBridge({ port: 0, onComplete: async () => {} });
  await bridge.start();
  const assets = new Map([["screen-app", { buffer: Buffer.from([137, 80, 78, 71]), width: 1220, height: 790 }]]);
  const session = bridge.enqueue({
    projectId: "111111111111111111111111",
    projectName: "UI Sync",
    figmaFileName: "Sample Design",
    screens: [{ id: "screen-app", name: "Sync", sourceType: "screen", currentNodeId: null, renderMode: "snapshot", width: 1220, height: 790 }]
  }, { root: "/tmp/ui-sync" }, token, assets);
  const jobResponse = await fetch(`http://localhost:${bridge.port}/v1/jobs/${session.pairingCode}`);
  const job = await jobResponse.json();
  assert.equal(job.screens[0].renderMode, "snapshot");
  assert.equal(JSON.stringify(job).includes("/tmp/ui-sync"), false);
  const assetResponse = await fetch(`http://localhost:${bridge.port}/v1/jobs/${session.pairingCode}/assets/screen-app.png`);
  assert.equal(assetResponse.status, 200);
  assert.equal(assetResponse.headers.get("content-type"), "image/png");
  assert.deepEqual([...new Uint8Array(await assetResponse.arrayBuffer())], [137, 80, 78, 71]);
  await bridge.stop();
});

test("a pairing code can be had with nothing behind it", async () => {
  // Connecting used to require sending pages somewhere, which is backwards for
  // someone who has just installed the plugin: they have no pages yet, and no
  // file chosen to put them in.
  const connectionToken = "c".repeat(64);
  let completion = null;
  const bridge = createFigmaBridge({
    port: 0,
    onComplete: async (context, result) => { completion = { context, result }; return {}; }
  });
  await bridge.start();
  try {
    const session = bridge.enqueue({
      operation: "pair",
      projectId: "0123456789abcdef01234567",
      projectName: "Crank",
      figmaFileName: "",
      screens: []
    }, { pairing: true, connectionToken }, connectionToken);
    assert.match(session.pairingCode, /^\d{6}$/);
    assert.equal(session.screenCount, 0);

    // The plugin fetches it by code like any other job, and is handed the token.
    const job = await (await fetch(`http://localhost:${bridge.port}/v1/jobs/${session.pairingCode}`)).json();
    assert.equal(job.operation, "pair");
    assert.equal(job.connectionToken, connectionToken);

    const done = await fetch(`http://localhost:${bridge.port}/v1/jobs/${session.pairingCode}/complete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operation: "pair", fileName: "Whatever file is open" })
    });
    assert.equal(done.status, 200);
    assert.equal(bridge.getStatus(session.pairingCode).state, "complete");
    assert.equal(completion.result.operation, "pair", "the app is told this was a pairing, not a push");
    assert.equal(completion.context.pairing, true);
  } finally {
    await bridge.stop();
  }
});

test("a push still has to name a file and carry pages", async () => {
  const bridge = createFigmaBridge({ port: 0, onComplete: async () => ({}) });
  const connectionToken = "d".repeat(64);
  assert.throws(() => bridge.enqueue({
    projectId: "0123456789abcdef01234567",
    projectName: "Sample",
    figmaFileName: "",
    screens: []
  }, { root: "/tmp/sample" }, connectionToken));
});
