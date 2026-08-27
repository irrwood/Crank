const test = require("node:test");
const assert = require("node:assert/strict");
const { findReplayElement, isStableDomId, semanticLocator } = require("./replay-locator.cjs");

test("runtime-generated React and Base UI ids are not replay anchors", () => {
  for (const id of ["_r_7_", "_r_c_", "base-ui-_r_11_", "base-ui-_r_4r_", "radix-:r1:"]) {
    assert.equal(isStableDomId(id), false, id);
  }
  assert.equal(isStableDomId("chat-actions"), true);
  assert.equal(isStableDomId("settings-panel"), true);
});

test("a semantic locator survives a changed runtime id", () => {
  const control = {
    tagName: "BUTTON",
    innerText: "Chat actions",
    textContent: "Chat actions",
    getAttribute(name) { return name === "id" ? "_r_new_" : null; },
    hasAttribute() { return false; },
    getBoundingClientRect() { return { width: 120, height: 28 }; }
  };
  const previousDocument = global.document;
  const previousWindow = global.window;
  global.document = {
    querySelectorAll() { return [control]; }
  };
  global.window = { getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; } };
  try {
    const locator = semanticLocator("button", "button", "Chat actions");
    assert.equal(findReplayElement(locator), control);
  } finally {
    global.document = previousDocument;
    global.window = previousWindow;
  }
});
