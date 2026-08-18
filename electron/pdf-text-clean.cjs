const { execFile } = require("node:child_process");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { PNG } = require("pngjs");

const execFileAsync = promisify(execFile);

function compareTextCleanPng(normal, clean, frames, viewport) {
  if (!normal || !clean || normal.width !== clean.width || normal.height !== clean.height) return { safe: false, reason: "page-size-changed" };
  if (!viewport?.width || !viewport?.height || !Array.isArray(frames) || frames.length === 0) return { safe: false, reason: "no-captured-text-frames" };
  const scaleX = normal.width / viewport.width;
  const scaleY = normal.height / viewport.height;
  const regions = frames
    .filter((frame) => frame?.width > 0 && frame?.height > 0)
    .map((frame) => ({
      left: Math.floor((frame.x - viewport.x) * scaleX) - 6,
      top: Math.floor((frame.y - viewport.y) * scaleY) - 6,
      right: Math.ceil((frame.x + frame.width - viewport.x) * scaleX) + 6,
      bottom: Math.ceil((frame.y + frame.height - viewport.y) * scaleY) + 6
    }));
  if (regions.length === 0) return { safe: false, reason: "no-captured-text-frames" };
  let insideChanged = 0;
  let outsideChanged = 0;
  for (let y = 0; y < normal.height; y += 1) {
    for (let x = 0; x < normal.width; x += 1) {
      const offset = (y * normal.width + x) * 4;
      let delta = 0;
      for (let channel = 0; channel < 4; channel += 1) {
        delta = Math.max(delta, Math.abs(normal.data[offset + channel] - clean.data[offset + channel]));
      }
      if (delta <= 16) continue;
      const inside = regions.some((region) => x >= region.left && x <= region.right && y >= region.top && y <= region.bottom);
      if (inside) insideChanged += 1;
      else outsideChanged += 1;
    }
  }
  const outsideLimit = Math.max(200, Math.round(normal.width * normal.height * 0.001));
  return {
    safe: insideChanged > 4 && outsideChanged <= outsideLimit,
    reason: outsideChanged > outsideLimit ? "visual-baseline-changed" : insideChanged <= 4 ? "captured-text-was-not-removed" : null,
    insideChanged,
    outsideChanged,
    outsideLimit
  };
}

async function renderPdfPage(pdfPath, pageNumber, outputPrefix) {
  await execFileAsync("pdftoppm", [
    "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-png", "-r", "72", pdfPath, outputPrefix
  ], { timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
  return PNG.sync.read(await readFile(`${outputPrefix}.png`));
}

async function isTextCleanPdfSafe({ normalPdfPath, normalPageNumber = 1, cleanPdfPath, frames, viewport }) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ui-sync-text-clean-"));
  try {
    const [normal, clean] = await Promise.all([
      renderPdfPage(normalPdfPath, normalPageNumber, path.join(directory, "normal")),
      renderPdfPage(cleanPdfPath, 1, path.join(directory, "clean"))
    ]);
    return compareTextCleanPng(normal, clean, frames, viewport);
  } catch (error) {
    return { safe: false, reason: error instanceof Error ? error.message : "text-clean-validation-failed" };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

module.exports = { compareTextCleanPng, isTextCleanPdfSafe };
