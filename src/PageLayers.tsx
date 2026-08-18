import type { CSSProperties } from "react";

/**
 * Draws a captured page from its layer tree.
 *
 * The alternative was embedding the captured markup — a whole foreign document
 * per page, carrying its own stylesheet, fonts and scripts. That is faithful to
 * the browser, which sounds right and is the wrong thing to be faithful to: the
 * deliverable is Figma layers, and layers is what this draws. A gradient or a
 * ::before that never reached the capture is absent here too, which is how
 * someone finds out before opening Figma rather than after.
 *
 * One template, any project. What differs between projects is the data.
 */

type Layer = {
  kind: "element" | "text" | "svg" | "image";
  id: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  svg?: string;
  dataUrl?: string;
  layoutWidth?: number;
  layoutX?: number;
  style?: Record<string, unknown>;
  children?: Layer[];
};

const px = (value: unknown) => (typeof value === "number" ? `${value}px` : undefined);

/** Borders are captured per side; Figma keeps one, and so does this. */
function borderOf(style: Record<string, unknown>): CSSProperties {
  const sides = [
    [style.borderTopWidth, style.borderTopColor],
    [style.borderRightWidth, style.borderRightColor],
    [style.borderBottomWidth, style.borderBottomColor],
    [style.borderLeftWidth, style.borderLeftColor]
  ] as Array<[unknown, unknown]>;
  const found = sides.find(([width]) => typeof width === "number" && width > 0);
  return found ? { border: `${found[0]}px solid ${found[1]}` } : {};
}

function shadowOf(style: Record<string, unknown>): CSSProperties {
  const shadows = style.shadows as Array<Record<string, any>> | undefined;
  if (!shadows?.length) return {};
  return {
    boxShadow: shadows
      .map((shadow) => {
        const { r, g, b, a } = shadow.color ?? {};
        const colour = `rgba(${Math.round((r ?? 0) * 255)}, ${Math.round((g ?? 0) * 255)}, ${Math.round((b ?? 0) * 255)}, ${a ?? 1})`;
        const inset = shadow.type === "INNER_SHADOW" ? "inset " : "";
        return `${inset}${shadow.offset?.x ?? 0}px ${shadow.offset?.y ?? 0}px ${(shadow.radius ?? 0) * 2}px ${shadow.spread ?? 0}px ${colour}`;
      })
      .join(", ")
  };
}

function Node({ layer }: { layer: Layer }) {
  const style = (layer.style ?? {}) as Record<string, any>;
  const box: CSSProperties = {
    position: "absolute",
    left: px(layer.x),
    top: px(layer.y),
    width: px(layer.width),
    height: px(layer.height)
  };

  if (layer.kind === "image" && layer.dataUrl) {
    return <img alt="" src={layer.dataUrl} style={{ ...box, objectFit: "cover" }} />;
  }

  if (layer.kind === "svg" && layer.svg) {
    // As an image, never inline: captured SVG is markup from someone else's
    // page and can carry a script, which an <img> will not run.
    const encoded = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(layer.svg)))}`;
    return <img alt="" src={encoded} style={box} />;
  }

  if (layer.kind === "text") {
    return (
      <div
        style={{
          ...box,
          left: px(layer.layoutX ?? layer.x),
          width: px(layer.layoutWidth ?? layer.width),
          height: undefined,
          color: style.color,
          fontFamily: style.resolvedFontFamily ? `"${style.resolvedFontFamily}", sans-serif` : undefined,
          fontSize: px(style.fontSize),
          fontWeight: style.fontWeight,
          lineHeight: px(style.lineHeight),
          letterSpacing: px(style.letterSpacing),
          textAlign: style.textAlign,
          textTransform: style.textCase && style.textCase !== "none" ? style.textCase : undefined,
          whiteSpace: style.whiteSpace === "nowrap" ? "nowrap" : "pre-wrap",
          overflowWrap: "break-word"
        }}
      >
        {layer.text}
      </div>
    );
  }

  return (
    <div
      style={{
        ...box,
        ...borderOf(style),
        ...shadowOf(style),
        background: style.backgroundColor,
        borderRadius: px(style.borderRadius),
        opacity: style.opacity,
        overflow: style.clipsContent ? "hidden" : undefined
      }}
    >
      {(layer.children ?? []).map((child) => <Node key={child.id} layer={child} />)}
    </div>
  );
}

export function PageLayers({ tree, width, height }: { tree: unknown; width: number; height: number }) {
  if (!tree) return null;
  return (
    <div className="page-layers" style={{ width, height }}>
      <Node layer={tree as Layer} />
    </div>
  );
}
