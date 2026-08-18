const { access } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const { z } = require("zod");

const PDFTOHTML_CANDIDATES = [
  "/opt/homebrew/bin/pdftohtml",
  "/usr/local/bin/pdftohtml",
  "/usr/bin/pdftohtml"
];

const pdfTextRunSchema = z.object({
  text: z.string().min(1).max(4000),
  x: z.number().finite().min(-10000).max(10000),
  y: z.number().finite().min(-10000).max(10000),
  width: z.number().finite().positive().max(10000),
  height: z.number().finite().positive().max(10000),
  fontSize: z.number().finite().positive().max(400),
  fontWeight: z.enum(["regular", "medium", "semibold", "bold", "heavy", "black"]),
  color: z.object({
    r: z.number().finite().min(0).max(1),
    g: z.number().finite().min(0).max(1),
    b: z.number().finite().min(0).max(1)
  }).strict()
}).strict();

async function findPdfToHtml() {
  for (const candidate of PDFTOHTML_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Editable PDF text needs Poppler. Install it with `brew install poppler`, then export the page again.");
}

function runOutput(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(stderr.trim() || `${command} exited with status ${code}`)));
  });
}

function decodeXmlText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_match, value_) => String.fromCodePoint(Number.parseInt(value_, 16)))
    .replace(/&#(\d+);/g, (_match, value_) => String.fromCodePoint(Number(value_)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeExtractedText(value) {
  let text = decodeXmlText(value).normalize("NFKC").trim()
    .replaceAll("⻓", "长")
    .replaceAll("⼦", "子")
    .replaceAll("⾥", "里")
    .replaceAll("⾳", "音")
    .replaceAll("⼀", "一")
    .replaceAll("⼝", "口")
    .replaceAll("⽓", "气")
    .replaceAll("⾛", "走");
  let previous;
  do {
    previous = text;
    text = text
      .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
      .replace(/(\p{Script=Han})\s+([，。！？：；、])/gu, "$1$2")
      .replace(/([（【《])\s+(?=\p{Script=Han})/gu, "$1");
  } while (text !== previous);
  return text
    .replace(/\s+%\s+/g, " · ")
    .replace(/｡/g, "。");
}

function comparisonKey(value, { ignoreSuspiciousDigits = false } = {}) {
  let text = normalizeExtractedText(value);
  if (ignoreSuspiciousDigits) {
    text = text.replace(/(?<=\p{Script=Han})\d(?=\s*\p{Script=Han})/gu, "");
  }
  return text.replace(/[\p{P}\p{S}\s]/gu, "").toLocaleLowerCase();
}

function reconcileWithSource(extracted, sourceTexts = []) {
  const candidates = [...new Set(sourceTexts.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
  const keys = [comparisonKey(extracted), comparisonKey(extracted, { ignoreSuspiciousDigits: true })].filter(Boolean);
  for (const key of keys) {
    const matches = candidates.filter((candidate) => comparisonKey(candidate) === key);
    if (matches.length === 1) return matches[0];
  }
  return normalizeExtractedText(extracted);
}

function colorFromHex(value) {
  const match = String(value || "").match(/^#([0-9a-f]{6})$/i);
  if (!match) return { r: 0, g: 0, b: 0 };
  const integer = Number.parseInt(match[1], 16);
  return {
    r: ((integer >> 16) & 0xff) / 255,
    g: ((integer >> 8) & 0xff) / 255,
    b: (integer & 0xff) / 255
  };
}

function weightForFont(font, markup) {
  if (/<b\b/i.test(markup) || /(?:Bold|Semibold|Demi)/i.test(font.family)) return "bold";
  if (/Medium/i.test(font.family)) return "medium";
  return "regular";
}

function parsePdfTextXml(source, options) {
  const xml = String(source || "");
  const page = xml.match(/<page\b([^>]*)>([\s\S]*?)<\/page>/i);
  if (!page) return { complete: false, runs: [] };
  const attribute = (attributes, name) => Number(attributes.match(new RegExp(`\\b${name}="(-?\\d+(?:\\.\\d+)?)"`, "i"))?.[1]);
  const xmlWidth = attribute(page[1], "width");
  const xmlHeight = attribute(page[1], "height");
  if (!(xmlWidth > 0) || !(xmlHeight > 0)) return { complete: false, runs: [] };
  const scaleX = options.width / xmlWidth;
  const scaleY = options.height / xmlHeight;
  const fonts = new Map();
  for (const match of page[2].matchAll(/<fontspec\b([^>]*)\/>/gi)) {
    const id = match[1].match(/\bid="([^"]+)"/i)?.[1];
    const size = attribute(match[1], "size");
    const family = match[1].match(/\bfamily="([^"]*)"/i)?.[1] || "";
    const color = match[1].match(/\bcolor="([^"]*)"/i)?.[1] || "#000000";
    if (id && size > 0) fonts.set(id, { size, family, color });
  }
  const textElements = [...page[2].matchAll(/<text\b([^>]*)>([\s\S]*?)<\/text>/gi)];
  const runs = [];
  for (const match of textElements) {
    const fontId = match[1].match(/\bfont="([^"]+)"/i)?.[1];
    const font = fonts.get(fontId);
    const left = attribute(match[1], "left");
    const top = attribute(match[1], "top");
    const width = attribute(match[1], "width");
    const height = attribute(match[1], "height");
    const text = reconcileWithSource(match[2], options.sourceTexts);
    if (!font || !text || !Number.isFinite(left) || !Number.isFinite(top) || !(width > 0) || !(height > 0)) continue;
    runs.push(pdfTextRunSchema.parse({
      text,
      x: left * scaleX,
      y: top * scaleY,
      width: width * scaleX,
      height: height * scaleY,
      fontSize: font.size * Math.min(scaleX, scaleY),
      fontWeight: weightForFont(font, match[2]),
      color: colorFromHex(font.color)
    }));
  }
  return { complete: textElements.length > 0 && runs.length === textElements.length, runs };
}

async function extractPdfTextRuns(pdfPath, options) {
  const command = options.command || await findPdfToHtml();
  const pageNumber = options.pageNumber || 1;
  const xml = await runOutput(command, [
    "-xml", "-hidden", "-nodrm", "-i", "-stdout",
    "-f", String(pageNumber), "-l", String(pageNumber), pdfPath
  ]);
  return parsePdfTextXml(xml, options);
}

module.exports = {
  comparisonKey,
  extractPdfTextRuns,
  findPdfToHtml,
  normalizeExtractedText,
  parsePdfTextXml,
  pdfTextRunSchema,
  reconcileWithSource
};
