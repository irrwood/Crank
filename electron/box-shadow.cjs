/**
 * Turns a computed CSS box-shadow into the effects Figma draws.
 *
 * A real interface is full of them and they were dropped on the floor, so every
 * card and every menu arrived flat. The browser hands back a normalised form —
 * colour first, then offset, blur and spread — which is far easier to read than
 * the many shapes the property accepts in a stylesheet.
 *
 * Splitting on commas has to respect the commas inside rgba(), which is why
 * this counts parentheses rather than calling split.
 */

function splitShadows(value) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (const character of String(value ?? "")) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current.trim()) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/**
 * A CSS colour as Figma's 0–1 channels, or null when it is not one.
 *
 * Chromium hands back `color(srgb 0.13 0.13 0.13)` for anything a stylesheet
 * wrote in modern colour syntax — `color-mix()`, a relative colour, a wide-gamut
 * literal — and a parser that only knew rgb() silently returned nothing for all
 * of them. Nothing, not black: the fill was simply never set, so Cursor's whole
 * dark interface arrived in Figma as empty frames. 703 colours across the scans
 * on this machine are in that syntax.
 *
 * display-p3 is converted rather than dropped, because a Mac reports colours in
 * it whenever the display is wide-gamut, and Figma's canvas is sRGB.
 */
function parseColor(value) {
  const text = String(value ?? "").trim();
  const legacy = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.%]+))?\s*\)$/i.exec(text);
  if (legacy) {
    return {
      r: Math.min(1, Number(legacy[1]) / 255),
      g: Math.min(1, Number(legacy[2]) / 255),
      b: Math.min(1, Number(legacy[3]) / 255),
      a: alphaOf(legacy[4])
    };
  }
  const modern = /^color\(\s*(srgb|srgb-linear|display-p3)\s+([\d.-]+)\s+([\d.-]+)\s+([\d.-]+)(?:\s*\/\s*([\d.%]+))?\s*\)$/i.exec(text);
  if (!modern) return null;
  const clamp = (channel) => Math.max(0, Math.min(1, Number(channel)));
  const [space, red, green, blue] = [modern[1].toLowerCase(), clamp(modern[2]), clamp(modern[3]), clamp(modern[4])];
  const converted = space === "display-p3" ? p3ToSrgb(red, green, blue) : { r: red, g: green, b: blue };
  return { ...converted, a: alphaOf(modern[5]) };
}

function alphaOf(value) {
  if (value === undefined) return 1;
  const text = String(value);
  const number = text.endsWith("%") ? Number(text.slice(0, -1)) / 100 : Number(text);
  return Number.isFinite(number) ? Math.max(0, Math.min(1, number)) : 1;
}

/** Display P3 to sRGB, through linear light, as the CSS colour spec defines it. */
function p3ToSrgb(red, green, blue) {
  const toLinear = (channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const toGamma = (channel) => {
    const clamped = Math.max(0, Math.min(1, channel));
    return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * clamped ** (1 / 2.4) - 0.055;
  };
  const [r, g, b] = [toLinear(red), toLinear(green), toLinear(blue)];
  return {
    r: toGamma(1.2249401 * r - 0.2249404 * g + 0.0000000 * b),
    g: toGamma(-0.0420569 * r + 1.0420571 * g + 0.0000000 * b),
    b: toGamma(-0.0196376 * r - 0.0786361 * g + 1.0982735 * b)
  };
}


/**
 * One shadow. Returns null rather than a guess when the colour or the offsets
 * cannot be read — a shadow drawn in the wrong place is worse than none.
 */
function parseShadow(value) {
  const text = String(value ?? "").trim();
  if (!text || text === "none") return null;
  const inset = /(^|\s)inset(\s|$)/i.test(text);
  const withoutInset = text.replace(/(^|\s)inset(\s|$)/i, " ").trim();
  // Both spellings of a colour, because Chromium uses whichever the stylesheet
  // implied — and `color(srgb …)` has spaces inside it, so it cannot be found
  // by splitting the shadow on whitespace first.
  const colorMatch = withoutInset.match(/((?:rgba?|color)\([^)]*\))/i);
  if (!colorMatch) return null;
  const color = parseColor(colorMatch[1]);
  if (!color) return null;
  const lengths = withoutInset
    .replace(colorMatch[1], " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => Number.parseFloat(part));
  if (lengths.length < 2 || lengths.some((length) => !Number.isFinite(length))) return null;
  const [offsetX, offsetY, blur = 0, spread = 0] = lengths;
  return {
    type: inset ? "INNER_SHADOW" : "DROP_SHADOW",
    color,
    offset: { x: offsetX, y: offsetY },
    // CSS blur is the full Gaussian diameter; Figma's radius is half of it.
    radius: Math.max(0, blur / 2),
    spread: Math.max(0, spread),
    visible: true,
    blendMode: "NORMAL"
  };
}

/** Every shadow on one element, nearest the surface first, as CSS paints them. */
function parseBoxShadow(value) {
  if (!value || value === "none") return [];
  return splitShadows(value).map(parseShadow).filter(Boolean).slice(0, 8);
}

module.exports = { parseBoxShadow, parseShadow, splitShadows };
