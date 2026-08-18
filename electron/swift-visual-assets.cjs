const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const { mkdir, readFile } = require("node:fs/promises");
const { promisify } = require("node:util");
const path = require("node:path");

const execFileAsync = promisify(execFile);
const opaqueViewPattern = /(?:^|\.)(?:Map|MKMapView|WebView|WKWebView|Canvas|MetalView|MTKView|VideoPlayer|AVPlayerView|RealityView|SceneView|SCNView|SpriteView|PDFView)$/i;

function isOpaqueSwiftNode(node) {
  if (!node || node.runtimeStatus !== "captured" || !node.runtimeFrame) return false;
  if (opaqueViewPattern.test(String(node.name || ""))) return true;
  return node.type === "custom" && (!Array.isArray(node.children) || node.children.length === 0);
}

function assetIdFor(screenId, syncId, suffix) {
  const digest = createHash("sha256").update(`${screenId}:${syncId}:${suffix}`).digest("hex").slice(0, 24);
  return `swift-${suffix}-${digest}`;
}

function cropPixels(frame, screenshot) {
  const scale = screenshot.displayScale;
  const viewport = screenshot.viewport;
  const maximumWidth = Math.max(1, Math.round(viewport.width * scale));
  const maximumHeight = Math.max(1, Math.round(viewport.height * scale));
  const x = Math.max(0, Math.min(maximumWidth - 1, Math.round((frame.x - viewport.x) * scale)));
  const y = Math.max(0, Math.min(maximumHeight - 1, Math.round((frame.y - viewport.y) * scale)));
  const width = Math.max(1, Math.min(maximumWidth - x, Math.round(frame.width * scale)));
  const height = Math.max(1, Math.min(maximumHeight - y, Math.round(frame.height * scale)));
  return { x, y, width, height };
}

async function cropScreenshot(screenshot, frame, outputDirectory, assetId) {
  const crop = cropPixels(frame, screenshot);
  await mkdir(outputDirectory, { recursive: true });
  const output = path.join(outputDirectory, `${assetId}.png`);
  await execFileAsync("/usr/bin/sips", [
    "-c", String(crop.height), String(crop.width),
    "--cropOffset", String(crop.y), String(crop.x),
    screenshot.path,
    "--out", output
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return readFile(output);
}

async function buildSwiftVisualPayload(screen, screenshot, options = {}) {
  const assets = new Map();
  let vectorSvg = null;
  let vectorFallbackSvg = null;
  let vectorNativeShadows = [];
  let vectorEffects = [];
  let vectorTextMode = null;
  let vectorTextRuns = [];
  if (options.vector?.svgPath) {
    const source = await readFile(options.vector.svgPath, "utf8");
    if (Buffer.byteLength(source, "utf8") > 2_500_000 || !/<svg\b/i.test(source)) {
      throw new Error("The stored SwiftUI vector capture is invalid");
    }
    vectorSvg = source;
    if (options.vector.fallbackSvg) {
      const fallbackSource = String(options.vector.fallbackSvg);
      if (Buffer.byteLength(fallbackSource, "utf8") > 2_500_000 || !/<svg\b/i.test(fallbackSource)) {
        throw new Error("The stored SwiftUI vector fallback is invalid");
      }
      vectorFallbackSvg = fallbackSource;
    }
    vectorNativeShadows = options.vector.nativeShadows ?? [];
    vectorEffects = options.vector.vectorEffects ?? [];
    vectorTextMode = options.vector.textMode ?? null;
    vectorTextRuns = options.vector.textRuns ?? [];
  }
  if (!screenshot || screen.runtimeCapture?.state !== "captured" || screen.runtimeCapture?.isVisualReference !== true) {
    return { uiTree: screen.uiTree, assets, visualReferenceAssetId: null, vectorSvg, vectorFallbackSvg, vectorNativeShadows, vectorEffects, vectorTextMode, vectorTextRuns };
  }

  const visualReferenceAssetId = assetIdFor(screen.id, screen.id, "reference");
  assets.set(visualReferenceAssetId, {
    buffer: await readFile(screenshot.path),
    width: screenshot.viewport.width,
    height: screenshot.viewport.height
  });

  const cropper = options.cropper || cropScreenshot;
  const cropDirectory = options.cropDirectory || path.join(path.dirname(screenshot.path), "crops");
  const visit = async (node, ancestorIsOpaque = false) => {
    if (!node || typeof node !== "object") return node;
    const opaque = !ancestorIsOpaque && isOpaqueSwiftNode(node);
    const children = await Promise.all((node.children || []).map((child) => visit(child, ancestorIsOpaque || opaque)));
    if (!opaque) {
      return {
        ...node,
        visualMode: "editable",
        visualConfidence: node.runtimeStatus === "captured" ? "high" : "medium",
        ...(node.children ? { children } : {})
      };
    }

    const fallbackAssetId = assetIdFor(screen.id, node.syncId || node.name || "opaque", "fallback");
    try {
      const buffer = await cropper(screenshot, node.runtimeFrame, cropDirectory, fallbackAssetId);
      assets.set(fallbackAssetId, {
        buffer,
        width: node.runtimeFrame.width,
        height: node.runtimeFrame.height
      });
      return {
        ...node,
        visualMode: "snapshot-fallback",
        visualConfidence: "low",
        fallbackAssetId,
        ...(node.children ? { children } : {})
      };
    } catch {
      return {
        ...node,
        visualMode: "editable",
        visualConfidence: "low",
        ...(node.children ? { children } : {})
      };
    }
  };

  return { uiTree: await visit(screen.uiTree), assets, visualReferenceAssetId, vectorSvg, vectorFallbackSvg, vectorNativeShadows, vectorEffects, vectorTextMode, vectorTextRuns };
}

module.exports = {
  buildSwiftVisualPayload,
  cropPixels,
  isOpaqueSwiftNode
};
