const test = require("node:test");
const assert = require("node:assert/strict");
const { MAX_SCREENS, buildFigmaJob, clampSide, projectIdFor, safeScreenId } = require("./figma-export.cjs");

const tree = { kind: "element", name: "Root", width: 1200, height: 800, children: [] };
const page = (name, extra = {}) => ({
  id: `state-${name.toLowerCase()}`, name, route: "/", recipe: [], depth: 0, variants: [],
  figmaTree: { width: 1200, height: 800, tree }, ...extra
});

test("builds a job the bridge accepts", () => {
  const built = buildFigmaJob(
    { origin: "http://127.0.0.1:8787", pages: [page("Home"), page("Analytics")] },
    { projectName: "Catfolio", figmaFileName: "Catfolio design" }
  );
  assert.equal(built.ok, true);
  assert.equal(built.job.operation, "push");
  assert.match(built.job.projectId, /^[a-f0-9]{24}$/, "the bridge requires a 24-hex project id");
  assert.equal(built.job.screens.length, 2);
  const [screen] = built.job.screens;
  assert.equal(screen.renderMode, "editable-dom");
  assert.equal(screen.sourceType, "screen");
  assert.equal(screen.currentNodeId, null);
  assert.ok(screen.domTree, "the layer tree has to travel with the screen");
  assert.match(screen.id, /^[A-Za-z0-9_-]{1,120}$/);
});

test("the same app always gets the same project id", () => {
  assert.equal(projectIdFor("folder:/repos/site"), projectIdFor("folder:/repos/site"));
  assert.notEqual(projectIdFor("folder:/repos/site"), projectIdFor("folder:/repos/other"));
});

test("a folder keeps one project id however it was served this time", () => {
  // Every scan of a folder starts a server on a fresh port. Naming the project
  // after that origin gave it a new identity each run, so the plugin found none
  // of the frames it had tagged and drew the whole inventory again.
  const pages = [page("Home"), page("About")];
  const first = buildFigmaJob(
    { origin: "http://127.0.0.1:52341", source: { kind: "folder", target: "/repos/site" }, pages },
    { identity: "folder:/repos/site", projectName: "site", figmaFileName: "Design" }
  );
  const second = buildFigmaJob(
    { origin: "http://127.0.0.1:61208", source: { kind: "folder", target: "/repos/site" }, pages },
    { identity: "folder:/repos/site", projectName: "site", figmaFileName: "Design" }
  );
  assert.equal(first.job.projectId, second.job.projectId);
  assert.notEqual(
    first.job.projectId,
    buildFigmaJob({ origin: "http://127.0.0.1:52341", pages }, { identity: "folder:/repos/other" }).job.projectId
  );
});

test("builds a read job when asked for one", () => {
  const built = buildFigmaJob({ origin: "http://x", pages: [page("Home")] }, { operation: "pull" });
  assert.equal(built.job.operation, "pull");
});

test("carries an existing Figma node so a frame is reused, not duplicated", () => {
  const built = buildFigmaJob({ origin: "http://x", pages: [page("Home", { figmaNodeId: "12:34" })] });
  assert.equal(built.job.screens[0].currentNodeId, "12:34");
});

test("keeps sizes inside what the bridge allows", () => {
  assert.equal(clampSide(1200), 1200);
  assert.equal(clampSide(80), 320, "a tiny page still needs a usable frame");
  assert.equal(clampSide(99999), 40_000);
  assert.equal(clampSide(12_000), 12_000, "a long page keeps its real height");
  assert.equal(clampSide(0), 320);
  assert.equal(clampSide("nonsense"), 320);
});

test("cleans ids the bridge would reject", () => {
  assert.equal(safeScreenId("state-9f2c/dark mode"), "state-9f2c-dark-mode");
  assert.equal(safeScreenId("", 3), "screen-3");
});

test("reports pages with no layers instead of sending blank frames", () => {
  const built = buildFigmaJob({
    origin: "http://x",
    pages: [page("Home"), { id: "state-b", name: "Broken", figmaTree: null }]
  });
  assert.equal(built.job.screens.length, 1);
  assert.deepEqual(built.missing, ["Broken"]);
});

test("refuses a scan with nothing to send", () => {
  const built = buildFigmaJob({ origin: "http://x", pages: [{ id: "a", name: "Empty", figmaTree: null }] });
  assert.equal(built.ok, false);
  assert.match(built.message, /no page/i);
  assert.deepEqual(built.missing, ["Empty"]);
});

test("stays within the bridge's screen limit and says what was left out", () => {
  const pages = Array.from({ length: MAX_SCREENS + 3 }, (_, index) => page(`P${index}`));
  const built = buildFigmaJob({ origin: "http://x", pages });
  assert.equal(built.job.screens.length, MAX_SCREENS);
  assert.equal(built.dropped.length, 3);
});
