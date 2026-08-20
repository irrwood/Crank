const assert = require("node:assert/strict");
const test = require("node:test");
const { alignSourceScreenToPage, selectSwiftPdfPages, swiftPageSvgDirectory } = require("./swift-figma-page.cjs");

function metadata(pages) {
  return {
    swiftRuntimePdf: {
      path: "/tmp/ui-sync/vectors/project.pdf",
      capturedAt: "2026-08-20T10:00:00.000Z",
      viewport: { x: 0, y: 0, width: 393, height: 852 },
      pages
    }
  };
}

const pages = [
  { id: "pdf-page-1", name: "Home", pageNumber: 1, width: 393, height: 852, renderSource: "image-renderer" },
  { id: "pdf-page-2", name: "Profile", pageNumber: 2, width: 393, height: 852, renderSource: "window-fallback" }
];

test("sends every exported page when no single page is named", () => {
  assert.deepEqual(selectSwiftPdfPages(metadata(pages)).map((page) => page.id), ["pdf-page-1", "pdf-page-2"]);
});

test("sends one exported page by its identifier", () => {
  assert.deepEqual(selectSwiftPdfPages(metadata(pages), "pdf-page-2").map((page) => page.name), ["Profile"]);
});

test("reports the state of the export instead of guessing a page", () => {
  assert.throws(
    () => selectSwiftPdfPages({ swiftRuntimeVectorMessage: "The app ran, but no iOS window produced a PDF capture." }),
    /no iOS window produced a PDF capture/
  );
  assert.throws(() => selectSwiftPdfPages(metadata(pages), "pdf-page-9"), /no longer in the export/);
  assert.throws(() => selectSwiftPdfPages(metadata(pages), "HomeView"), /invalid/i);
});

test("refuses a whole-project sync larger than one Figma job", () => {
  const many = Array.from({ length: 121 }, (_item, index) => ({
    id: `pdf-page-${index + 1}`,
    name: `Page ${index + 1}`,
    pageNumber: index + 1,
    width: 393,
    height: 852
  }));
  assert.throws(() => selectSwiftPdfPages(metadata(many)), /page by page/);
  assert.deepEqual(selectSwiftPdfPages(metadata(many), "pdf-page-121").map((page) => page.name), ["Page 121"]);
});

test("keeps one SVG directory per project", () => {
  const first = swiftPageSvgDirectory("/Users/example/AppOne", metadata(pages));
  const second = swiftPageSvgDirectory("/Users/example/AppTwo", metadata(pages));
  assert.notEqual(first, second);
  assert.equal(swiftPageSvgDirectory("/Users/example/AppOne", metadata(pages)), first);
  assert.match(first, /vectors\/figma-pages\/[a-f0-9]{16}$/);
});

test("re-anchors a source tree only for a partially rendered page", () => {
  const sourceScreen = {
    id: "HomeView",
    name: "Home",
    runtimeCapture: { state: "captured", capturedNodeCount: 2, totalNodeCount: 2, capturedAt: "2026-08-20T10:00:00.000Z", isVisualReference: true },
    uiTree: { type: "vstack", runtimeFrame: { x: 0, y: 59, width: 393, height: 700 }, children: [] }
  };
  const windowPage = { ...pages[1], contentFrame: { x: 0, y: 59, width: 393, height: 700 } };
  assert.equal(alignSourceScreenToPage(sourceScreen, windowPage), sourceScreen);
  assert.equal(alignSourceScreenToPage(sourceScreen, pages[0]), sourceScreen);

  const rendererPage = { ...pages[0], contentFrame: { x: 0, y: 59, width: 393, height: 700 } };
  const aligned = alignSourceScreenToPage(sourceScreen, rendererPage);
  assert.equal(aligned.runtimeCapture.isVisualReference, false);
  assert.deepEqual(aligned.uiTree.runtimeFrame, { x: 0, y: 0, width: 393, height: 700 });
});
