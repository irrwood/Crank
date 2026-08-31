const { drawLayer, escapeHtml } = require("./handoff-page.cjs");

/**
 * Turns a page inventory into the HTML Paper takes as real layers.
 *
 * Paper's canvas is HTML and CSS, so there is no second design model to
 * translate into — the Figma path exists because frames, fills and vector
 * nodes are not what a browser laid out, and none of that applies here. The
 * layer tree a scan already holds is drawn with the same painter the window
 * and the handoff file use, so what Paper receives is what this app shows.
 *
 * The result goes on the clipboard rather than into a file. Paper imports by
 * paste: there is no file format to write and no plugin to install, so the
 * export ends at the clipboard and the person pastes into whichever document
 * they meant. Which is also why this is built from the layer tree and not from
 * the captured markup — a foreign document carries its own stylesheet, its
 * fonts and its scripts, and pasting that into a design tool hands it a web
 * page rather than a screen.
 */

/** What one Figma job carries, kept the same so the two exports agree. */
const MAX_SCREENS = 120;

/** Space between screens on the canvas, wide enough to read as separate. */
const GAP = 160;

/**
 * Past this the clipboard stops being the right way to move a scan. It is a
 * real ceiling rather than a guess at one: the payload is held in memory twice
 * over, and a design tool has to parse all of it inside a paste handler.
 * Reported rather than truncated, because half a scan pasted silently is worse
 * than a scan that says it is too big and names the way through.
 */
const MAX_BYTES = 20_000_000;

function side(value) {
  const rounded = Math.round(Number(value) || 0);
  return Number.isFinite(rounded) && rounded > 0 ? rounded : 1;
}

/**
 * The screens a copy or a push is about, each as the layers inside it.
 *
 * The artboard around them is left to the caller: pasting wants one document
 * with every screen laid out in it, and pushing over MCP wants each screen on
 * its own, because Paper makes the artboard itself. Both draw from here, so
 * neither can quietly start showing something the other does not.
 */
/**
 * Which pages of a scan can be pasted, and what to say about the rest.
 *
 * Separate from drawing them because two tools take the same screens in
 * different shapes — Paper takes HTML, Figma takes SVG — and which pages are
 * usable, and why the others are not, is the same question either way. Written
 * once so the two exports cannot disagree about what a scan contains.
 */
async function usableScreens(inventory, { pageId = null, tool = "Paper" } = {}) {
  const all = inventory?.pages ?? [];
  const asked = pageId === null || pageId === undefined ? all : all.filter((page) => page?.id === pageId);
  if (asked.length === 0) {
    return { ok: false, message: "That page is no longer in this scan. Scan it again.", missing: [], missingReasons: [] };
  }

  const usable = asked.filter((page) => page?.layerTree?.tree);
  const without = asked.filter((page) => !page?.layerTree?.tree);
  const missing = without.map((page) => page?.name ?? "(unnamed)");
  const missingReasons = [...new Set(without.map((page) => page?.layerError).filter(Boolean))];

  if (usable.length === 0) {
    // An iOS scan taken as exported vectors has pages, and none of them is a
    // tree — the PDF is a drawing. Saying "no layers" to someone looking at a
    // full gallery of screens explains nothing; the way to get layers does.
    const vectorOnly = without.length > 0 && without.every((page) => page?.vector);
    const reason = vectorOnly
      ? " This scan holds exported vector pages, which are drawings rather than layers. Capture it as a display list and try again."
      : missingReasons.length > 0
        ? ` The page reported: ${missingReasons.slice(0, 2).join(" · ")}`
        : " Nothing was captured — rescan and the failure will be named.";
    return {
      ok: false,
      message: `No page in this scan has captured layers for ${tool}.${reason}`,
      missing,
      missingReasons
    };
  }

  return {
    ok: true,
    pages: usable.slice(0, MAX_SCREENS),
    missing,
    missingReasons,
    dropped: usable.slice(MAX_SCREENS).map((page) => page.name)
  };
}

async function paperScreens(inventory, { pageId = null } = {}) {
  const found = await usableScreens(inventory, { pageId, tool: "Paper" });
  if (!found.ok) return found;
  const paint = await import("../shared/layer-paint.js");

  return {
    ...found,
    screens: found.pages.map((page) => ({
      id: String(page.id),
      name: String(page.name || "Screen"),
      width: side(page.layerTree.width),
      height: side(page.layerTree.height),
      html: drawLayer(page.layerTree.tree, paint)
    }))
  };
}

/**
 * The document to paste, and the account of what did not make it in.
 *
 * A page with no captured layers is left out and named rather than pasted as
 * an empty box, which would look like a screen that is genuinely blank.
 */
async function renderPaperDocument(inventory, { pageId = null, title = "Crank" } = {}) {
  const found = await paperScreens(inventory, { pageId });
  if (!found.ok) return found;
  const { dropped, missing, missingReasons, screens } = found;

  let x = 0;
  const boards = screens.map((screen) => {
    // The identity is written into the markup so a later push could recognise
    // what an earlier one drew. Nothing reads it back yet — a paste is one
    // way — but it cannot be recovered from a document pasted without it.
    const style = `position:absolute;left:${x}px;top:0;width:${screen.width}px;height:${screen.height}px;overflow:hidden`;
    x += screen.width + GAP;
    return `<div data-name="${escapeHtml(screen.name)}" data-crank-screen="${escapeHtml(screen.id)}" style="${style}">${screen.html}</div>`;
  });
  const width = Math.max(0, x - GAP);
  const height = screens.reduce((tallest, screen) => Math.max(tallest, screen.height), 1);

  const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0">
<div data-name="${escapeHtml(title)}" style="position:relative;width:${width}px;height:${height}px">${boards.join("")}</div>
</body>
</html>`;

  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > MAX_BYTES) {
    const megabytes = Math.round(bytes / 100_000) / 10;
    return {
      ok: false,
      message: screens.length === 1
        ? `“${screens[0].name}” is ${megabytes}MB of markup, more than one paste carries. Push it to Paper instead, or save the handoff page.`
        : `These ${screens.length} screens are ${megabytes}MB of markup, more than one paste carries. Push them to Paper instead, or copy them a page at a time.`,
      missing,
      missingReasons
    };
  }

  return { ok: true, bytes, dropped, html, missing, missingReasons, screens: screens.map((screen) => screen.name) };
}

module.exports = { GAP, MAX_BYTES, MAX_SCREENS, paperScreens, renderPaperDocument, side, usableScreens };
