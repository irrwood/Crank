const { MAX_BYTES, MAX_SCREENS, GAP, side, usableScreens } = require("./paper-export.cjs");

/**
 * Turns a scan into the SVG Figma takes as real layers, without the plugin.
 *
 * The plugin exists because Figma's own model — frames, fills, vector nodes,
 * remembered frame identity — is not what a browser laid out, and building it
 * properly needs code running inside Figma. That path stays: it is the one that
 * updates the same frames on a second scan instead of drawing new ones beside
 * them.
 *
 * This is the other thing people want, which the plugin cannot be: a way to get
 * a screen into whatever file is open, right now, with nothing installed and
 * nobody paired. Figma imports pasted SVG as layers — groups stay groups, text
 * stays editable text, a fill stays a fill — so the clipboard is enough.
 *
 * What it gives up is identity. Pasted layers are new every time; paste twice
 * and you have two copies. That is the trade the plugin exists to avoid, and
 * the reason this is a second way in rather than a replacement.
 *
 * Drawn from `paintLayer`, the same decision the window and the Paper export
 * use, so a screen pasted into Figma and the same screen pasted into Paper
 * agree about what was captured. Only the vocabulary differs: this one writes
 * SVG shapes instead of HTML elements.
 */

const XML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

function xml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => XML_ESCAPES[character]);
}

/** A CSS length as a number, since SVG attributes take bare units. */
function length(value) {
  const parsed = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A CSS colour Figma will accept, and whether it is worth drawing at all.
 *
 * `rgba(0, 0, 0, 0)` is how a layer with no fill arrives, and writing it as a
 * fill gives Figma an invisible rectangle to select — a whole screen of them,
 * over everything else on the canvas.
 */
function paintOf(colour) {
  const value = String(colour ?? "").trim();
  if (!value || value === "transparent" || value === "none") return null;
  const rgba = value.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)$/i);
  if (!rgba) return { fill: value, opacity: 1 };
  const alpha = rgba[4] === undefined ? 1 : Number(rgba[4]);
  if (!(alpha > 0)) return null;
  return { fill: `rgb(${Math.round(Number(rgba[1]))}, ${Math.round(Number(rgba[2]))}, ${Math.round(Number(rgba[3]))})`, opacity: alpha };
}

/** The first family of a CSS stack — SVG takes the list, Figma takes the first. */
function familyOf(style) {
  const first = String(style.fontFamily ?? "").split(",")[0].trim().replace(/^['"]|['"]$/g, "");
  return first || "Inter";
}

/**
 * Where a line of text sits.
 *
 * CSS places text by the top of its line box; SVG places it by the baseline.
 * Converting between them needs the font's ascent, which a capture does not
 * carry, so this uses the ratio that holds for the faces interfaces are set in.
 * Getting it wrong is visible immediately — every string in the paste sits a
 * few pixels high or low against its own box.
 */
function baselineOf(top, style) {
  const size = length(style.fontSize) || 14;
  const line = length(style.lineHeight) || size * 1.2;
  return top + (line - size) / 2 + size * 0.8;
}

function shadowFilter(id, boxShadow) {
  // `rgba(0, 0, 0, 0.33) 0px 2px 8px 0px` — colour first, which is the form the
  // capture normalises to.
  const match = String(boxShadow).match(/^(rgba?\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/i);
  if (!match) return null;
  const colour = paintOf(match[1]);
  if (!colour) return null;
  return `<filter id="${id}" x="-50%" y="-50%" width="200%" height="200%">`
    + `<feDropShadow dx="${length(match[2])}" dy="${length(match[3])}"`
    + ` stdDeviation="${length(match[4]) / 2}" flood-color="${xml(colour.fill)}"`
    + ` flood-opacity="${colour.opacity}"/></filter>`;
}

/**
 * One layer and everything under it, as SVG.
 *
 * Children are positioned by a `translate` on a group rather than by absolute
 * coordinates, so the tree keeps the shape it had: moving a group in Figma
 * moves what is inside it, which is the whole reason to paste layers rather
 * than a picture.
 */
function drawLayerSvg(layer, paint, ids = { next: 0 }) {
  if (!layer || typeof layer !== "object") return "";
  const painted = paint.paintLayer(layer);
  const style = painted.style ?? {};
  const x = length(style.left);
  const y = length(style.top);
  const width = Math.max(length(style.width), 0);
  const height = Math.max(length(style.height), 0);
  if (style.visibility === "hidden") return "";

  const opacity = style.opacity === undefined || style.opacity === null ? 1 : Number(style.opacity);
  const groupAttributes = [`transform="translate(${x}, ${y})"`];
  if (Number.isFinite(opacity) && opacity < 1) groupAttributes.push(`opacity="${opacity}"`);
  if (layer.name) groupAttributes.push(`data-name="${xml(String(layer.name).slice(0, 100))}"`);

  const body = [];

  if (painted.tag === "img" && painted.src) {
    body.push(`<image x="0" y="0" width="${width}" height="${height}"`
      + ` preserveAspectRatio="xMidYMid slice" href="${xml(painted.src)}"/>`);
  } else if (painted.text !== undefined) {
    const colour = paintOf(style.color) ?? { fill: "rgb(0, 0, 0)", opacity: 1 };
    const anchor = style.textAlign === "center" ? "middle" : style.textAlign === "right" ? "end" : "start";
    const shift = anchor === "middle" ? width / 2 : anchor === "end" ? width : 0;
    body.push(`<text x="${shift}" y="${baselineOf(0, style)}"`
      + ` font-family="${xml(familyOf(style))}" font-size="${length(style.fontSize) || 14}"`
      + ` font-weight="${style.fontWeight ?? 400}" fill="${xml(colour.fill)}"`
      + (colour.opacity < 1 ? ` fill-opacity="${colour.opacity}"` : "")
      + (anchor === "start" ? "" : ` text-anchor="${anchor}"`)
      + `>${xml(painted.text)}</text>`);
  } else {
    const fill = paintOf(style.background);
    const border = length(style.borderWidth ?? style.borderTopWidth);
    const stroke = border > 0 ? paintOf(style.borderColor ?? style.borderTopColor) : null;
    const radius = length(style.borderRadius);
    const filterId = style.boxShadow ? `s${ids.next++}` : null;
    const filter = filterId ? shadowFilter(filterId, style.boxShadow) : null;
    if (filter) body.push(`<defs>${filter}</defs>`);
    // A box with neither a fill nor a border draws nothing; it is a group, and
    // adding a rectangle for it would put an invisible click target over
    // everything inside it.
    if (fill || stroke) {
      body.push(`<rect x="0" y="0" width="${width}" height="${height}"`
        + (radius > 0 ? ` rx="${radius}" ry="${radius}"` : "")
        + (fill ? ` fill="${xml(fill.fill)}"` : ` fill="none"`)
        + (fill && fill.opacity < 1 ? ` fill-opacity="${fill.opacity}"` : "")
        + (stroke ? ` stroke="${xml(stroke.fill)}" stroke-width="${border}"` : "")
        + (filter ? ` filter="url(#${filterId})"` : "")
        + "/>");
    }
  }

  for (const child of painted.children ?? []) body.push(drawLayerSvg(child, paint, ids));
  const inside = body.filter(Boolean).join("");
  return inside ? `<g ${groupAttributes.join(" ")}>${inside}</g>` : "";
}

/**
 * The SVG to paste, and the account of what did not make it in.
 *
 * Screens are laid out in a row with the same gap the Paper export uses, so a
 * scan pasted into either tool arrives arranged the same way.
 */
async function renderFigmaSvg(inventory, { pageId = null } = {}) {
  const found = await usableScreens(inventory, { pageId, tool: "Figma" });
  if (!found.ok) return found;
  const paint = await import("../shared/layer-paint.js");

  let x = 0;
  let height = 0;
  const boards = [];
  const screens = [];
  for (const page of found.pages) {
    const width = side(page.layerTree.width);
    const tall = side(page.layerTree.height);
    boards.push(`<g transform="translate(${x}, 0)" data-name="${xml(String(page.name || "Screen"))}">`
      + `<rect x="0" y="0" width="${width}" height="${tall}" fill="rgb(255, 255, 255)"/>`
      + drawLayerSvg(page.layerTree.tree, paint)
      + "</g>");
    screens.push(String(page.name || "Screen"));
    x += width + GAP;
    height = Math.max(height, tall);
  }

  const total = Math.max(x - GAP, 1);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${total}" height="${Math.max(height, 1)}"`
    + ` viewBox="0 0 ${total} ${Math.max(height, 1)}">${boards.join("")}</svg>`;

  if (svg.length > MAX_BYTES) {
    return {
      ok: false,
      message: `This scan is ${Math.round(svg.length / 1e6)}MB of SVG, past what a paste can carry.`
        + " Copy one screen at a time, or send it through the Figma plugin.",
      missing: found.missing,
      missingReasons: found.missingReasons
    };
  }

  return { ok: true, svg, screens, missing: found.missing, dropped: found.dropped };
}

module.exports = { MAX_SCREENS, baselineOf, drawLayerSvg, familyOf, paintOf, renderFigmaSvg };
