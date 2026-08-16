const { access, mkdir, mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { PNG } = require("pngjs");

const PDFTOCAIRO_CANDIDATES = [
  "/opt/homebrew/bin/pdftocairo",
  "/usr/local/bin/pdftocairo",
  "/usr/bin/pdftocairo"
];

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

function runOutput(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "pipe", "pipe"], ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr.trim() || `${command} exited with status ${code}`)));
  });
}

async function findPdfToCairo() {
  for (const candidate of PDFTOCAIRO_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  throw new Error("Rendered vector export needs Poppler. Install it with `brew install poppler`, then run Design Build again.");
}

function svgAttributes(source) {
  return Object.fromEntries([...String(source || "").matchAll(/([\w:-]+)\s*=\s*(["'])([\s\S]*?)\2/g)]
    .map((match) => [match[1], match[3]]));
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function pngDataUrl(source) {
  const match = String(source || "").match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/i);
  return match ? Buffer.from(match[1], "base64") : null;
}

function combineRgbAndLuminanceMask(colorBuffer, maskBuffer) {
  const color = PNG.sync.read(colorBuffer);
  const mask = PNG.sync.read(maskBuffer);
  if (color.width !== mask.width || color.height !== mask.height) return null;
  let maximumLuminance = 0;
  for (let index = 0; index < mask.data.length; index += 4) {
    maximumLuminance = Math.max(maximumLuminance, 0.2126 * mask.data[index] + 0.7152 * mask.data[index + 1] + 0.0722 * mask.data[index + 2]);
  }
  // Some PDF soft masks use indexed decode ranges that pngjs cannot expand
  // by itself. Keep those SVG masks intact unless an original source image
  // is available, so a fallback never changes the rendered appearance.
  if (maximumLuminance < 32) return null;
  for (let index = 0; index < color.data.length; index += 4) {
    const luminance = 0.2126 * mask.data[index] + 0.7152 * mask.data[index + 1] + 0.0722 * mask.data[index + 2];
    color.data[index + 3] = Math.round(color.data[index + 3] * luminance * mask.data[index + 3] / 65_025);
  }
  return PNG.sync.write(color, { colorType: 6 });
}

function imageBounds(attributes) {
  const width = Number(attributes.width || 0);
  const height = Number(attributes.height || 0);
  const x = Number(attributes.x || 0);
  const y = Number(attributes.y || 0);
  const values = String(attributes.transform || "").match(/^matrix\(\s*([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)\s*\)$/i)?.slice(1).map(Number);
  if (!values || values.some((value) => !Number.isFinite(value))) return { x, y, width, height };
  const [a, b, c, d, e, f] = values;
  const points = [[x, y], [x + width, y], [x, y + height], [x + width, y + height]]
    .map(([pointX, pointY]) => ({ x: a * pointX + c * pointY + e, y: b * pointX + d * pointY + f }));
  const minimumX = Math.min(...points.map((point) => point.x));
  const minimumY = Math.min(...points.map((point) => point.y));
  const maximumX = Math.max(...points.map((point) => point.x));
  const maximumY = Math.max(...points.map((point) => point.y));
  return { x: minimumX, y: minimumY, width: maximumX - minimumX, height: maximumY - minimumY };
}

function matrixImageScale(transform) {
  const values = String(transform || "").match(/^matrix\(\s*([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)\s*\)$/i)?.slice(1).map(Number);
  if (!values || values.some((value) => !Number.isFinite(value))) return 1;
  const [a, b, c, d] = values;
  return Math.max(Math.hypot(a, b), Math.hypot(c, d));
}

function pngDimensions(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.toString("ascii", 1, 4) !== "PNG") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

async function resizePngWithSips(buffer, options) {
  const directory = options.directory || await mkdtemp(path.join(os.tmpdir(), "ui-sync-svg-image-"));
  const ownsDirectory = !options.directory;
  const inputPath = path.join(directory, `${options.index}-input.png`);
  const outputPath = path.join(directory, `${options.index}-output.png`);
  try {
    await writeFile(inputPath, buffer);
    await run("/usr/bin/sips", ["-z", String(options.height), String(options.width), inputPath, "--out", outputPath], { timeout: 60_000 });
    return await readFile(outputPath);
  } finally {
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
  }
}

async function downsampleEmbeddedPngs(source, options = {}) {
  const maximumByteLength = options.maximumByteLength ?? 2_500_000;
  let output = String(source || "");
  if (Buffer.byteLength(output, "utf8") <= maximumByteLength) return output;

  const densities = options.pixelDensities || [2, 1.5, 1];
  const temporaryDirectory = options.imageResizer ? null : await mkdtemp(path.join(os.tmpdir(), "ui-sync-svg-images-"));
  let resizeIndex = 0;
  try {
    for (const density of densities) {
      const images = [...output.matchAll(/<image\b[\s\S]*?\/\s*>/gi)];
      for (const imageMatch of images) {
        const attributes = svgAttributes(imageMatch[0]);
        const id = attributes.id;
        const href = attributes.href || attributes["xlink:href"];
        const buffer = pngDataUrl(href);
        const dimensions = pngDimensions(buffer);
        if (!id || !buffer || !dimensions) continue;

        const uses = [...output.matchAll(new RegExp(`<use\\b(?=[^>]*(?:xlink:href|href)\\s*=\\s*["']#${escapeRegExp(id)}["'])[^>]*>`, "gi"))];
        const maximumScale = uses.length > 0
          ? Math.max(...uses.map((use) => matrixImageScale(svgAttributes(use[0]).transform)))
          : matrixImageScale(attributes.transform);
        const svgWidth = Number(attributes.width || dimensions.width);
        const svgHeight = Number(attributes.height || dimensions.height);
        if (!(svgWidth > 0) || !(svgHeight > 0) || !(maximumScale > 0)) continue;

        const targetScale = Math.min(
          1,
          Math.max(svgWidth * maximumScale * density / dimensions.width, svgHeight * maximumScale * density / dimensions.height)
        );
        if (targetScale >= 0.9) continue;
        const width = Math.max(1, Math.ceil(dimensions.width * targetScale));
        const height = Math.max(1, Math.ceil(dimensions.height * targetScale));
        const resized = options.imageResizer
          ? await options.imageResizer(buffer, { id, width, height, density, index: resizeIndex++ })
          : await resizePngWithSips(buffer, { directory: temporaryDirectory, width, height, index: resizeIndex++ });
        const updatedHref = `data:image/png;base64,${resized.toString("base64")}`;
        const updatedImage = imageMatch[0].replace(
          /((?:xlink:)?href\s*=\s*)(["'])data:image\/png;base64,[A-Za-z0-9+/=]+\2/i,
          `$1$2${updatedHref}$2`
        );
        output = output.replace(imageMatch[0], updatedImage);
      }
      if (Buffer.byteLength(output, "utf8") <= maximumByteLength) break;
    }
    return output;
  } finally {
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function fittedImageBounds(plan) {
  const aspect = plan.width / plan.height;
  const width = Math.min(plan.frame.width, plan.frame.height * aspect);
  const height = width / aspect;
  return {
    x: plan.frame.x + (plan.frame.width - width) / 2,
    y: plan.frame.y + (plan.frame.height - height) / 2,
    width,
    height
  };
}

function boundsDistance(left, right) {
  return Math.abs(left.x - right.x) + Math.abs(left.y - right.y)
    + Math.abs(left.width - right.width) + Math.abs(left.height - right.height);
}

function nonOpaqueAlphaFingerprint(buffer) {
  try {
    const png = PNG.sync.read(buffer);
    const alpha = Buffer.allocUnsafe(png.width * png.height);
    let minimumAlpha = 255;
    for (let sourceIndex = 3, targetIndex = 0; sourceIndex < png.data.length; sourceIndex += 4, targetIndex += 1) {
      const value = png.data[sourceIndex];
      alpha[targetIndex] = value;
      minimumAlpha = Math.min(minimumAlpha, value);
    }
    if (minimumAlpha >= 254) return null;
    return `${png.width}x${png.height}:${createHash("sha256").update(alpha).digest("hex")}`;
  } catch {
    return null;
  }
}

function uniqueOriginalAssetIndex(sourceImages) {
  const matches = new Map();
  for (const sourceImage of sourceImages.filter((image) => image.originalAsset && image.buffer)) {
    const fingerprint = nonOpaqueAlphaFingerprint(sourceImage.buffer);
    if (!fingerprint) continue;
    if (!matches.has(fingerprint)) matches.set(fingerprint, []);
    matches.get(fingerprint).push(sourceImage);
  }
  return new Map([...matches].filter(([, candidates]) => candidates.length === 1).map(([key, candidates]) => [key, candidates[0]]));
}

function flattenPopplerImageMasks(source, options = {}) {
  let output = String(source || "");
  const sourceImages = options.sourceImages || [];
  const unusedSourceImages = sourceImages.filter((image) => image.frame);
  const originalAssets = uniqueOriginalAssetIndex(sourceImages);
  const images = new Map();
  for (const match of output.matchAll(/<image\b[\s\S]*?\/\s*>/gi)) {
    const attributes = svgAttributes(match[0]);
    const id = attributes.id;
    const href = attributes.href || attributes["xlink:href"];
    const buffer = pngDataUrl(href);
    if (id && buffer) images.set(id, { full: match[0], attributes, buffer });
  }

  const masks = [...output.matchAll(/<mask\b[\s\S]*?<\/mask\s*>/gi)];
  for (const maskMatch of masks) {
    const maskAttributes = svgAttributes(maskMatch[0].match(/^<mask\b[^>]*>/i)?.[0]);
    const maskId = maskAttributes.id;
    const maskUse = maskMatch[0].match(/<use\b[^>]*filter\s*=\s*["']url\(#filter-color-to-alpha\)["'][^>]*\/\s*>/i);
    if (!maskId || !maskUse) continue;
    const maskUseAttributes = svgAttributes(maskUse[0]);
    const maskSourceId = String(maskUseAttributes.href || maskUseAttributes["xlink:href"] || "").replace(/^#/, "");
    const maskImage = images.get(maskSourceId);
    if (!maskImage) continue;

    const visiblePattern = new RegExp(`<g\\b(?=[^>]*mask\\s*=\\s*["']url\\(#${escapeRegExp(maskId)}\\)["'])[^>]*>\\s*(<use\\b[^>]*\\/\\s*>)\\s*<\\/g\\s*>`, "i");
    const visibleMatch = output.match(visiblePattern);
    if (!visibleMatch) continue;
    const visibleUseAttributes = svgAttributes(visibleMatch[1]);
    const colorSourceId = String(visibleUseAttributes.href || visibleUseAttributes["xlink:href"] || "").replace(/^#/, "");
    const colorImage = images.get(colorSourceId);
    if (!colorImage) continue;
    if (String(maskUseAttributes.transform || "").replace(/\s+/g, " ") !== String(visibleUseAttributes.transform || "").replace(/\s+/g, " ")) continue;

    const visibleBounds = imageBounds({ ...colorImage.attributes, transform: visibleUseAttributes.transform });
    let sourceImageIndex = -1;
    let sourceImageDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < unusedSourceImages.length; index += 1) {
      const distance = boundsDistance(visibleBounds, fittedImageBounds(unusedSourceImages[index]));
      if (distance < sourceImageDistance) {
        sourceImageDistance = distance;
        sourceImageIndex = index;
      }
    }
    const sourceImage = sourceImageIndex >= 0 && sourceImageDistance <= 8
      ? unusedSourceImages.splice(sourceImageIndex, 1)[0]
      : null;
    let combined = sourceImage?.buffer ?? null;
    if (!combined) {
      try {
        combined = combineRgbAndLuminanceMask(colorImage.buffer, maskImage.buffer);
      } catch {
        continue;
      }
    }
    if (!combined) continue;
    if (!sourceImage) {
      const originalAsset = originalAssets.get(nonOpaqueAlphaFingerprint(combined));
      if (originalAsset) combined = originalAsset.buffer;
    }
    const combinedHref = `data:image/png;base64,${combined.toString("base64")}`;
    const updatedColorImage = colorImage.full.replace(
      /((?:xlink:)?href\s*=\s*)(["'])data:image\/png;base64,[A-Za-z0-9+/=]+\2/i,
      `$1$2${combinedHref}$2`
    );
    output = output.replace(colorImage.full, updatedColorImage);
    output = output.replace(maskImage.full, "");
    output = output.replace(maskMatch[0], "");
    output = output.replace(visiblePattern, visibleMatch[1]);
  }
  return output;
}

function prepareFigmaVectorSvg(source, options = {}) {
  const input = flattenPopplerImageMasks(source, { sourceImages: options.sourceImages });
  if (!/^\s*<\?xml[\s\S]*?<svg\b|^\s*<svg\b/i.test(input)) {
    throw new Error("Poppler did not produce a valid SVG document");
  }
  const withoutTextGlyphs = options.stripTextGlyphs === false
    ? input
    : input.replace(
      /<use\b(?=[^>]*(?:xlink:href|href)\s*=\s*["']#glyph-)[^>]*\/?\s*>\s*(?:<\/use\s*>)?/gi,
      ""
    );
  const normalized = withoutTextGlyphs
    .replace(/\b(width|height)=(['"])(\d+(?:\.\d+)?)pt\2/gi, "$1=$2$3$2")
    .replace(/<metadata\b[\s\S]*?<\/metadata\s*>/gi, "");
  const drawableContent = normalized.replace(/<defs\b[\s\S]*?<\/defs\s*>/gi, "");
  if (!/<(?:path|rect|circle|ellipse|polygon|polyline|line|image|use)\b/i.test(drawableContent)) {
    throw new Error("The SwiftUI PDF rendered an empty SVG. Run the screen again after its content has appeared.");
  }
  const maximumByteLength = options.maximumByteLength ?? 2_500_000;
  if (Buffer.byteLength(normalized, "utf8") > maximumByteLength) {
    throw new Error("The rendered SVG is larger than 2.5 MB. Simplify the screen or its embedded images before syncing.");
  }
  return normalized;
}

function isSwiftUiUnsupportedRendererSvg(source) {
  const svg = String(source || "");
  return /fill="rgb\(100%,\s*80\.000305%,\s*0%\)"/i.test(svg)
    && /stroke="rgb\(100%,\s*21\.960449%,\s*23\.529053%\)"/i.test(svg)
    && /stroke-width="42"/i.test(svg)
    && /stroke-linecap="butt"/i.test(svg);
}

function parsePdfInfo(source) {
  const pages = Number(String(source).match(/^Pages:\s+(\d+)$/m)?.[1] || 0);
  const size = String(source).match(/^Page size:\s+([\d.]+) x ([\d.]+) pts/m);
  if (!Number.isInteger(pages) || pages < 1 || !size) throw new Error("Could not read PDF page information");
  return { pages, width: Number(size[1]), height: Number(size[2]) };
}

async function indexPdfPages(pdfPath, outputDirectory, options = {}) {
  const command = options.command || await findPdfToCairo();
  const pdfInfoCommand = options.pdfInfoCommand || path.join(path.dirname(command), "pdfinfo");
  const info = parsePdfInfo(await runOutput(pdfInfoCommand, [pdfPath], { timeout: 30_000 }));
  await mkdir(outputDirectory, { recursive: true });
  const pages = [];
  for (let pageNumber = 1; pageNumber <= info.pages; pageNumber += 1) {
    const previewPath = path.join(outputDirectory, `page-${pageNumber}.png`);
    const previewStem = previewPath.slice(0, -4);
    await run(command, ["-png", "-f", String(pageNumber), "-l", String(pageNumber), "-singlefile", "-scale-to", "640", pdfPath, previewStem], { timeout: 60_000 });
    const providedName = options.pageNames?.[pageNumber - 1];
    pages.push({
      id: `pdf-page-${pageNumber}`,
      pageNumber,
      name: typeof providedName === "string" && providedName.trim() ? providedName.trim() : `Page ${pageNumber}`,
      width: info.width,
      height: info.height,
      previewPath
    });
  }
  return pages;
}

async function convertPdfToFigmaSvg(pdfPath, svgPath, options = {}) {
  const command = options.command || await findPdfToCairo();
  const pageNumber = options.pageNumber || 1;
  await run(command, ["-svg", "-f", String(pageNumber), "-l", String(pageNumber), pdfPath, svgPath], { timeout: 60_000 });
  const maximumByteLength = options.maximumByteLength ?? 2_500_000;
  let prepared = prepareFigmaVectorSvg(await readFile(svgPath, "utf8"), {
    stripTextGlyphs: options.stripTextGlyphs,
    maximumByteLength: Number.POSITIVE_INFINITY,
    sourceImages: options.sourceImages
  });
  prepared = await downsampleEmbeddedPngs(prepared, {
    maximumByteLength,
    imageResizer: options.imageResizer,
    pixelDensities: options.pixelDensities
  });
  prepared = prepareFigmaVectorSvg(prepared, {
    stripTextGlyphs: options.stripTextGlyphs,
    maximumByteLength
  });
  await writeFile(svgPath, prepared, "utf8");
  const drawableCount = (prepared
    .replace(/<defs\b[\s\S]*?<\/defs\s*>/gi, "")
    .match(/<(?:path|rect|circle|ellipse|polygon|polyline|line|image|use)\b/gi) || []).length;
  return { path: svgPath, byteLength: Buffer.byteLength(prepared, "utf8"), drawableCount };
}

module.exports = {
  combineRgbAndLuminanceMask,
  convertPdfToFigmaSvg,
  downsampleEmbeddedPngs,
  findPdfToCairo,
  flattenPopplerImageMasks,
  indexPdfPages,
  isSwiftUiUnsupportedRendererSvg,
  parsePdfInfo,
  prepareFigmaVectorSvg
};
