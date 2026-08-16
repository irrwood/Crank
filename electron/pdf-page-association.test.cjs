const assert = require("node:assert/strict");
const test = require("node:test");
const { associatePdfPagesWithScreens } = require("./pdf-page-association.cjs");

test("associates PDF pages with full-screen runtime views in appearance order", () => {
  const pages = [1, 2, 3].map((pageNumber) => ({ id: `pdf-page-${pageNumber}`, pageNumber, name: `Tab ${pageNumber}` }));
  const screens = [
    { id: "root", name: "Root", sourceType: "screen", patterns: ["Tab navigation"], uiTree: { syncId: "swift/root" } },
    { id: "third", name: "Third", sourceType: "screen", patterns: [], uiTree: { syncId: "swift/third" } },
    { id: "tiny", name: "Tiny", sourceType: "screen", patterns: [], uiTree: { syncId: "swift/tiny" } },
    { id: "first", name: "First", sourceType: "screen", patterns: [], uiTree: { syncId: "swift/first" } },
    { id: "second", name: "Second", sourceType: "screen", patterns: [], uiTree: { syncId: "swift/second" } }
  ];
  const snapshot = {
    capturedAt: "2026-08-13T12:00:05.000Z",
    environment: { viewport: { x: 0, y: 0, width: 400, height: 800 } },
    nodes: [
      { syncId: "swift/root", frame: { x: 0, y: 0, width: 400, height: 800 }, capturedAt: "2026-08-13T12:00:00.000Z" },
      { syncId: "swift/tiny", frame: { x: 0, y: 0, width: 80, height: 80 }, capturedAt: "2026-08-13T12:00:01.000Z" },
      { syncId: "swift/second", frame: { x: 0, y: 0, width: 400, height: 760 }, capturedAt: "2026-08-13T12:00:03.000Z" },
      { syncId: "swift/first", frame: { x: 0, y: 0, width: 400, height: 760 }, capturedAt: "2026-08-13T12:00:02.000Z" },
      { syncId: "swift/third", frame: { x: 0, y: 0, width: 400, height: 760 }, capturedAt: "2026-08-13T12:00:04.000Z" }
    ]
  };
  const associated = associatePdfPagesWithScreens(pages, screens, snapshot);
  assert.deepEqual(associated.map((page) => page.sourceScreenId), ["first", "second", "third"]);
  assert.deepEqual(associated.map((page) => page.sourceScreenName), ["First", "Second", "Third"]);
});

test("uses ImageRenderer source identity before capture timing", () => {
  const pages = [{ id: "pdf-page-1", pageNumber: 1, name: "First", sourceName: "SecondView" }];
  const screens = [
    { id: "first", name: "First", sourceType: "screen", patterns: [], uiTree: { syncId: "swift/first", sourceName: "FirstView" } },
    { id: "second", name: "Second", sourceType: "screen", patterns: [], uiTree: { syncId: "swift/second", sourceName: "SecondView" } }
  ];
  const snapshot = {
    capturedAt: "2026-08-13T12:00:05.000Z",
    environment: { viewport: { x: 0, y: 0, width: 400, height: 800 } },
    nodes: [
      { syncId: "swift/first", frame: { x: 0, y: 0, width: 400, height: 800 }, capturedAt: "2026-08-13T12:00:01.000Z" },
      { syncId: "swift/second", frame: { x: 0, y: 0, width: 400, height: 800 }, capturedAt: "2026-08-13T12:00:02.000Z" }
    ]
  };
  assert.equal(associatePdfPagesWithScreens(pages, screens, snapshot)[0].sourceScreenId, "second");
});
