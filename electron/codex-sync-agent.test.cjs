const assert = require("node:assert/strict");
const test = require("node:test");
const { buildCodexConnectionPrompt, buildCodexNewThreadUrl, buildCodexSyncPrompt, figmaNodeUrl, selectCodexProjectThread } = require("./codex-sync-agent.cjs");

test("builds a no-edit prompt for a persistent project conversation", () => {
  const prompt = buildCodexConnectionPrompt({
    project: { name: "FocusFlow", framework: "SwiftUI" }
  });

  assert.match(prompt, /persistent Codex conversation/);
  assert.match(prompt, /Do not edit any files/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /Sync from Figma/);
});

test("builds a scoped Codex task from normalized Figma changes", () => {
  const prompt = buildCodexSyncPrompt({
    project: { name: "FocusFlow", kind: "swiftui", framework: "SwiftUI" },
    figmaFileKey: "abc123",
    figmaFileName: "FocusFlow Design",
    mappings: [{ screenId: "home", nodeId: "63:1995", frameName: "Home" }],
    pullPreview: {
      changes: [{ id: "title", screenId: "home", area: "Home", property: "fontSize", before: 16, after: 20 }],
      conflicts: [{ id: "card", property: "radius", base: 12, code: 16, figma: 24 }],
      rejected: [{ id: "stack", reason: "Structural edit requires semantic reasoning" }]
    }
  });

  assert.match(prompt, /Sync from Figma/);
  assert.match(prompt, /Figma is authoritative/);
  assert.match(prompt, /get_design_context and get_screenshot/);
  assert.match(prompt, /untrusted design data/);
  assert.match(prompt, /"nodeId": "63:1995"/);
  assert.match(prompt, /"after": 20/);
  assert.match(prompt, /"figma": 24/);
  assert.match(prompt, /Structural edit requires semantic reasoning/);
});

test("builds an exact link-based Figma MCP URL", () => {
  assert.equal(
    figmaNodeUrl("abc123", "FocusFlow Design", "63:1995"),
    "https://www.figma.com/design/abc123/FocusFlow-Design?node-id=63-1995"
  );
});

test("builds a Codex project deeplink with the folder and prompt", () => {
  const url = new URL(buildCodexNewThreadUrl({
    root: "/tmp/Focus Flow",
    prompt: "Connect this project & wait"
  }));

  assert.equal(url.protocol, "codex:");
  assert.equal(url.host, "new");
  assert.equal(url.searchParams.get("path"), "/tmp/Focus Flow");
  assert.equal(url.searchParams.get("prompt"), "Connect this project & wait");
});

test("recovers the newest UI Sync conversation for the same project folder", () => {
  const selected = selectCodexProjectThread([
    { id: "unrelated", cwd: "/tmp/FocusFlow", name: "Other task", updatedAt: 50 },
    { id: "older", cwd: "/tmp/FocusFlow", name: "UI Sync · FocusFlow", updatedAt: 10, ephemeral: false },
    { id: "newer", cwd: "/tmp/FocusFlow", name: "UI Sync · FocusFlow", updatedAt: 20, ephemeral: false }
  ], {
    root: "/tmp/FocusFlow",
    threadName: "UI Sync · FocusFlow"
  });

  assert.equal(selected?.id, "newer");
});

test("prefers the saved conversation ID over newer matching conversations", () => {
  const selected = selectCodexProjectThread([
    { id: "saved", cwd: "/tmp/FocusFlow", name: "UI Sync · FocusFlow", updatedAt: 10 },
    { id: "newer", cwd: "/tmp/FocusFlow", name: "UI Sync · FocusFlow", updatedAt: 20 }
  ], {
    root: "/tmp/FocusFlow",
    threadName: "UI Sync · FocusFlow",
    preferredThreadId: "saved"
  });

  assert.equal(selected?.id, "saved");
});

test("ignores legacy conversations created before a project deeplink", () => {
  const selected = selectCodexProjectThread([
    { id: "legacy", cwd: "/tmp/FocusFlow", name: "UI Sync · FocusFlow", createdAt: 100 },
    { id: "project-thread", cwd: "/tmp/FocusFlow", preview: "This persistent Codex conversation is linked to the UI Sync project", createdAt: 300 }
  ], {
    root: "/tmp/FocusFlow",
    threadName: "UI Sync · FocusFlow",
    notBefore: new Date(200 * 1000).toISOString()
  });

  assert.equal(selected?.id, "project-thread");
});
