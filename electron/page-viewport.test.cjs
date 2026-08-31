const assert = require("node:assert/strict");
const test = require("node:test");

test("a captured page can render before its host reports a usable viewport", async () => {
  const { fitPageToViewport } = await import("../shared/page-viewport.js");

  assert.equal(fitPageToViewport({
    pageWidth: 1440,
    pageHeight: 900,
    viewportWidth: 0,
    viewportHeight: 0
  }), null);
  assert.equal(fitPageToViewport({
    pageWidth: 1440,
    pageHeight: 900,
    viewportWidth: 1200,
    viewportHeight: 800
  }), 1144 / 1440);
});

test("viewport fitting samples delayed fullscreen bounds without an animation-frame loop", async () => {
  const { measureAtViewportSettlingPoints } = await import("../shared/page-viewport.js");
  const scheduled = [];
  const measuredWidths = [];
  let width = 560;

  const stop = measureAtViewportSettlingPoints(
    () => measuredWidths.push(width),
    (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; },
    () => {}
  );
  for (const task of scheduled) {
    if (task.delay >= 600) width = 1200;
    task.callback();
  }
  stop();

  assert.deepEqual(scheduled.map((task) => task.delay), [80, 240, 600, 1200]);
  assert.deepEqual(measuredWidths, [560, 560, 1200, 1200]);
});
