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

function parseColor(value) {
  const match = String(value).match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i);
  if (!match) return null;
  return {
    r: Math.min(1, Number(match[1]) / 255),
    g: Math.min(1, Number(match[2]) / 255),
    b: Math.min(1, Number(match[3]) / 255),
    a: match[4] === undefined ? 1 : Number(match[4])
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
  const colorMatch = withoutInset.match(/(rgba?\([^)]*\))/i);
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
