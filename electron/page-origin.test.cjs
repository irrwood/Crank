const test = require("node:test");
const assert = require("node:assert/strict");
const { isAppOrigin, isFileOrigin, originOf, routeWithin, withinOrigin } = require("./page-origin.cjs");
const { createBrowsingSession } = require("./browsing-session.cjs");

const installed = "file:///Applications/Ledger.app/Contents/Resources/app.asar/dist/index.html";
const app = "file:///Applications/Ledger.app/Contents/Resources/app.asar/dist/";

test("an app loaded from disk has its own folder for an origin", () => {
  assert.equal(originOf(installed), app);
  assert.equal(originOf("http://localhost:5173/dashboard"), "http://localhost:5173");
  assert.equal(isFileOrigin(app), true);
  assert.equal(isFileOrigin("http://localhost:5173"), false);
});

test("an app that registered a scheme of its own is that scheme and host", () => {
  // A real one: ChatWise serves its interface from client://app/. The browser
  // calls that origin "null", which is not even a URL — parsing it is what
  // turned a scan of it into "Invalid URL".
  const own = originOf("client://app/?chat=u1amzv4kql");
  assert.equal(own, "client://app");
  assert.equal(isAppOrigin(own), true);
  assert.equal(originOf("app://-/index.html"), "app://-");
  assert.equal(withinOrigin("client://app/settings", own), true);
  // A prefix is not a boundary: this is a different app, not a page of that one.
  assert.equal(withinOrigin("client://application/settings", own), false);
  assert.equal(withinOrigin("https://api.example.com/rows", own), false);
  // Its pages are already addressed relative to it; only a folder has a prefix
  // worth stripping.
  assert.equal(routeWithin("/settings", own), "/settings");
  assert.equal(isAppOrigin("http://localhost:5173"), false);
  assert.equal(isFileOrigin(own), false);
});

test("the app's own pages belong to it and the rest of the machine does not", () => {
  assert.equal(withinOrigin(installed, app), true);
  assert.equal(withinOrigin(`${app}settings.html`, app), true);
  // Chromium reports the origin of every file as "null", so without this the
  // whole disk is either inside the app or outside it.
  assert.equal(withinOrigin("file:///Users/me/.ssh/id_rsa", app), false);
  assert.equal(withinOrigin("https://analytics.example.com/collect", app), false);
  assert.equal(withinOrigin("http://localhost:5173/a", "http://localhost:5173"), true);
  assert.equal(withinOrigin("http://localhost:5174/a", "http://localhost:5173"), false);
});

test("a route is what is below the app, not where the app was installed", () => {
  // Routes travel into page names and Figma frame names; the folders above the
  // app say where someone dragged it, which names nothing.
  assert.equal(routeWithin("/Applications/Ledger.app/Contents/Resources/app.asar/dist/index.html", app), "index.html");
  assert.equal(routeWithin("/somewhere/else.html", app), "/somewhere/else.html");
  assert.equal(routeWithin("/dashboard", "http://localhost:5173"), "/dashboard");
});

/** A driver that records where it was told to go and reports where it landed. */
function fakeDriver({ at = installed } = {}) {
  const navigated = [];
  let here = at;
  return {
    navigated,
    land(url) { here = url; },
    blocked: { mutations: new Set(), external: new Set(), fetched: new Set() },
    timing: { lastRequestAt: 0, lastFetchAt: 0, forgetFetch() {} },
    async evaluate(expression) {
      if (expression.includes("collectUiState")) {
        return { url: new URL(here).pathname + new URL(here).hash, title: "Ledger", candidates: [], fingerprint: [], skeleton: [] };
      }
      if (expression.startsWith("location.href")) return here;
      if (expression.includes("document.querySelector(")) return true;
      // The settle poll: unchanging, so the wait ends on the first sample.
      return "same";
    },
    async navigate(url) { navigated.push(url); here = url; },
    async screenshot() { return null; },
    async clearStorage() { return null; },
    dispose() {}
  };
}

test("a route of an installed app resolves inside the app, and comes back named after it", async () => {
  const driver = fakeDriver({ at: `${app}index.html#/inbox` });
  const session = createBrowsingSession(app, driver);
  const snapshot = await session.goto("index.html#/inbox");
  assert.deepEqual(driver.navigated, [`${app}index.html#/inbox`]);
  // Not "/Applications/Ledger.app/Contents/Resources/app.asar/dist/index.html".
  assert.equal(snapshot.url, "index.html#/inbox");
});

test("the app's own root is the app, not the root of the file system", async () => {
  const driver = fakeDriver();
  const session = createBrowsingSession(app, driver);
  await session.goto();
  assert.deepEqual(driver.navigated, [app]);
});

test("a crawl of an installed app cannot walk out onto the machine", async () => {
  const driver = fakeDriver();
  const session = createBrowsingSession(app, driver);
  assert.equal(await session.goto("/etc/passwd"), null);
  assert.equal(await session.goto("file:///Users/me/Documents/taxes.html"), null);
  assert.deepEqual(driver.navigated, [], "nothing outside the app is ever loaded");
});

test("a click that leaves the app reports nothing rather than the page it landed on", async () => {
  const driver = fakeDriver();
  const session = createBrowsingSession(app, driver);
  driver.land("file:///Users/me/Documents/taxes.html");
  assert.equal(await session.click("a"), null);
});
