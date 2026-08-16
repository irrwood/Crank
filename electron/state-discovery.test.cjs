const test = require("node:test");
const assert = require("node:assert/strict");
const {
  discoverStates,
  isDestructiveLabel,
  isFrameworkInternalPath,
  planNextStep,
  rankCandidates,
  signatureOf
} = require("./state-discovery.cjs");

/**
 * A fake app: a state machine of screens, each with controls. Lets the
 * traversal logic be verified against a known answer without Electron.
 */
function fakeSession(screens, { startRoute = "/" } = {}) {
  let current = startRoute;
  const visits = [];
  const snapshotOf = (key) => {
    const screen = screens[key];
    if (!screen) return null;
    return {
      title: screen.title ?? key,
      heading: screen.title ?? key,
      url: screen.url ?? key,
      fingerprint: screen.fingerprint ?? [key],
      candidates: (screen.controls ?? []).map((control) => ({
        locator: control.locator,
        label: control.label,
        role: control.role ?? "button",
        href: null,
        inNav: Boolean(control.inNav),
        hasExpanded: false
      }))
    };
  };
  return {
    visits,
    goto(route) {
      current = route;
      visits.push({ kind: "goto", route });
      return Promise.resolve(snapshotOf(route));
    },
    click(locator) {
      visits.push({ kind: "click", locator, from: current });
      const screen = screens[current];
      const control = (screen?.controls ?? []).find((entry) => entry.locator === locator);
      if (!control || !control.to) return Promise.resolve(null);
      current = control.to;
      return Promise.resolve(snapshotOf(current));
    }
  };
}

test("flags destructive labels in several languages", () => {
  assert.equal(isDestructiveLabel("Delete project"), true);
  assert.equal(isDestructiveLabel("删除看板"), true);
  assert.equal(isDestructiveLabel("Sign out"), true);
  assert.equal(isDestructiveLabel("Settings"), false);
  assert.equal(isDestructiveLabel(""), false);
  assert.equal(isDestructiveLabel(null), false);
});

test("tries navigation controls before arbitrary buttons", () => {
  const ranked = rankCandidates([
    { locator: "a", label: "Random", role: "button" },
    { locator: "b", label: "Details", role: "link" },
    { locator: "c", label: "Overview", role: "tab" },
    { locator: "d", label: "Sidebar item", role: "", inNav: true }
  ]).map((candidate) => candidate.locator);
  assert.deepEqual(ranked, ["c", "d", "b", "a"]);
});

test("signature ignores object identity but tracks structure", () => {
  assert.equal(signatureOf(["a", "b"]), signatureOf(["a", "b"]));
  assert.notEqual(signatureOf(["a", "b"]), signatureOf(["a", "c"]));
});

test("explores breadth-first and stops at max depth", () => {
  const frontier = [
    { recipe: [], pending: [{ locator: "x" }] },
    { recipe: [{}, {}], pending: [{ locator: "tooDeep" }] }
  ];
  const first = planNextStep(frontier, { maxDepth: 2 });
  assert.equal(first.action.locator, "x");
  // The shallow item is exhausted and the deep one is at the limit.
  assert.equal(planNextStep(frontier, { maxDepth: 2 }), null);
});

test("finds tab and modal states behind one URL", async () => {
  const session = fakeSession({
    "/": {
      title: "Board",
      fingerprint: ["board-default"],
      controls: [
        { locator: "#tab-list", label: "List", role: "tab", to: "list" },
        { locator: "#tab-cal", label: "Calendar", role: "tab", to: "calendar" },
        { locator: "#open-modal", label: "New item", to: "modal" },
        { locator: "#danger", label: "Delete board", to: "gone" }
      ]
    },
    list: { title: "Board", fingerprint: ["board-list"], controls: [] },
    calendar: { title: "Board", fingerprint: ["board-calendar"], controls: [] },
    modal: { title: "Board", fingerprint: ["board-modal"], controls: [] },
    gone: { title: "Deleted", fingerprint: ["gone"], controls: [] }
  });

  const { states, skipped } = await discoverStates(session, { routes: ["/"], maxDepth: 2 });
  const names = states.map((state) => state.name);

  assert.equal(states.length, 4, `expected 4 states, got ${JSON.stringify(names)}`);
  assert.ok(names.some((name) => name.includes("List")));
  assert.ok(names.some((name) => name.includes("Calendar")));
  assert.ok(names.some((name) => name.includes("New item")));
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].label, /Delete board/);
  assert.ok(
    session.visits.every((visit) => visit.locator !== "#danger"),
    "a destructive control must never be clicked"
  );
});

test("gives every state a replay recipe that starts from a fresh load", async () => {
  const session = fakeSession({
    "/": { fingerprint: ["home"], controls: [{ locator: "#a", label: "Settings", to: "settings" }] },
    settings: { fingerprint: ["settings"], controls: [{ locator: "#b", label: "Advanced", to: "advanced" }] },
    advanced: { fingerprint: ["advanced"], controls: [] }
  });
  const { states } = await discoverStates(session, { routes: ["/"], maxDepth: 3 });

  const advanced = states.find((state) => state.depth === 2);
  assert.ok(advanced, "should reach a depth-2 state");
  assert.deepEqual(advanced.recipe.map((step) => step.locator), ["#a", "#b"]);
  assert.equal(advanced.route, "/");
});

test("does not record the same visual state twice", async () => {
  const session = fakeSession({
    "/": {
      fingerprint: ["same"],
      controls: [
        { locator: "#one", label: "One", to: "dup" },
        { locator: "#two", label: "Two", to: "dup" }
      ]
    },
    dup: { fingerprint: ["duplicate"], controls: [] }
  });
  const { states } = await discoverStates(session, { routes: ["/"], maxDepth: 2 });
  assert.equal(states.length, 2, "identical fingerprints must collapse into one state");
});

test("honours the state budget", async () => {
  const controls = Array.from({ length: 20 }, (_, index) => ({
    locator: `#c${index}`, label: `Item ${index}`, to: `s${index}`
  }));
  const screens = { "/": { fingerprint: ["root"], controls } };
  for (let index = 0; index < 20; index += 1) {
    screens[`s${index}`] = { fingerprint: [`state-${index}`], controls: [] };
  }
  const { states } = await discoverStates(fakeSession(screens), { routes: ["/"], maxStates: 5 });
  assert.equal(states.length, 5);
});

test("treats framework internals as tooling, not application writes", () => {
  // Blocking these does not protect data and breaks the app: cutting off
  // vinext's stack-trace endpoint drove its overlay to ~11k retries in 3s.
  assert.equal(isFrameworkInternalPath("/__vinext_original-stack-trace"), true);
  assert.equal(isFrameworkInternalPath("/@vite/client"), true);
  assert.equal(isFrameworkInternalPath("/_next/static/chunk.js"), true);
  assert.equal(isFrameworkInternalPath("/api/notes"), false);
  assert.equal(isFrameworkInternalPath("/graphql"), false);
  assert.equal(isFrameworkInternalPath(""), false);
});
