const { createHash } = require("node:crypto");
const { parseBoxShadow } = require("./box-shadow.cjs");

/**
 * Turns a page inventory into the job the Figma bridge already understands.
 *
 * The plugin builds real layers from a serialised DOM — frames, text, vectors
 * via createNodeFromSvg, auto-layout, fills, strokes, radii. That pipeline was
 * only ever reachable for projects with a loadable static build, so Next,
 * Python and Electron projects could not use it. Nothing about it needed to
 * change; it only needed to be handed pages found the new way.
 */

const MAX_SCREENS = 120;
const MIN_SIDE = 320;
// The bridge's ceiling, not Figma's. A dashboard scrolls well past 4096px and
// scaling or cropping it to fit would quietly misreport the design.
const MAX_SIDE = 40_000;

/**
 * The id the plugin tags every frame with, so a second push finds the frames
 * the first one made. It must therefore name the project and not the run: a
 * folder is served on a fresh port each scan, and hashing that origin gave the
 * same project a new identity every time — the plugin found none of its own
 * frames and drew the whole inventory again beside itself.
 */
function projectIdFor(identity) {
  return createHash("sha256").update(String(identity ?? "")).digest("hex").slice(0, 24);
}

/**
 * Turns the CSS the page reported into the effects Figma draws.
 *
 * Done here rather than in the page, which cannot require anything, and rather
 * than in the plugin, which would then carry a CSS parser it could not be
 * tested against.
 */
function withParsedShadows(node) {
  if (!node || typeof node !== "object") return node;
  const { boxShadow, ...style } = node.style ?? {};
  const shadows = parseBoxShadow(boxShadow);
  return {
    ...node,
    ...(node.style ? { style: shadows.length > 0 ? { ...style, shadows } : style } : {}),
    ...(node.children ? { children: node.children.map(withParsedShadows) } : {})
  };
}

function safeScreenId(id, fallbackIndex) {
  const cleaned = String(id ?? "").replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 120);
  return cleaned || `screen-${fallbackIndex}`;
}

function clampSide(value) {
  const rounded = Math.round(Number(value) || 0);
  if (!Number.isFinite(rounded) || rounded <= 0) return MIN_SIDE;
  return Math.min(MAX_SIDE, Math.max(MIN_SIDE, rounded));
}

/**
 * Fonts the capture could not render, so their text was measured with
 * something else.
 *
 * Not a failure — Figma has its own library and the plugin sets the font it
 * finds there — but the layout of those runs is Figma's rather than the
 * browser's, and that is worth saying before someone compares the two.
 */
function unavailableFonts(inventory) {
  const found = new Set();
  const visit = (node) => {
    for (const family of node?.style?.unavailableFonts ?? []) found.add(family);
    for (const child of node?.children ?? []) visit(child);
  };
  for (const page of inventory?.pages ?? []) visit(page?.layerTree?.tree);
  return [...found].sort();
}

/**
 * Builds the job. Pages without a captured layer tree are left out and
 * reported rather than sent as empty frames, which would look like a
 * successful export of a blank screen.
 */
function buildFigmaJob(inventory, { identity, projectName, figmaFileName, operation = "push" } = {}) {
  const pages = (inventory?.pages ?? []).filter((page) => page?.layerTree?.tree);
  const missing = (inventory?.pages ?? [])
    .filter((page) => !page?.layerTree?.tree)
    .map((page) => page?.name ?? "(unnamed)");

  if (pages.length === 0) {
    return { ok: false, message: "No page in this scan has captured layers to send.", missing };
  }

  const dropped = pages.slice(MAX_SCREENS).map((page) => page.name);
  const screens = pages.slice(0, MAX_SCREENS).map((page, index) => ({
    id: safeScreenId(page.id, index),
    name: String(page.name || `Page ${index + 1}`).slice(0, 160),
    // Every discovered page is a screen; the crawl does not claim to know
    // which of them a designer would call a modal.
    sourceType: "screen",
    currentNodeId: page.figmaNodeId ?? null,
    renderMode: "editable-dom",
    width: clampSide(page.layerTree.width),
    height: clampSide(page.layerTree.height),
    domTree: withParsedShadows(page.layerTree.tree)
  }));

  return {
    ok: true,
    job: {
      operation,
      projectId: projectIdFor(identity ?? inventory?.origin),
      projectName: String(projectName || inventory?.origin || "Project").slice(0, 160),
      figmaFileName: String(figmaFileName || "").slice(0, 240),
      screens
    },
    missing,
    dropped,
    substitutedFonts: unavailableFonts(inventory)
  };
}

module.exports = { MAX_SCREENS, buildFigmaJob, clampSide, projectIdFor, safeScreenId, unavailableFonts, withParsedShadows };
