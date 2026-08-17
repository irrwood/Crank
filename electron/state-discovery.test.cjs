const test = require("node:test");
const assert = require("node:assert/strict");
const {
  changeMagnitude,
  chooseStateName,
  discoverStates,
  humanizeStateName,
  isVolatileText,
  isAppearanceLabel,
  isDestructiveLabel,
  isFrameworkInternalPath,
  isHtmlContentType,
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
      contentType: screen.contentType ?? "text/html",
      title: screen.title ?? key,
      heading: screen.title ?? key,
      url: screen.url ?? key,
      // Real fingerprints always carry element size; give bare test entries a
      // page-sized one so they read as real changes rather than tooltips.
      fingerprint: (screen.fingerprint ?? [key]).map(
        (entry) => (entry.includes("|") ? entry : `div|${entry}||120x90`)
      ),
      // Distinct screens get distinct skeletons unless a test says otherwise,
      // so only deliberate re-skins are grouped.
      skeleton: screen.skeleton ?? screen.fingerprint ?? [key],
      candidates: (screen.controls ?? []).map((control) => ({
        locator: control.locator,
        label: control.label,
        role: control.role ?? "button",
        href: control.href ?? null,
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
    list: { title: "Board", url: "/", fingerprint: ["board-list"], controls: [] },
    calendar: { title: "Board", url: "/", fingerprint: ["board-calendar"], controls: [] },
    modal: { title: "Board", url: "/", fingerprint: ["board-modal"], controls: [] },
    gone: { title: "Deleted", url: "/", fingerprint: ["gone"], controls: [] }
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
    "/": { url: "/", fingerprint: ["home"], controls: [{ locator: "#a", label: "Settings", to: "settings" }] },
    settings: { url: "/", fingerprint: ["settings"], controls: [{ locator: "#b", label: "Advanced", to: "advanced" }] },
    advanced: { url: "/", fingerprint: ["advanced"], controls: [] }
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
      url: "/",
      controls: [
        { locator: "#one", label: "One", to: "dup" },
        { locator: "#two", label: "Two", to: "dup" }
      ]
    },
    dup: { url: "/", fingerprint: ["duplicate"], controls: [] }
  });
  const { states } = await discoverStates(session, { routes: ["/"], maxDepth: 2 });
  assert.equal(states.length, 2, "identical fingerprints must collapse into one state");
});

test("honours the state budget", async () => {
  const controls = Array.from({ length: 20 }, (_, index) => ({
    locator: `#c${index}`, label: `Item ${index}`, to: `s${index}`
  }));
  const screens = { "/": { url: "/", fingerprint: ["root"], controls } };
  for (let index = 0; index < 20; index += 1) {
    screens[`s${index}`] = { url: "/", fingerprint: [`state-${index}`], controls: [] };
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

test("reduces a link-reached state to a direct address", async () => {
  // Found by clicking, but /about stands on its own. The recipe collapses so
  // the page can be recaptured later without replaying how it was first found.
  const screens = {
    "/": { url: "/", fingerprint: ["home"], controls: [{ locator: "#nav", label: "About", role: "link", to: "/about" }] },
    "/about": { url: "/about", fingerprint: ["about"], controls: [] }
  };
  const { states } = await discoverStates(fakeSession(screens), { routes: ["/"], maxDepth: 2 });
  const about = states.find((state) => state.name.includes("about") || state.route === "/about");
  assert.ok(about, `no /about state in ${JSON.stringify(states.map((s) => s.route))}`);
  assert.deepEqual(about.recipe, [], "a directly addressable page needs no click recipe");
  assert.equal(about.route, "/about");
});

test("rejects names that rename themselves tomorrow", () => {
  // The real trigger: this app's <h1> is "Today, Sunday, 16 August".
  assert.equal(isVolatileText("Today, Sunday, 16 August"), true);
  assert.equal(isVolatileText("今天 星期日"), true);
  assert.equal(isVolatileText("2026-08-16"), true);
  assert.equal(isVolatileText("10:30"), true);
  assert.equal(isVolatileText("3 分钟前"), true);
  assert.equal(isVolatileText(""), true);
  assert.equal(isVolatileText("全部记录"), false);
  assert.equal(isVolatileText("Settings"), false);
  assert.equal(isVolatileText("Raw Data"), false);
});

test("names a state from the control that opened it, not a drifting heading", () => {
  assert.equal(
    chooseStateName({
      recipe: [{ label: "全部记录" }],
      route: "/",
      heading: "Today, Sunday, 16 August",
      title: "Research Memory"
    }),
    "全部记录 · Research Memory"
  );
  // With no stable signal anywhere, the address still identifies the page.
  assert.equal(
    chooseStateName({ recipe: [], route: "/?view=settings", heading: "Today, Sunday, 16 August", title: "9:41" }),
    "Settings"
  );
  assert.equal(chooseStateName({ recipe: [], route: "/" }), "Home");
  assert.equal(chooseStateName({ recipe: [], route: "/holdings/detail" }), "Holdings Detail");
});

test("does not repeat an identical name part", () => {
  assert.equal(humanizeStateName(["新任务", "新任务"]), "新任务");
});

test("measures change by the largest moved region", () => {
  const viewport = { width: 1000, height: 800 };
  const base = ["div|app||125x100"];
  // A dropdown: 160x120 css px out of 800k.
  const dropdown = [...base, "ul|menu||20x15"];
  assert.ok(changeMagnitude(base, dropdown, viewport) < 0.12, "a dropdown is not a page");
  // A modal covering most of the viewport.
  const modal = [...base, "div|modal||100x75"];
  assert.ok(changeMagnitude(base, modal, viewport) > 0.12, "a modal is a page");
  assert.equal(changeMagnitude(base, base, viewport), 0);
});

test("keeps small-change states out of the inventory but reports them", async () => {
  const session = fakeSession({
    "/": {
      url: "/",
      fingerprint: ["main|app||125x100"],
      controls: [
        { locator: "#tip", label: "Show tooltip", to: "tooltip" },
        { locator: "#tab", label: "Reports", role: "tab", to: "reports" }
      ]
    },
    tooltip: { url: "/", fingerprint: ["main|app||125x100", "span|tip||8x4"], controls: [] },
    reports: { url: "/", fingerprint: ["main|app||125x100", "section|reports||120x90"], controls: [] }
  });
  const { states, filtered } = await discoverStates(session, { routes: ["/"], maxDepth: 1 });
  const names = states.map((state) => state.name);
  assert.equal(states.length, 2, `expected Home + Reports, got ${JSON.stringify(names)}`);
  assert.ok(names.some((name) => name.includes("Reports")));
  assert.equal(filtered.length, 1);
  assert.match(filtered[0].label, /tooltip/i);
});

test("a different address is a page even when it looks almost identical", async () => {
  // Sibling pages from one template differ by a heading. Judging them by how
  // much moved would filter out the entire nav bar of a templated site.
  const nav = { locator: "#about", label: "About", role: "link", to: "/about" };
  const session = fakeSession({
    "/": { url: "/", fingerprint: ["main|page||125x100", "h1|title|Home|30x4"], controls: [nav] },
    "/about": { url: "/about", fingerprint: ["main|page||125x100", "h1|title|About|30x4"], controls: [] }
  });
  const { states, filtered } = await discoverStates(session, { routes: ["/"], maxDepth: 1 });
  assert.equal(filtered.length, 0, `nothing should be filtered, got ${JSON.stringify(filtered)}`);
  assert.ok(
    states.some((state) => state.route === "/about"),
    `/about missing from ${JSON.stringify(states.map((s) => s.route))}`
  );
});

test("groups a re-skinned page as one page with variants", async () => {
  // A theme or language switch rewrites text and colours across the whole app
  // while leaving the structure alone. Listing those as separate pages doubles
  // the inventory: a real scan produced English and Chinese copies of every page.
  const shared = ["main@0", "h1@1"];
  const session = fakeSession({
    "/": {
      url: "/", fingerprint: ["home-en"], skeleton: shared,
      controls: [
        { locator: "#zh", label: "中文", to: "home-zh" },
        { locator: "#dark", label: "Dark", to: "home-dark" }
      ]
    },
    "home-zh": { url: "/", fingerprint: ["home-zh"], skeleton: shared, controls: [] },
    "home-dark": { url: "/", fingerprint: ["home-dark"], skeleton: shared, controls: [] }
  });

  const { states } = await discoverStates(session, { routes: ["/"], maxDepth: 1 });
  assert.equal(states.length, 1, `expected one page, got ${JSON.stringify(states.map((s) => s.name))}`);
  assert.deepEqual(states[0].variants.map((variant) => variant.name), ["中文", "Dark"]);
  // Each variant keeps its own way back, so it can be captured again.
  assert.deepEqual(states[0].variants.map((variant) => variant.recipe[0].locator), ["#zh", "#dark"]);
});

test("keeps genuinely different pages apart", async () => {
  const session = fakeSession({
    "/": {
      url: "/", fingerprint: ["home"], skeleton: ["main@0"],
      controls: [{ locator: "#reports", label: "Reports", role: "tab", to: "reports" }]
    },
    reports: { url: "/", fingerprint: ["reports"], skeleton: ["main@0", "table@1"], controls: [] }
  });
  const { states } = await discoverStates(session, { routes: ["/"], maxDepth: 1 });
  assert.equal(states.length, 2, "different structure must stay a separate page");
  assert.equal(states[0].variants.length, 0);
});

test("does not merge two addresses that happen to share a structure", async () => {
  // Sibling pages of one template have identical tag structure. They are
  // separate pages, so the address has to take part in the grouping.
  const shared = ["main@0", "h1@1"];
  const session = fakeSession({
    "/": { url: "/", fingerprint: ["home"], skeleton: shared,
      controls: [{ locator: "#about", label: "About", role: "link", to: "/about" }] },
    "/about": { url: "/about", fingerprint: ["about"], skeleton: shared, controls: [] }
  });
  const { states } = await discoverStates(session, { routes: ["/"], maxDepth: 1 });
  assert.equal(states.length, 2, "same structure at a different address is a different page");
  assert.equal(states[0].variants.length, 0);
});

test("does not re-walk an address it already has", async () => {
  // The brand link sits on every page and points home. Following it from each
  // page re-walks a known page and wastes most of the crawl.
  const home = { locator: "#brand", label: "Catfolio", role: "link", href: "/", to: "/" };
  const session = fakeSession({
    "/": {
      url: "/", fingerprint: ["home"], skeleton: ["main@0"],
      controls: [{ locator: "#import", label: "Import", role: "link", href: "/import", to: "/import" }]
    },
    "/import": {
      url: "/import", fingerprint: ["import"], skeleton: ["main@0", "form@1"],
      controls: [home]
    }
  });
  const { states } = await discoverStates(session, { routes: ["/"], maxDepth: 2 });
  assert.deepEqual(states.map((state) => state.route).sort(), ["/", "/import"]);
  assert.ok(
    session.visits.every((visit) => visit.locator !== "#brand"),
    "a link to a page already in the inventory must not be clicked"
  );
});

test("an endpoint that answers with JSON is not a page", async () => {
  assert.equal(isHtmlContentType("text/html; charset=utf-8"), true);
  assert.equal(isHtmlContentType("application/xhtml+xml"), true);
  assert.equal(isHtmlContentType("application/json"), false);
  assert.equal(isHtmlContentType("text/xml"), false);
  // Unknown type must not silently drop a real page.
  assert.equal(isHtmlContentType(""), true);

  const session = fakeSession({
    "/": {
      url: "/", contentType: "text/html", fingerprint: ["home"], skeleton: ["main@0"],
      controls: [{ locator: "#api", label: "Holdings JSON", role: "link", href: "/api/holdings", to: "/api/holdings" }]
    },
    "/api/holdings": {
      url: "/api/holdings", contentType: "application/json",
      fingerprint: ["pre-json"], skeleton: ["pre@0"], controls: []
    }
  });
  const { states, filtered } = await discoverStates(session, { routes: ["/"], maxDepth: 1 });
  assert.deepEqual(states.map((state) => state.route), ["/"]);
  assert.match(filtered.map((item) => item.reason).join(" "), /application\/json/);
});

test("clears what a page remembered, but only when something could have stuck", async () => {
  // Clearing storage is what stops one language click colouring every later
  // page, but a crawl makes hundreds of replays and clearing is expensive, so
  // only the clicks that can persist a preference should pay for it.
  const resets = [];
  const screens = {
    "/": {
      url: "/", fingerprint: ["home"], skeleton: ["main@0"],
      controls: [
        { locator: "#zh", label: "Switch to Chinese", role: "tab", to: "zh" },
        { locator: "#reports", label: "Reports", role: "tab", to: "reports" },
        { locator: "#billing", label: "Billing", role: "tab", to: "billing" }
      ]
    },
    zh: { url: "/", fingerprint: ["home-zh"], skeleton: ["main@0"], controls: [] },
    reports: { url: "/", fingerprint: ["reports"], skeleton: ["main@0", "table@1"], controls: [] },
    billing: { url: "/", fingerprint: ["billing"], skeleton: ["main@0", "form@1"], controls: [] }
  };
  const base = fakeSession(screens);
  const session = { ...base, reset: async () => { resets.push(base.visits.length); } };
  await discoverStates(session, { routes: ["/"], maxDepth: 1 });

  // Three clicks, one of which could persist: exactly one clear, not three.
  assert.equal(resets.length, 1, `expected one reset, got ${resets.length}`);
  const languageClickAt = base.visits.findIndex((visit) => visit.locator === "#zh");
  assert.ok(languageClickAt >= 0, "the language control must have been clicked");
  assert.ok(resets[0] > languageClickAt, "and the clear must follow it, not precede an ordinary click");
});

test("an appearance switch does not get to name a page", () => {
  // "Light Mode · Comparison" hides which page it is behind how it looks.
  assert.equal(isAppearanceLabel("Light Mode"), true);
  assert.equal(isAppearanceLabel("Switch to Chinese"), true);
  assert.equal(isAppearanceLabel("切换语言"), true);
  assert.equal(isAppearanceLabel("Holdings"), false);
  assert.equal(isAppearanceLabel("全部记录"), false);

  assert.equal(
    chooseStateName({ recipe: [{ label: "Light Mode" }], route: "/returns", heading: "Comparison", title: "Catfolio" }),
    "Returns · Comparison"
  );
  // A real control still names its page.
  assert.equal(
    chooseStateName({ recipe: [{ label: "Holdings" }], route: "/", heading: "Portfolio", title: "Catfolio" }),
    "Holdings · Portfolio"
  );
});
