/**
 * What one captured layer looks like on screen, decided once.
 *
 * Two things draw a scanned page: the window, in React, and an exported handoff
 * file, as plain HTML written in Node. They must agree — a preview that shows a
 * shadow the export drops is worse than neither showing it, because the person
 * checking the work has no way to tell which one lied. So the decision of what
 * a layer looks like lives here, and each side only turns the answer into its
 * own kind of element.
 *
 * The vocabulary is the browser's, not Figma's: CSS colour strings, CSS
 * property names, DOM kinds. Figma's shapes are made when an export job is
 * built and stay on that side of the line.
 */

const px = (value) => (typeof value === "number" ? `${value}px` : undefined);

/** Borders are captured per side; Figma keeps one, and so does this. */
function borderOf(style) {
  const sides = [
    [style.borderTopWidth, style.borderTopColor],
    [style.borderRightWidth, style.borderRightColor],
    [style.borderBottomWidth, style.borderBottomColor],
    [style.borderLeftWidth, style.borderLeftColor]
  ];
  const found = sides.find(([width]) => typeof width === "number" && width > 0);
  return found ? { border: `${found[0]}px solid ${found[1]}` } : {};
}

/** A shadow's parts, with a colour that may itself contain spaces. */
function shadowParts(shadow) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const character of shadow) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (current) out.push(current);
      current = "";
    } else current += character;
  }
  if (current) out.push(current);
  const lengths = out.filter((part) => /^-?[\d.]+(px|r?em)?$/.test(part));
  const colour = out.filter((part) => !/^-?[\d.]+(px|r?em)?$/.test(part)).join(" ");
  return lengths.length >= 2 && colour
    ? `drop-shadow(${lengths[0]} ${lengths[1]} ${lengths[2] ?? "0px"} ${colour})`
    : null;
}

/** Shadows separated, without splitting the commas inside `rgba(...)`. */
function eachShadow(shadow) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const character of shadow) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (character === "," && depth === 0) { out.push(current); current = ""; }
    else current += character;
  }
  out.push(current);
  return out.map((part) => part.trim()).filter(Boolean);
}

/**
 * The capture keeps the browser's own shadow string, and this draws to CSS, so
 * it mostly passes straight through. Figma's effect objects are made at the
 * export boundary; reaching for them here cost every shadow in the preview,
 * since the stored tree has never carried them.
 *
 * A box with nothing drawn in it is the exception. `box-shadow` is cast by the
 * border box, so a shadow on a transparent wrapper draws a rectangle — and in
 * SwiftUI that is where shadows arrive, because `.shadow()` reaches the display
 * list as an effect around the thing it shades rather than as a property of it.
 * A round record button came back inside a soft rectangle, and a cut-out
 * sticker came back on a blue card it never had. `drop-shadow` is cast by what
 * is actually painted, so the circle shades as a circle and the sticker as its
 * own silhouette. It has no spread, which is the one thing given up here.
 */
function shadowOf(style, drawn) {
  const shadow = style.boxShadow;
  if (typeof shadow !== "string" || !shadow || shadow === "none") return {};
  if (drawn || shadow.includes("inset")) return { boxShadow: shadow };
  const drops = eachShadow(shadow).map(shadowParts);
  return drops.every(Boolean) ? { drawnShadow: drops.join(" ") } : { boxShadow: shadow };
}

/**
 * Everything painted over the box itself: `.blur()` laid on its content, and
 * the shadows that have to be cast from what is drawn rather than from the
 * border box. One CSS property holds both, so they are built together.
 */
function filterOf(style, drawnShadow) {
  const blur = Number(style.blur);
  const parts = [];
  if (Number.isFinite(blur) && blur > 0) parts.push(`blur(${blur}px)`);
  if (drawnShadow) parts.push(drawnShadow);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/**
 * What a material does to what is behind it.
 *
 * SwiftUI's materials arrive as a blur radius and a saturation, folded into one
 * box when the layers were read. CSS has the same two, and no other way to say
 * it: a translucent fill alone is a pane of tinted glass, not frosted glass.
 */
function backdropOf(style) {
  const blur = Number(style.backdropBlur);
  const saturation = Number(style.backdropSaturation);
  const parts = [];
  if (Number.isFinite(blur) && blur > 0) parts.push(`blur(${blur}px)`);
  if (Number.isFinite(saturation) && saturation > 0 && saturation !== 1) parts.push(`saturate(${saturation})`);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** Whether the box itself paints anything, and so has an edge to cast from. */
function boxIsDrawn(style) {
  const background = style.backgroundColor;
  const filled = typeof background === "string"
    && background !== "transparent"
    && !/^rgba\([^)]*,\s*0\s*\)$/.test(background);
  const bordered = [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
    .some((width) => typeof width === "number" && width > 0);
  return filled || bordered;
}

/**
 * Captured SVG is markup from someone else's page and can carry a script, so it
 * is drawn as an image rather than inlined. Percent-encoded rather than base64
 * because that needs no encoder, and there is one of those in the window and a
 * different one in Node.
 */
function svgSource(svg) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Whether the capture measured this run as a single line. */
function measuredOneLine(layer, style) {
  const line = typeof style.lineHeight === "number" && style.lineHeight > 0
    ? style.lineHeight
    : typeof style.fontSize === "number" ? style.fontSize * 1.2 : 0;
  const height = Number(layer.layoutHeight ?? layer.height);
  return line > 0 && Number.isFinite(height) && height > 0 && height <= line * 1.5;
}

/** CSS's own family keywords, which name a class of font and never a font. */
const GENERIC_FAMILIES = new Set([
  "cursive", "emoji", "fangsong", "fantasy", "math", "monospace", "sans-serif", "serif",
  "system-ui", "ui-monospace", "ui-rounded", "ui-sans-serif", "ui-serif"
]);

/**
 * The typeface to draw a run in.
 *
 * A web capture measures the text and records the family the browser actually
 * used, so there is one answer and it is right. A SwiftUI capture reports the
 * font by name and cannot resolve it — the app is not running in a browser —
 * so it hands over the stack it would ask for, and the stack is used as CSS
 * was designed to use it.
 *
 * Reaching only for the resolved name left every SwiftUI run with no family at
 * all: it inherited whatever the surrounding page happened to use, measured
 * wider than SwiftUI had measured it, and a heading that fits on one line in
 * the app wrapped onto two everywhere the layers were drawn.
 */
function fontFamilyOf(style) {
  if (style.resolvedFontFamily) return `"${style.resolvedFontFamily}", sans-serif`;
  const families = (Array.isArray(style.fontFamilies) ? style.fontFamilies : [])
    .filter((family) => typeof family === "string" && family.trim())
    .map((family) => family.trim());
  if (families.length === 0) return undefined;
  // A keyword must not be quoted; quoted, it names a font nobody has.
  const written = families.map((family) =>
    GENERIC_FAMILIES.has(family.toLowerCase()) || family.startsWith("-") ? family : `"${family}"`);
  if (!GENERIC_FAMILIES.has(families[families.length - 1].toLowerCase())) written.push("sans-serif");
  return written.join(", ");
}

/**
 * One layer as an element to draw: a tag, a style, and either text, a source or
 * children. Styles are camelCase, which React takes as it is and the HTML
 * writer turns into CSS.
 */
export function paintLayer(layer) {
  const style = layer.style ?? {};
  const transforms = [];
  if (Number(style.rotation)) transforms.push(`rotate(${Number(style.rotation)}deg)`);
  if (style.flipX === true) transforms.push("scaleX(-1)");
  if (style.flipY === true) transforms.push("scaleY(-1)");
  const box = {
    height: px(layer.height),
    left: px(layer.x),
    opacity: style.opacity,
    position: "absolute",
    top: px(layer.y),
    transform: transforms.length > 0 ? transforms.join(" ") : undefined,
    transformOrigin: "center",
    visibility: style.visible === false ? "hidden" : undefined,
    width: px(layer.width)
  };

  if (layer.kind === "image" && layer.dataUrl) {
    return { children: [], src: layer.dataUrl, style: { ...box, objectFit: "cover" }, tag: "img" };
  }

  if (layer.kind === "svg" && layer.svg) {
    return { children: [], src: svgSource(layer.svg), style: box, tag: "img" };
  }

  if (layer.kind === "text") {
    return {
      children: [],
      style: {
        ...box,
        // Text is laid out, not boxed: it is placed where the line box starts
        // and allowed to run to its own height, or a wrapped heading is clipped
        // at the height one line happened to measure.
        color: style.fillVisible === false ? "transparent" : style.color,
        fontFamily: fontFamilyOf(style),
        fontSize: px(style.fontSize),
        fontWeight: style.fontWeight,
        height: undefined,
        left: px(layer.layoutX ?? layer.x),
        letterSpacing: px(style.letterSpacing),
        lineHeight: px(style.lineHeight),
        overflowWrap: "break-word",
        textAlign: style.textAlign,
        textTransform: style.textCase && style.textCase !== "none" ? style.textCase : undefined,
        // A run the capture measured as one line is drawn as one line. The
        // box is the width that run took in the app, and no two text engines
        // agree to the pixel — so a heading that fitted exactly wrapped onto a
        // second line here, which is a worse lie than a line one pixel wide
        // than its box.
        whiteSpace: style.whiteSpace === "nowrap" || measuredOneLine(layer, style) ? "nowrap" : "pre-wrap",
        width: px(layer.layoutWidth ?? layer.width)
      },
      tag: "div",
      text: layer.text ?? ""
    };
  }

  const { boxShadow, drawnShadow } = shadowOf(style, boxIsDrawn(style));
  return {
    children: layer.children ?? [],
    style: {
      ...box,
      ...borderOf(style),
      backdropFilter: backdropOf(style),
      boxShadow,
      filter: filterOf(style, drawnShadow),
      background: style.fillVisible === false ? "transparent" : style.backgroundColor,
      borderRadius: px(style.borderRadius),
      overflow: style.clipsContent ? "hidden" : undefined
    },
    tag: "div"
  };
}

/** camelCase style entries as a CSS declaration list, for writing to HTML. */
export function styleText(style) {
  return Object.entries(style)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([property, value]) => `${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}:${value}`)
    .join(";");
}
