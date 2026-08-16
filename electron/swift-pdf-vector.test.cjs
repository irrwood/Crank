const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mkdtemp, readFile, writeFile } = require("node:fs/promises");
const { PNG } = require("pngjs");
const { convertPdfToFigmaSvg, isSwiftUiUnsupportedRendererSvg, parsePdfInfo, prepareFigmaVectorSvg } = require("./swift-pdf-vector.cjs");

function pngDataUrl(width, height, pixels) {
  const png = new PNG({ width, height });
  png.data.set(pixels);
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

test("indexes a multi-page PDF from pdfinfo metadata", () => {
  assert.deepEqual(parsePdfInfo("Pages:           4\nPage size:       393 x 852 pts\n"), { pages: 4, width: 393, height: 852 });
});

test("recognizes SwiftUI ImageRenderer's unsupported-content marker", () => {
  const marker = `<svg><rect fill="rgb(100%, 80.000305%, 0%)"/><path stroke-width="42" stroke-linecap="butt" stroke="rgb(100%, 21.960449%, 23.529053%)"/></svg>`;
  assert.equal(isSwiftUiUnsupportedRendererSvg(marker), true);
  assert.equal(isSwiftUiUnsupportedRendererSvg(`<svg><rect fill="#ffcc00"/></svg>`), false);
});

test("removes PDF text glyph uses while preserving vector artwork", () => {
  const svg = `<?xml version="1.0"?><svg width="393pt" height="852pt" viewBox="0 0 393 852">
    <defs><path id="glyph-0-1" d="M0 0h8v8z"/><path id="icon-star" d="M0 0l5 10z"/></defs>
    <metadata>generated</metadata>
    <path d="M0 0h393v852H0z" fill="#fff"/>
    <use xlink:href="#glyph-0-1" x="20" y="40"/>
    <use href="#icon-star" x="20" y="80"/>
  </svg>`;
  const result = prepareFigmaVectorSvg(svg);
  assert.match(result, /width="393" height="852"/);
  assert.doesNotMatch(result, /<metadata|<use xlink:href="#glyph-/);
  assert.match(result, /<use href="#icon-star"/);
  assert.match(result, /<path d="M0 0h393v852H0z"/);
});

test("keeps PDF text outlines when no source-linked text is available", () => {
  const svg = '<svg width="100pt" height="100pt"><defs><path id="glyph-0-1" d="M0 0h8v8z"/></defs><use href="#glyph-0-1"/></svg>';
  assert.match(prepareFigmaVectorSvg(svg, { stripTextGlyphs: false }), /href="#glyph-0-1"/);
});

test("combines Poppler image masks into one transparent PNG for Figma", () => {
  const mask = pngDataUrl(2, 1, [255, 255, 255, 255, 0, 0, 0, 255]);
  const color = pngDataUrl(2, 1, [240, 120, 60, 255, 20, 40, 60, 255]);
  const svg = `<svg width="2" height="1"><defs>
    <filter id="filter-remove-color"><feColorMatrix/></filter>
    <filter id="filter-color-to-alpha"><feColorMatrix/></filter>
    <image id="alpha" width="2" height="1" xlink:href="${mask}"/>
    <mask id="image-mask"><g filter="url(#filter-remove-color)"><use xlink:href="#alpha" filter="url(#filter-color-to-alpha)" transform="matrix(1, 0, 0, 1, 0, 0)"/></g></mask>
    <image id="art" width="2" height="1" xlink:href="${color}"/>
  </defs><g mask="url(#image-mask)"><use xlink:href="#art" transform="matrix(1, 0, 0, 1, 0, 0)"/></g></svg>`;
  const result = prepareFigmaVectorSvg(svg, { stripTextGlyphs: false });
  assert.doesNotMatch(result, /id="alpha"|<mask\b|mask="url\(/);
  assert.match(result, /<use xlink:href="#art"/);
  const combinedData = result.match(/<image id="art"[^>]*base64,([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(combinedData);
  const combined = PNG.sync.read(Buffer.from(combinedData, "base64"));
  assert.deepEqual([...combined.data], [240, 120, 60, 255, 20, 40, 60, 0]);
});

test("prefers a matching project source image over PDF mask reconstruction", () => {
  const mask = pngDataUrl(2, 1, [255, 255, 255, 255, 255, 255, 255, 255]);
  const color = pngDataUrl(2, 1, [20, 30, 40, 255, 50, 60, 70, 255]);
  const original = new PNG({ width: 4, height: 2 });
  original.data.fill(255);
  const originalBuffer = PNG.sync.write(original);
  const svg = `<svg width="20" height="20"><defs>
    <image id="alpha" width="20" height="10" xlink:href="${mask}"/>
    <mask id="image-mask"><g filter="url(#filter-remove-color)"><use xlink:href="#alpha" filter="url(#filter-color-to-alpha)" transform="matrix(1, 0, 0, 1, 0, 5)"/></g></mask>
    <image id="art" width="20" height="10" xlink:href="${color}"/>
  </defs><g mask="url(#image-mask)"><use xlink:href="#art" transform="matrix(1, 0, 0, 1, 0, 5)"/></g></svg>`;
  const result = prepareFigmaVectorSvg(svg, {
    stripTextGlyphs: false,
    sourceImages: [{ frame: { x: 0, y: 0, width: 20, height: 20 }, width: 4, height: 2, buffer: originalBuffer }]
  });
  assert.doesNotMatch(result, /<mask\b|mask="url\(/);
  const embedded = result.match(/<image id="art"[^>]*base64,([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(embedded);
  const decoded = PNG.sync.read(Buffer.from(embedded, "base64"));
  assert.deepEqual({ width: decoded.width, height: decoded.height }, { width: 4, height: 2 });
});

test("restores a unique original Asset Catalog PNG by its exact non-opaque alpha channel", () => {
  const mask = pngDataUrl(2, 1, [255, 255, 255, 255, 0, 0, 0, 255]);
  const color = pngDataUrl(2, 1, [40, 50, 60, 255, 70, 80, 90, 255]);
  const original = new PNG({ width: 2, height: 1 });
  original.data.set([200, 10, 20, 255, 20, 210, 30, 0]);
  const originalBuffer = PNG.sync.write(original);
  const svg = `<svg width="2" height="1"><defs>
    <image id="alpha" width="2" height="1" xlink:href="${mask}"/>
    <mask id="image-mask"><use xlink:href="#alpha" filter="url(#filter-color-to-alpha)" transform="matrix(1,0,0,1,0,0)"/></mask>
    <image id="art" width="2" height="1" xlink:href="${color}"/>
  </defs><g mask="url(#image-mask)"><use xlink:href="#art" transform="matrix(1,0,0,1,0,0)"/></g></svg>`;
  const result = prepareFigmaVectorSvg(svg, {
    stripTextGlyphs: false,
    sourceImages: [{ assetName: "art/original", width: 2, height: 1, buffer: originalBuffer, originalAsset: true }]
  });
  const embedded = result.match(/<image id="art"[^>]*base64,([A-Za-z0-9+/=]+)/)?.[1];
  assert.ok(embedded);
  assert.deepEqual([...PNG.sync.read(Buffer.from(embedded, "base64")).data], [...original.data]);
});

test("passes project source images through the PDF conversion entry point", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ui-sync-source-image-conversion-"));
  const svgPath = path.join(directory, "page.svg");
  const sourceImage = PNG.sync.write({
    width: 1,
    height: 1,
    data: Buffer.from([40, 80, 120, 128])
  });
  const color = PNG.sync.write({
    width: 1,
    height: 1,
    data: Buffer.from([255, 0, 0, 255])
  });
  const mask = PNG.sync.write({
    width: 1,
    height: 1,
    data: Buffer.from([255, 255, 255, 255])
  });
  const rawSvg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><defs><filter id="filter-color-to-alpha"/><image id="mask" width="10" height="10" href="data:image/png;base64,${mask.toString("base64")}"/><image id="color" width="10" height="10" href="data:image/png;base64,${color.toString("base64")}"/><mask id="alpha"><use href="#mask" filter="url(#filter-color-to-alpha)" transform="matrix(1,0,0,1,20,30)"/></mask></defs><g mask="url(#alpha)"><use href="#color" transform="matrix(1,0,0,1,20,30)"/></g></svg>`;
  const command = path.join(directory, "fake-pdftocairo.sh");
  await writeFile(command, `#!/bin/sh\nprintf '%s' '${rawSvg}' > \"$7\"\n`, { mode: 0o755 });
  await convertPdfToFigmaSvg("unused.pdf", svgPath, {
    command,
    sourceImages: [{ frame: { x: 20, y: 30, width: 10, height: 10 }, width: 1, height: 1, buffer: sourceImage }]
  });
  const output = await readFile(svgPath, "utf8");
  assert.doesNotMatch(output, /<mask\b/);
  assert.match(output, new RegExp(sourceImage.toString("base64")));
});

test("downsamples oversized PDF images to their rendered SVG size before syncing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ui-sync-pdf-image-scaling-"));
  const rawSvgPath = path.join(directory, "raw.svg");
  const svgPath = path.join(directory, "page.svg");
  const image = new PNG({ width: 120, height: 120 });
  for (let index = 0; index < image.data.length; index += 4) {
    image.data[index] = index % 251;
    image.data[index + 1] = index % 239;
    image.data[index + 2] = index % 227;
    image.data[index + 3] = 255;
  }
  const rawSvg = `<svg width="100" height="100" xmlns="http://www.w3.org/2000/svg"><defs><image id="large" width="120" height="120" href="data:image/png;base64,${PNG.sync.write(image).toString("base64")}"/></defs><use href="#large" transform="matrix(0.1,0,0,0.1,10,10)"/></svg>`;
  await writeFile(rawSvgPath, rawSvg);
  const command = path.join(directory, "fake-pdftocairo.sh");
  await writeFile(command, `#!/bin/sh\ncp '${rawSvgPath}' "$7"\n`, { mode: 0o755 });
  const resizeCalls = [];
  await convertPdfToFigmaSvg("unused.pdf", svgPath, {
    command,
    maximumByteLength: 1_500,
    imageResizer: async (_buffer, resize) => {
      resizeCalls.push(resize);
      const replacement = new PNG({ width: resize.width, height: resize.height });
      replacement.data.fill(127);
      return PNG.sync.write(replacement);
    }
  });
  assert.equal(resizeCalls.length, 1);
  assert.deepEqual(
    { width: resizeCalls[0].width, height: resizeCalls[0].height, density: resizeCalls[0].density },
    { width: 24, height: 24, density: 2 }
  );
  assert.ok(Buffer.byteLength(await readFile(svgPath, "utf8"), "utf8") <= 1_500);
});

test("rejects non-SVG converter output", () => {
  assert.throws(() => prepareFigmaVectorSvg("not svg"), /valid SVG/);
});

test("rejects an empty PDF page", () => {
  assert.throws(() => prepareFigmaVectorSvg('<svg width="393" height="852"></svg>'), /empty SVG/);
});
