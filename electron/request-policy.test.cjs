const test = require("node:test");
const assert = require("node:assert/strict");
const { requestVerdict } = require("./request-policy.cjs");

const host = "127.0.0.1:5173";

test("lets the app read itself", () => {
  const verdict = requestVerdict("http://127.0.0.1:5173/about", "GET", "document", host);
  assert.equal(verdict.allow, true);
  assert.equal(verdict.isFetch, false);
});

test("cancels anything that would write to someone's project", () => {
  const verdict = requestVerdict("http://127.0.0.1:5173/api/notes", "POST", "xhr", host);
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, "mutation");
  assert.equal(verdict.label, "POST /api/notes");
});

test("framework tooling still writes, because blocking it breaks the app", () => {
  // Blocking vinext's stack-trace endpoint put its overlay into a retry loop
  // that issued ~11k requests in three seconds.
  assert.equal(requestVerdict("http://127.0.0.1:5173/__vinext_original-stack-trace", "POST", "xhr", host).allow, true);
});

test("keeps someone else's code and data off the crawl", () => {
  const verdict = requestVerdict("https://analytics.example.com/collect", "GET", "script", host);
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, "external");
  assert.equal(verdict.host, "analytics.example.com");
  assert.equal(requestVerdict("https://api.example.com/rows", "GET", "xhr", host).allow, false);
});

test("but fetches what the page merely draws, as a browser would", () => {
  // Blocking these protected nothing and ruined the capture: the same page
  // renders correctly if you just open it in a browser, and a scan that
  // photographs and measures it without its typeface or its photographs is
  // worse than the baseline it is meant to improve on.
  const sheet = requestVerdict("https://fonts.googleapis.com/css2?family=Montserrat", "GET", "stylesheet", host);
  assert.equal(sheet.allow, true);
  assert.equal(sheet.fetchedFrom, "fonts.googleapis.com", "and it is named, never silent");

  assert.equal(requestVerdict("https://fonts.gstatic.com/s/x.woff2", "GET", "Font", host).allow, true,
    "the debugging protocol spells the type with a capital");
  assert.equal(requestVerdict("https://images.cdn.example/hero.jpg", "GET", "image", host).allow, true);
  assert.equal(requestVerdict("https://videos.cdn.example/clip.mp4", "GET", "media", host).allow, true);
});

test("a write dressed as a stylesheet is still a write", () => {
  assert.equal(requestVerdict("https://fonts.googleapis.com/x", "POST", "stylesheet", host).allow, false);
});

test("the whole loopback interface is local, because HMR moves ports", () => {
  assert.equal(requestVerdict("ws://127.0.0.1:24678/", "GET", "websocket", host).allow, true);
  assert.equal(requestVerdict("http://localhost:9999/x", "GET", "script", host).allow, true);
});

test("tells data-shaped traffic apart, because a page keeps working after it lands", () => {
  assert.equal(requestVerdict("http://127.0.0.1:5173/api/rows", "GET", "xhr", host).isFetch, true);
  // The debugging protocol spells the same resource types differently.
  assert.equal(requestVerdict("http://127.0.0.1:5173/api/rows", "GET", "Fetch", host).isFetch, true);
  assert.equal(requestVerdict("http://127.0.0.1:5173/logo.png", "GET", "image", host).isFetch, false);
});

test("inline data is not a request to judge", () => {
  assert.equal(requestVerdict("data:image/png;base64,AAA", "GET", "image", host).allow, true);
  assert.equal(requestVerdict("nonsense", "GET", "other", host).allow, false);
});
