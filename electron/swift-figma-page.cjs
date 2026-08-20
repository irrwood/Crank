const { mkdir, readFile, writeFile } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { z } = require("zod");
const { isTextCleanPdfSafe } = require("./pdf-text-clean.cjs");
const { convertPdfToFigmaSvg } = require("./swift-pdf-vector.cjs");
const { extractPdfTextRuns } = require("./swift-pdf-text.cjs");
const { prepareNativeSvgShadows } = require("./svg-native-shadows.cjs");
const { resolveCapturedSwiftVectorEffects } = require("./swift-vector-effects.cjs");
const { resolveSwiftSourceImages } = require("./swift-source-images.cjs");
const { normalizeSwiftTreeForPdfPage } = require("./swift-page-coordinate.cjs");
const { buildSwiftVisualPayload } = require("./swift-visual-assets.cjs");

const pdfPageIdSchema = z.string().regex(/^pdf-page-\d+$/);

// The Figma bridge carries 120 screens in one job.
const MAX_SWIFT_PAGES = 120;

function swiftPageSvgDirectory(root, metadata) {
  return path.join(
    path.dirname(metadata.swiftRuntimePdf.path),
    "figma-pages",
    createHash("sha256").update(root).digest("hex").slice(0, 16)
  );
}

/**
 * Picks the exported pages a sync is about.
 *
 * No `targetId` means every exported page, which is what sending a whole scan
 * to Figma asks for.
 */
function selectSwiftPdfPages(metadata, targetId) {
  if (!metadata?.swiftRuntimePdf) {
    throw new Error(metadata?.swiftRuntimeVectorMessage || "Export this iOS project before sending a page to Figma.");
  }
  const pages = metadata.swiftRuntimePdf.pages ?? [];
  if (targetId === undefined || targetId === null) {
    if (pages.length === 0) throw new Error("This iOS export contains no pages. Scan the project again.");
    if (pages.length > MAX_SWIFT_PAGES) {
      throw new Error(`This export has ${pages.length} pages. Send them page by page — one Figma sync carries at most ${MAX_SWIFT_PAGES}.`);
    }
    return pages;
  }
  const pageId = pdfPageIdSchema.parse(targetId);
  const page = pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error("That page is no longer in the export. Scan the project again.");
  return [page];
}

function collectNodes(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const child of node.children ?? []) collectNodes(child, visit);
}

/**
 * Re-anchors a source tree to the page that was actually exported.
 *
 * The instrumented renderer exports one page's own coordinate space rather than
 * the whole window, so the source tree has to be moved into it before anything
 * is matched against the rendered result.
 */
function alignSourceScreenToPage(sourceScreen, page) {
  if (!sourceScreen || page.renderSource !== "image-renderer" || !page.contentFrame) return sourceScreen;
  return {
    ...sourceScreen,
    runtimeCapture: sourceScreen.runtimeCapture
      ? { ...sourceScreen.runtimeCapture, isVisualReference: false }
      : sourceScreen.runtimeCapture,
    uiTree: normalizeSwiftTreeForPdfPage(
      sourceScreen.uiTree,
      page.contentFrame,
      { width: page.width, height: page.height }
    )
  };
}

/**
 * Turns one exported PDF page into the SVG Figma will draw, plus the native
 * effects, editable text, and original project images that may be restored on
 * top of it.
 *
 * The PDF stays the visual source of truth. Everything here either matches the
 * captured data reliably or is left exactly as the page rendered.
 */
async function buildSwiftFigmaPageVector({ root, metadata, page, sourceScreen, svgDirectory }) {
  const warnings = [];
  const directory = svgDirectory ?? swiftPageSvgDirectory(root, metadata);
  await mkdir(directory, { recursive: true });
  const svgPath = path.join(directory, `${page.id}.svg`);
  const documentPdfPath = metadata.swiftRuntimePdf.path;

  const sourceTexts = [];
  const capturedRuntimeTextFrames = [];
  if (sourceScreen) {
    collectNodes(sourceScreen.uiTree, (node) => {
      if (typeof node.text === "string" && node.text.trim()) sourceTexts.push(node.text.trim());
      if (node.runtimeTextCaptured === true && node.runtimeFrame?.width > 0 && node.runtimeFrame?.height > 0 && typeof node.text === "string" && node.text.length > 0) {
        capturedRuntimeTextFrames.push(node.runtimeFrame);
      }
    });
  }

  let extractedText = null;
  if (page.renderSource === "image-renderer") {
    try {
      extractedText = await extractPdfTextRuns(page.pdfPath ?? documentPdfPath, {
        pageNumber: page.pdfPageNumber ?? page.pageNumber,
        width: page.width,
        height: page.height,
        sourceTexts
      });
    } catch (error) {
      // Not fatal — the page keeps its PDF glyphs — but not silent either.
      warnings.push(`${page.name}: text stayed as PDF glyphs because the text runs could not be read (${error instanceof Error ? error.message : String(error)}).`);
    }
  }
  const hasCompleteEditableText = Boolean(extractedText?.complete && extractedText.runs.length > 0);

  const textCleanValidation = page.renderSource === "window-fallback"
    && page.textCleanPdfPath
    && capturedRuntimeTextFrames.length > 0
    ? await isTextCleanPdfSafe({
      normalPdfPath: page.pdfPath ?? documentPdfPath,
      normalPageNumber: page.pdfPageNumber ?? page.pageNumber,
      cleanPdfPath: page.textCleanPdfPath,
      frames: capturedRuntimeTextFrames,
      viewport: metadata.swiftRuntimeSnapshot?.environment?.viewport ?? { x: 0, y: 0, width: page.width, height: page.height }
    })
    : { safe: false };
  const hasCapturedRuntimeText = Boolean(page.renderSource === "window-fallback" && page.textCleanPdfPath && textCleanValidation.safe);

  const sourcePdfPath = page.pdfPath ?? documentPdfPath;
  const coordinateSpace = page.contentFrame
    ? { ...page.contentFrame, outputWidth: page.width, outputHeight: page.height }
    : metadata.swiftRuntimeSnapshot?.environment?.viewport
      ? { ...metadata.swiftRuntimeSnapshot.environment.viewport, outputWidth: page.width, outputHeight: page.height }
      : null;
  const vectorEffects = page.cleanPdfPath && metadata.swiftRuntimeSnapshot
    ? resolveCapturedSwiftVectorEffects(page.nativeEffects ?? [], metadata.swiftRuntimeSnapshot, page.sourceName, coordinateSpace)
    : [];
  const sourceImages = metadata.swiftRuntimeSnapshot
    ? await resolveSwiftSourceImages(root, metadata.swiftRuntimeSnapshot, page.sourceName, coordinateSpace)
    : [];

  const vectorPdfPath = hasCapturedRuntimeText
    ? page.textCleanPdfPath
    : vectorEffects.length > 0
      ? page.cleanPdfPath
      : sourcePdfPath;
  const vectorPageNumber = hasCapturedRuntimeText ? 1 : page.pdfPageNumber ?? page.pageNumber;
  await convertPdfToFigmaSvg(vectorPdfPath, svgPath, {
    pageNumber: vectorPageNumber,
    stripTextGlyphs: hasCompleteEditableText,
    sourceImages
  });

  // The conversion output stays as converted so it can be reused; the
  // shadow-stripped variant is written beside it rather than over it.
  const nativeShadowPlan = prepareNativeSvgShadows(await readFile(svgPath, "utf8"));
  let preparedSvgPath = svgPath;
  if (nativeShadowPlan.shadows.length > 0) {
    preparedSvgPath = path.join(directory, `${page.id}-native-shadows.svg`);
    await writeFile(preparedSvgPath, nativeShadowPlan.svg, "utf8");
  }

  let semanticFallbackSvg = null;
  if (vectorEffects.length > 0 || hasCapturedRuntimeText) {
    const fallbackPath = path.join(directory, `${page.id}-visual-fallback.svg`);
    await convertPdfToFigmaSvg(sourcePdfPath, fallbackPath, {
      pageNumber: page.pdfPageNumber ?? page.pageNumber,
      stripTextGlyphs: hasCompleteEditableText,
      sourceImages
    });
    semanticFallbackSvg = await readFile(fallbackPath, "utf8");
  }

  return {
    warnings,
    pageVector: {
      svgPath: preparedSvgPath,
      textMode: hasCapturedRuntimeText ? "editable-runtime" : hasCompleteEditableText ? "editable-pdf" : "pdf-glyphs",
      textRuns: hasCompleteEditableText ? extractedText.runs : [],
      fallbackSvg: semanticFallbackSvg ?? nativeShadowPlan.fallbackSvg,
      nativeShadows: nativeShadowPlan.shadows,
      vectorEffects
    }
  };
}

function systemTabBarPayload(page) {
  if (!page.systemTabBar) return null;
  return {
    designKit: page.systemTabBar.designKit,
    appearance: page.systemTabBar.appearance,
    selectedIndex: page.systemTabBar.selectedIndex,
    items: page.systemTabBar.items.map(({ title, systemImage }) => ({ title, systemImage }))
  };
}

function withoutSourceExpressions(node) {
  if (!node || typeof node !== "object") return node;
  const { sourceExpression: _local, children, ...safe } = node;
  return { ...safe, ...(children ? { children: children.map(withoutSourceExpressions) } : {}) };
}

/**
 * Builds the Figma screens for a set of exported iOS pages.
 *
 * Each page becomes one `structured` screen carrying the page's SVG, so what
 * reaches Figma is the rendered PDF with reliably matched native layers on top
 * — never a re-drawn approximation of the source.
 */
async function buildSwiftFigmaScreens({ root, metadata, screens, pages, frames = {} }) {
  const sourceScreens = screens.filter((screen) => screen.sourceType !== "component");
  const runtimeScreen = sourceScreens.find((screen) => screen.runtimeCapture?.isVisualReference);
  const svgDirectory = swiftPageSvgDirectory(root, metadata);
  const warnings = [];
  const assets = new Map();
  const built = [];

  for (const page of pages) {
    const baseScreen = sourceScreens.find((screen) => screen.id === page.sourceScreenId) ?? runtimeScreen ?? sourceScreens[0] ?? null;
    if (!baseScreen) throw new Error(`No SwiftUI view matches ${page.name}. Scan the project again.`);
    const sourceScreen = alignSourceScreenToPage(baseScreen, page);
    const { pageVector, warnings: pageWarnings } = await buildSwiftFigmaPageVector({
      root,
      metadata,
      page,
      sourceScreen,
      svgDirectory
    });
    warnings.push(...pageWarnings);

    const payload = await buildSwiftVisualPayload(
      { ...sourceScreen, id: page.id, name: page.name },
      metadata.swiftRuntimeScreenshot ?? null,
      { vector: pageVector }
    );
    if (!payload.vectorSvg) throw new Error(`The ${page.name} page could not be prepared for Figma.`);
    for (const [assetId, asset] of payload.assets) assets.set(assetId, asset);

    built.push({
      id: page.id,
      name: page.name,
      sourceType: "screen",
      currentNodeId: frames[page.id]?.nodeId ?? null,
      renderMode: "structured",
      uiTree: withoutSourceExpressions(payload.uiTree),
      visualReferenceAssetId: payload.visualReferenceAssetId ?? null,
      vectorSvg: payload.vectorSvg,
      vectorFallbackSvg: payload.vectorFallbackSvg ?? null,
      vectorNativeShadows: payload.vectorNativeShadows ?? [],
      vectorEffects: payload.vectorEffects ?? [],
      vectorTextMode: payload.vectorTextMode ?? null,
      vectorTextRuns: payload.vectorTextRuns ?? [],
      systemTabBar: systemTabBarPayload(page),
      semanticAutoLayout: false
    });
  }

  return { screens: built, assets, warnings };
}

module.exports = {
  MAX_SWIFT_PAGES,
  alignSourceScreenToPage,
  buildSwiftFigmaPageVector,
  buildSwiftFigmaScreens,
  selectSwiftPdfPages,
  swiftPageSvgDirectory
};
