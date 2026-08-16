const { z } = require("zod");

const nativeShadowSchema = z.object({
  marker: z.string().regex(/^ui-sync-shadow-\d+$/),
  color: z.object({
    r: z.number().finite().min(0).max(1),
    g: z.number().finite().min(0).max(1),
    b: z.number().finite().min(0).max(1),
    a: z.number().finite().min(0).max(1)
  }).strict(),
  offset: z.object({ x: z.number().finite(), y: z.number().finite() }).strict(),
  radius: z.number().finite().min(0).max(1000),
  spread: z.number().finite().min(-1000).max(1000)
}).strict();

function numberAttribute(source, name, fallback = 0) {
  const value = Number(String(source || "").match(new RegExp(`\\b${name}\\s*=\\s*["'](-?\\d+(?:\\.\\d+)?)["']`, "i"))?.[1]);
  return Number.isFinite(value) ? value : fallback;
}

function stringAttribute(source, name, fallback = "") {
  return String(source || "").match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? fallback;
}

function colorFromCss(value) {
  const source = String(value || "black").trim().toLowerCase();
  if (source === "black") return { r: 0, g: 0, b: 0 };
  if (source === "white") return { r: 1, g: 1, b: 1 };
  const short = source.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) return { r: Number.parseInt(short[1] + short[1], 16) / 255, g: Number.parseInt(short[2] + short[2], 16) / 255, b: Number.parseInt(short[3] + short[3], 16) / 255 };
  const hex = source.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const integer = Number.parseInt(hex[1], 16);
    return { r: ((integer >> 16) & 0xff) / 255, g: ((integer >> 8) & 0xff) / 255, b: (integer & 0xff) / 255 };
  }
  const rgb = source.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/);
  if (rgb) return { r: Math.min(255, Number(rgb[1])) / 255, g: Math.min(255, Number(rgb[2])) / 255, b: Math.min(255, Number(rgb[3])) / 255 };
  return null;
}

function shadowFromPrimitive(attributes) {
  const color = colorFromCss(stringAttribute(attributes, "flood-color", "black"));
  if (!color) return null;
  return {
    color: { ...color, a: Math.max(0, Math.min(1, numberAttribute(attributes, "flood-opacity", 1))) },
    offset: { x: numberAttribute(attributes, "dx", 0), y: numberAttribute(attributes, "dy", 0) },
    radius: Math.max(0, numberAttribute(attributes, "stdDeviation", 0)),
    spread: 0
  };
}

function expandedShadowFromFilter(body) {
  const blur = body.match(/<feGaussianBlur\b([^>]*)\/?\s*>/i);
  const offset = body.match(/<feOffset\b([^>]*)\/?\s*>/i);
  const flood = body.match(/<feFlood\b([^>]*)\/?\s*>/i);
  const hasComposite = /<feComposite\b/i.test(body);
  const hasMerge = /<feMerge\b/i.test(body);
  if (!blur || !offset || !flood || !hasComposite || !hasMerge) return null;
  const allowed = body
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<\/?(?:feGaussianBlur|feOffset|feFlood|feComposite|feMerge|feMergeNode)\b[^>]*>/gi, "")
    .trim();
  if (allowed) return null;
  const color = colorFromCss(stringAttribute(flood[1], "flood-color", "black"));
  if (!color) return null;
  return [{
    color: { ...color, a: Math.max(0, Math.min(1, numberAttribute(flood[1], "flood-opacity", 1))) },
    offset: { x: numberAttribute(offset[1], "dx", 0), y: numberAttribute(offset[1], "dy", 0) },
    radius: Math.max(0, numberAttribute(blur[1], "stdDeviation", 0)),
    spread: 0
  }];
}

function supportedFilters(source) {
  const filters = new Map();
  for (const match of String(source || "").matchAll(/<filter\b([^>]*)>([\s\S]*?)<\/filter\s*>/gi)) {
    const id = stringAttribute(match[1], "id");
    if (!id) continue;
    const primitives = [...match[2].matchAll(/<feDropShadow\b([^>]*)\/?\s*>/gi)]
      .map((primitive) => shadowFromPrimitive(primitive[1]));
    const withoutDropShadows = match[2].replace(/<feDropShadow\b[^>]*\/?\s*>/gi, "").replace(/<!--([\s\S]*?)-->/g, "").trim();
    const shadows = primitives.length > 0 && primitives.every(Boolean) && !withoutDropShadows
      ? primitives
      : expandedShadowFromFilter(match[2]);
    if (shadows?.length) filters.set(id, { fullMatch: match[0], shadows });
  }
  return filters;
}

function prepareNativeSvgShadows(source) {
  const originalSvg = String(source || "");
  const filters = supportedFilters(originalSvg);
  if (filters.size === 0) return { svg: originalSvg, fallbackSvg: null, shadows: [] };
  let markerIndex = 0;
  const usedFilters = new Set();
  const shadows = [];
  const transformed = originalSvg.replace(/<([A-Za-z][\w:.-]*)([^<>]*)>/g, (full, tag, rawAttributes) => {
    if (tag.toLowerCase() === "filter") return full;
    const direct = rawAttributes.match(/\sfilter\s*=\s*["']url\(#([^)'"\s]+)\)["']/i);
    const style = rawAttributes.match(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/i);
    const styleFilter = style?.[2].match(/(?:^|;)\s*filter\s*:\s*url\(#([^)'"\s]+)\)\s*(?:;|$)/i);
    const filterId = direct?.[1] ?? styleFilter?.[1];
    const definition = filterId ? filters.get(filterId) : null;
    if (!definition) return full;
    const marker = `ui-sync-shadow-${markerIndex++}`;
    usedFilters.add(filterId);
    for (const shadow of definition.shadows) shadows.push(nativeShadowSchema.parse({ marker, ...shadow }));
    let attributes = rawAttributes
      .replace(/\sfilter\s*=\s*["']url\(#[^)'"\s]+\)["']/i, "")
      .replace(/\sid\s*=\s*["'][^"']*["']/i, "");
    if (style) {
      const nextStyle = style[2].replace(/(?:^|;)\s*filter\s*:\s*url\(#[^)'"\s]+\)\s*(?=;|$)/i, "").replace(/^;+|;+$/g, "").trim();
      attributes = attributes.replace(style[0], nextStyle ? ` style=${style[1]}${nextStyle}${style[1]}` : "");
    }
    return `<${tag} id="${marker}"${attributes}>`;
  });
  if (shadows.length === 0) return { svg: originalSvg, fallbackSvg: null, shadows: [] };
  let svg = transformed;
  for (const filterId of usedFilters) svg = svg.replace(filters.get(filterId).fullMatch, "");
  return { svg, fallbackSvg: originalSvg, shadows };
}

module.exports = {
  colorFromCss,
  nativeShadowSchema,
  prepareNativeSvgShadows,
  supportedFilters
};
