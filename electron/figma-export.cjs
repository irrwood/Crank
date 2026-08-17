const { createHash } = require("node:crypto");

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

function projectIdFor(origin) {
  return createHash("sha256").update(String(origin ?? "")).digest("hex").slice(0, 24);
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
 * Builds the job. Pages without a captured layer tree are left out and
 * reported rather than sent as empty frames, which would look like a
 * successful export of a blank screen.
 */
function buildFigmaJob(inventory, { projectName, figmaFileName } = {}) {
  const pages = (inventory?.pages ?? []).filter((page) => page?.figmaTree?.tree);
  const missing = (inventory?.pages ?? [])
    .filter((page) => !page?.figmaTree?.tree)
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
    width: clampSide(page.figmaTree.width),
    height: clampSide(page.figmaTree.height),
    domTree: page.figmaTree.tree
  }));

  return {
    ok: true,
    job: {
      operation: "push",
      projectId: projectIdFor(inventory?.origin),
      projectName: String(projectName || inventory?.origin || "Project").slice(0, 160),
      figmaFileName: String(figmaFileName || "").slice(0, 240),
      screens
    },
    missing,
    dropped
  };
}

module.exports = { MAX_SCREENS, buildFigmaJob, clampSide, projectIdFor, safeScreenId };
