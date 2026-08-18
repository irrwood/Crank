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

/**
 * The capture keeps the browser's own shadow string, and this draws to CSS, so
 * it passes straight through. Figma's effect objects are made at the export
 * boundary; reaching for them here cost every shadow in the preview, since the
 * stored tree has never carried them.
 */
function shadowOf(style) {
  const shadow = style.boxShadow;
  return typeof shadow === "string" && shadow && shadow !== "none" ? { boxShadow: shadow } : {};
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

/**
 * One layer as an element to draw: a tag, a style, and either text, a source or
 * children. Styles are camelCase, which React takes as it is and the HTML
 * writer turns into CSS.
 */
export function paintLayer(layer) {
  const style = layer.style ?? {};
  const box = { height: px(layer.height), left: px(layer.x), position: "absolute", top: px(layer.y), width: px(layer.width) };

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
        color: style.color,
        fontFamily: style.resolvedFontFamily ? `"${style.resolvedFontFamily}", sans-serif` : undefined,
        fontSize: px(style.fontSize),
        fontWeight: style.fontWeight,
        height: undefined,
        left: px(layer.layoutX ?? layer.x),
        letterSpacing: px(style.letterSpacing),
        lineHeight: px(style.lineHeight),
        overflowWrap: "break-word",
        textAlign: style.textAlign,
        textTransform: style.textCase && style.textCase !== "none" ? style.textCase : undefined,
        whiteSpace: style.whiteSpace === "nowrap" ? "nowrap" : "pre-wrap",
        width: px(layer.layoutWidth ?? layer.width)
      },
      tag: "div",
      text: layer.text ?? ""
    };
  }

  return {
    children: layer.children ?? [],
    style: {
      ...box,
      ...borderOf(style),
      ...shadowOf(style),
      background: style.backgroundColor,
      borderRadius: px(style.borderRadius),
      opacity: style.opacity,
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
