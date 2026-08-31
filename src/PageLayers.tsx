import type { CSSProperties, MouseEvent } from "react";
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
  source?: string;
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

export type PageLayerSelection = {
  id: string;
  name?: string;
  source?: string;
  clientPoint?: { x: number; y: number };
  point?: { x: number; y: number };
  boundingBox?: { x: number; y: number; width: number; height: number };
};

function Node({ allowOverflow, hiddenLayerId, layer, onSelectLayer, selectedLayerId }: {
  allowOverflow: boolean;
  hiddenLayerId?: string | null;
  layer: Layer;
  onSelectLayer?: (selection: PageLayerSelection) => void;
  selectedLayerId?: string | null;
}) {
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

  const selection = { id: layer.id, name: layer.name, source: layer.source };
  const selectable = Boolean(onSelectLayer);
  const className = `${selectable ? "page-layer--selectable" : ""}${selectedLayerId === layer.id ? " is-crank-selected" : ""}`.trim();
  const select = selectable ? (event: MouseEvent) => {
    event.stopPropagation();
    const page = event.currentTarget.closest(".page-layers");
    const pageBox = page?.getBoundingClientRect();
    const layerBox = event.currentTarget.getBoundingClientRect();
    const geometry = pageBox && pageBox.width > 0 && pageBox.height > 0 ? {
      clientPoint: { x: event.clientX, y: event.clientY },
      point: {
        x: Math.min(1, Math.max(0, (event.clientX - pageBox.left) / pageBox.width)),
        y: Math.min(1, Math.max(0, (event.clientY - pageBox.top) / pageBox.height))
      },
      boundingBox: {
        x: Math.min(1, Math.max(0, (layerBox.left - pageBox.left) / pageBox.width)),
        y: Math.min(1, Math.max(0, (layerBox.top - pageBox.top) / pageBox.height)),
        width: Math.min(1, Math.max(0, layerBox.width / pageBox.width)),
        height: Math.min(1, Math.max(0, layerBox.height / pageBox.height))
      }
    } : {};
    onSelectLayer?.({ ...selection, ...geometry });
  } : undefined;

  const identity = {
    "data-crank-id": layer.id,
    "data-crank-layer-id": layer.id,
    ...(layer.source ? { "data-source": layer.source } : {}),
    ...(layer.name ? { "data-component": layer.name } : {})
  };

  if (painted.tag === "img") return <img alt="" className={className} {...identity} onClick={select} src={painted.src} style={style} />;

  return (
    <div className={className} {...identity} onClick={select} style={style}>
      {painted.text ?? (painted.children as Layer[]).map((child) => <Node
        allowOverflow={allowOverflow}
        hiddenLayerId={hiddenLayerId}
        key={child.id}
        layer={child}
        onSelectLayer={onSelectLayer}
        selectedLayerId={selectedLayerId}
      />)}
    </div>
  );
}

export function PageLayers({ tree, width, height, allowOverflow = false, hiddenLayerId = null, onSelectLayer, selectedLayerId = null }: {
  tree: unknown;
  width: number;
  height: number;
  allowOverflow?: boolean;
  hiddenLayerId?: string | null;
  onSelectLayer?: (selection: PageLayerSelection) => void;
  selectedLayerId?: string | null;
}) {
  if (!tree) return null;
  return (
    <div className="page-layers" style={{ width, height }}>
      <Node allowOverflow={allowOverflow} hiddenLayerId={hiddenLayerId} layer={tree as Layer} onSelectLayer={onSelectLayer} selectedLayerId={selectedLayerId} />
    </div>
  );
}
