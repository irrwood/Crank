const assert = require("node:assert/strict");
const test = require("node:test");
const { collectSwiftGlassButtons, resolveCapturedSwiftGlassButtons } = require("./swift-glass-buttons.cjs");

const screen = {
  type: "vstack",
  children: [
    { type: "button", syncId: "swift/aaaa", text: "Get Started", material: "glassProminent", controlSize: "large" },
    { type: "button", syncId: "swift/bbbb", text: "Later", material: "glass" },
    { type: "button", syncId: "swift/cccc", text: "Save", material: "regular" },
    { type: "button", syncId: "swift/dddd", material: "glass", children: [{ type: "symbol", symbol: "plus" }] },
    {
      type: "vstack",
      children: [{ type: "button", syncId: "swift/eeee", material: "glass", children: [{ type: "text", text: "Nested" }] }]
    }
  ]
};

const snapshot = {
  environment: { viewport: { x: 0, y: 0, width: 402, height: 874 } },
  nodes: [
    { syncId: "swift/aaaa", pageSourceName: "HomeView", frame: { x: 20, y: 700, width: 362, height: 50 } },
    { syncId: "swift/bbbb", pageSourceName: "HomeView", frame: { x: 20, y: 760, width: 362, height: 44 } },
    { syncId: "swift/eeee", pageSourceName: "OtherView", frame: { x: 0, y: 0, width: 100, height: 40 } }
  ]
};

test("reads the glass buttons a screen declares, and leaves the rest alone", () => {
  const buttons = collectSwiftGlassButtons(screen);
  assert.deepEqual(buttons.map((button) => button.syncId), ["swift/aaaa", "swift/bbbb", "swift/eeee"]);
  assert.deepEqual(buttons[0], {
    syncId: "swift/aaaa",
    label: "Get Started",
    material: "glassProminent",
    controlSize: "large"
  });
  assert.equal(buttons[2].label, "Nested", "a label one level down is still the button's words");
});

test("leaves an icon-only button as the vector it was exported as", () => {
  assert.equal(collectSwiftGlassButtons(screen).some((button) => button.syncId === "swift/dddd"), false);
});

test("places each button where the run drew it, in the page's own coordinates", () => {
  const placed = resolveCapturedSwiftGlassButtons(screen, snapshot, "HomeView", {
    x: 0, y: 0, width: 402, height: 874, outputWidth: 804, outputHeight: 1748
  });
  assert.deepEqual(placed.map((button) => button.syncId), ["swift/aaaa", "swift/bbbb"]);
  assert.deepEqual(placed[0].frame, { x: 40, y: 1400, width: 724, height: 100 });
});

test("drops a button the run never reached rather than guessing where it is", () => {
  const placed = resolveCapturedSwiftGlassButtons(screen, { nodes: [] }, "HomeView");
  assert.deepEqual(placed, []);
});

test("keeps to the page it was asked about", () => {
  const placed = resolveCapturedSwiftGlassButtons(screen, snapshot, "OtherView");
  assert.deepEqual(placed.map((button) => button.syncId), ["swift/eeee"]);
});
