const assert = require("node:assert/strict");
const test = require("node:test");
const { normalizeExtractedText, parsePdfTextXml, reconcileWithSource } = require("./swift-pdf-text.cjs");

test("normalizes Core Graphics compatibility glyphs and CJK spacing", () => {
  assert.equal(normalizeExtractedText("坏 猫 任 务"), "坏猫任务");
  assert.equal(normalizeExtractedText("脑⼦⾥在想什么？"), "脑子里在想什么?");
  assert.equal(normalizeExtractedText("坏 猫 引 擎 % 本 地"), "坏猫引擎 · 本地");
});

test("reconciles questionable PDF punctuation with an exact SwiftUI source string", () => {
  assert.equal(
    reconcileWithSource("⻓按按钮7 让坏猫把脑中的事⼀⼝⽓叼⾛｡", ["长按按钮，让坏猫把脑中的事一口气叼走。"]),
    "长按按钮，让坏猫把脑中的事一口气叼走。"
  );
});

test("extracts complete scaled editable text runs from Poppler XML", () => {
  const xml = `<?xml version="1.0"?><pdf2xml><page number="1" height="1311" width="603">
    <fontspec id="0" size="51" family="AAAAAC+.PingFangUIDisplaySC" color="#172130"/>
    <text top="183" left="108" width="386" height="51" font="0"><b>脑⼦⾥在想什么？</b></text>
  </page></pdf2xml>`;
  const result = parsePdfTextXml(xml, {
    width: 402,
    height: 874,
    sourceTexts: ["脑子里在想什么？"]
  });
  assert.equal(result.complete, true);
  assert.equal(result.runs.length, 1);
  assert.equal(result.runs[0].text, "脑子里在想什么？");
  assert.deepEqual(
    { x: result.runs[0].x, y: result.runs[0].y, width: result.runs[0].width, height: result.runs[0].height, fontSize: result.runs[0].fontSize },
    { x: 72, y: 122, width: 257.3333333333333, height: 34, fontSize: 34 }
  );
  assert.equal(result.runs[0].fontWeight, "bold");
  assert.deepEqual(result.runs[0].color, { r: 23 / 255, g: 33 / 255, b: 48 / 255 });
});
