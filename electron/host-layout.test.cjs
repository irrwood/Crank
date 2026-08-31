const assert = require("node:assert/strict");
const test = require("node:test");

test("a repeated display mode still announces the host's completed layout", async () => {
  const { advanceHostLayout } = await import("../shared/host-layout.js");
  assert.deepEqual(
    advanceHostLayout({ mode: "fullscreen", revision: 3 }, "fullscreen"),
    { mode: "fullscreen", revision: 4 }
  );
});

test("a host context without a display mode keeps the mode and invalidates layout", async () => {
  const { advanceHostLayout } = await import("../shared/host-layout.js");
  assert.deepEqual(
    advanceHostLayout({ mode: "fullscreen", revision: 8 }),
    { mode: "fullscreen", revision: 9 }
  );
});
