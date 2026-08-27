import type { CSSProperties } from "react";
import { paintLayer } from "../shared/layer-paint.js";

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
 *
 * What a layer looks like is decided in shared/layer-paint.js, because an
 * exported handoff file draws the same trees in Node and the two must agree.
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

function Node({ allowOverflow, hiddenLayerId, layer }: { allowOverflow: boolean; hiddenLayerId?: string | null; layer: Layer }) {
  const painted = paintLayer(layer);
  const style = {
    ...(painted.style as CSSProperties),
    // A captured page must preserve clipping in previews and exports, but the
    // scene editor is a workspace rather than the page at runtime. Leaving a
    // captured overflow mask active there made a layer disappear the moment it
    // crossed its old parent, so it could neither be detached nor dragged back.
    ...(allowOverflow ? { overflow: "visible" } : {}),
    visibility: layer.id === hiddenLayerId ? "hidden" : (painted.style as CSSProperties).visibility
  } as CSSProperties;

  if (painted.tag === "img") return <img alt="" src={painted.src} style={style} />;

  return (
    <div style={style}>
      {painted.text ?? (painted.children as Layer[]).map((child) => <Node allowOverflow={allowOverflow} hiddenLayerId={hiddenLayerId} key={child.id} layer={child} />)}
    </div>
  );
}

export function PageLayers({ tree, width, height, allowOverflow = false, hiddenLayerId = null }: { tree: unknown; width: number; height: number; allowOverflow?: boolean; hiddenLayerId?: string | null }) {
  if (!tree) return null;
  return (
    <div className="page-layers" style={{ width, height }}>
      <Node allowOverflow={allowOverflow} hiddenLayerId={hiddenLayerId} layer={tree as Layer} />
    </div>
  );
}
