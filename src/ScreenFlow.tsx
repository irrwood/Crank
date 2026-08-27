import { useEffect, useMemo, useRef, useState } from "react";
import {
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  type Edge,
  type EdgeProps,
  type Node,
  type NodeProps,
  type ReactFlowInstance
} from "@xyflow/react";
import { graphlib, layout } from "@dagrejs/dagre";
import { PanelsTopLeft } from "lucide-react";
import { PageLayers } from "./PageLayers";
import type { DiscoveredPage } from "./types";
import { useT } from "./lib/locale";
import "@xyflow/react/dist/style.css";

/**
 * The scan retains both the links a rendered page exposed and the deterministic
 * clicks used to reach its child states. Screen Flow draws those two kinds of
 * evidence directly. A missing parent stays disconnected because inventing a
 * plausible edge would make the diagram look more complete while making it
 * less true.
 */

type ScreenNodeData = {
  label: string;
  page: DiscoveredPage;
  board: null | {
    height: number;
    scale: number;
    width: number;
  };
};

type ScreenNode = Node<ScreenNodeData, "screen">;
type NavigationEdgeData = { label: string; kind: "route" | "action" };
type NavigationEdge = Edge<NavigationEdgeData, "branch">;

const NODE_HEIGHT = 34;
const MIN_NODE_WIDTH = 96;
const MAX_NODE_WIDTH = 280;
const CANVAS_PADDING = 46;
const FLOW_GAP = 60;
const FLOW_COLUMN_GAP = 96;
const FLOW_COLUMN_HEIGHT = 640;
const BOARD_NODE_WIDTH = 220;
const BOARD_MAX_WIDTH = 198;
const BOARD_MAX_HEIGHT = 248;
const BOARD_FOOTER_HEIGHT = 38;

function boardMetrics(page: DiscoveredPage) {
  const source = page.thumbnail ?? page.layerTree ?? page.vector;
  if (!source?.width || !source.height) {
    return { width: BOARD_MAX_WIDTH, height: 124, scale: 1 };
  }
  const scale = Math.min(BOARD_MAX_WIDTH / source.width, BOARD_MAX_HEIGHT / source.height);
  return {
    width: source.width * scale,
    height: source.height * scale,
    scale
  };
}

function nodeWidth(label: string) {
  // Dagre needs a size before the DOM exists. Latin and CJK glyphs both fit
  // comfortably inside this estimate, and CSS applies the same final width.
  return Math.min(MAX_NODE_WIDTH, Math.max(MIN_NODE_WIDTH, 24 + Array.from(label).length * 8.5));
}

function recipeKey(recipe: DiscoveredPage["recipe"]) {
  return recipe.map((step) => `${step.kind}:${step.locator}`).join(">");
}

function routeKey(value: string) {
  try {
    const parsed = new URL(value, "https://crank.invalid/");
    if (parsed.hash.startsWith("#/")) return parsed.hash.slice(1).replace(/\/$/, "") || "/";
    return `${parsed.pathname.replace(/\/$/, "") || "/"}${parsed.search}`;
  } catch {
    return value.replace(/\/$/, "") || "/";
  }
}

function pageLinks(page: DiscoveredPage) {
  // Read once when the scan was stored. Parsing every page's document here
  // meant holding all of them in the window — five megabytes a page on a real
  // app — for a few hundred bytes of anchors.
  const stored = page.snapshot?.links;
  if (stored) return stored.map((link) => ({ label: link.label, route: routeKey(link.href) }));
  if (!page.snapshot?.html) return [];
  const document = new DOMParser().parseFromString(page.snapshot.html, "text/html");
  return Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]")).map((anchor) => ({
    label: anchor.textContent?.replace(/\s+/g, " ").trim() || "",
    route: routeKey(anchor.getAttribute("href") || "")
  }));
}

/**
 * Directly addressable pages lose their click recipe deliberately, but their
 * rendered source page still contains the link that reached them. Prefer the
 * app root as the navigation trunk; without one, use only a page whose captured
 * links prove it is the strongest common navigation source.
 */
function routeEdges(pages: DiscoveredPage[]): NavigationEdge[] {
  const directPages = pages.filter((page) => page.recipe.length === 0);
  const byRoute = new Map<string, DiscoveredPage>();
  for (const page of directPages) {
    const key = routeKey(page.route);
    if (!byRoute.has(key)) byRoute.set(key, page);
  }

  const candidates = directPages.map((page) => {
    const links = pageLinks(page);
    const targets = new Set(links.map((link) => link.route).filter((route) => byRoute.has(route)));
    targets.delete(routeKey(page.route));
    return { links, page, targetCount: targets.size };
  });
  const root = candidates.find((candidate) => routeKey(candidate.page.route) === "/")
    ?? candidates.slice().sort((a, b) => b.targetCount - a.targetCount)[0];
  if (!root || root.targetCount === 0) return [];

  const linked = new Set<string>();
  return root.links.flatMap((link) => {
    const target = byRoute.get(link.route);
    if (!target || target.id === root.page.id || linked.has(target.id)) return [];
    linked.add(target.id);
    const label = link.label || target.name;
    return [{
      id: `route:${root.page.id}:${target.id}`,
      source: root.page.id,
      target: target.id,
      type: "branch" as const,
      data: { kind: "route" as const, label },
      ariaLabel: `${root.page.name} to ${target.name}: ${label}`
    }];
  });
}

/** The deterministically recorded page one click before this one. */
function parentOf(page: DiscoveredPage, pages: DiscoveredPage[]) {
  if (page.recipe.length === 0) return null;
  const parentRecipe = page.recipe.slice(0, -1);
  const wanted = recipeKey(parentRecipe);
  return pages.find((candidate) => (
    candidate.id !== page.id
    && candidate.route === page.route
    && candidate.recipe.length === parentRecipe.length
    && recipeKey(candidate.recipe) === wanted
  )) ?? null;
}

/**
 * Dagre treats disconnected nodes as free packing material, which let an
 * unrelated route land inside another flow's branch. Keep each observed flow
 * together and stack the groups in scan order so proximity never invents a
 * relationship that capture did not record.
 */
function connectedFlows(nodes: ScreenNode[], edges: NavigationEdge[]) {
  const neighbours = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    neighbours.get(edge.source)?.add(edge.target);
    neighbours.get(edge.target)?.add(edge.source);
  }

  const seen = new Set<string>();
  return nodes.flatMap((seed) => {
    if (seen.has(seed.id)) return [];

    const memberIds = new Set<string>();
    const queue = [seed.id];
    seen.add(seed.id);
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) continue;
      memberIds.add(current);
      for (const neighbour of neighbours.get(current) ?? []) {
        if (seen.has(neighbour)) continue;
        seen.add(neighbour);
        queue.push(neighbour);
      }
    }

    return [{
      nodes: nodes.filter((node) => memberIds.has(node.id)),
      edges: edges.filter((edge) => memberIds.has(edge.source) && memberIds.has(edge.target))
    }];
  });
}

function layoutFlow(nodes: ScreenNode[], edges: NavigationEdge[]) {
  const dagre = new graphlib.Graph();
  dagre.setDefaultEdgeLabel(() => ({}));
  dagre.setGraph({
    rankdir: "LR",
    align: "UL",
    nodesep: nodes.length > 12 ? 38 : 54,
    ranksep: 112,
    edgesep: 20,
    marginx: 0,
    marginy: 0
  });
  for (const node of nodes) {
    dagre.setNode(node.id, {
      width: Number(node.style?.width),
      height: Number(node.style?.height ?? NODE_HEIGHT)
    });
  }
  for (const edge of edges) dagre.setEdge(edge.source, edge.target);
  layout(dagre);

  const geometry = nodes.map((node) => {
    const position = dagre.node(node.id);
    const width = Number(node.style?.width);
    const height = Number(node.style?.height ?? NODE_HEIGHT);
    return {
      node,
      centerX: position.x,
      height,
      width,
      y: position.y - height / 2
    };
  });
  // Dagre aligns the centre of nodes in a rank. With text-only nodes that
  // makes every label start at a different x as its width changes, so a column
  // reads like scattered words and every branch ends in a different place.
  // Snap each rank to the left edge of its widest member; the structure stays
  // Dagre's, while labels and their incoming lines share one visual baseline.
  const rankWidth = new Map<string, number>();
  for (const item of geometry) {
    const rank = item.centerX.toFixed(3);
    rankWidth.set(rank, Math.max(rankWidth.get(rank) ?? 0, item.width));
  }
  const placed = geometry.map((item) => {
    const width = rankWidth.get(item.centerX.toFixed(3)) ?? item.width;
    return {
      ...item.node,
      // Nodes in one rank share both edges, not only their left edge. If a
      // shorter sibling ends early, an edge routed through the inter-column
      // lane can run behind a wider sibling's label. A shared width keeps all
      // source handles on one boundary and leaves that lane genuinely empty.
      style: { ...item.node.style, width },
      position: { x: item.centerX - width / 2, y: item.y }
    };
  });
  const left = Math.min(...placed.map((node) => node.position.x));
  const right = Math.max(...placed.map((node) => node.position.x + Number(node.style?.width)));
  const top = Math.min(...placed.map((node) => node.position.y));
  const bottom = Math.max(...placed.map((node) => (
    node.position.y + Number(node.style?.height ?? NODE_HEIGHT)
  )));

  return {
    height: bottom - top,
    width: right - left,
    nodes: placed.map((node) => ({
      ...node,
      position: { x: node.position.x - left, y: node.position.y - top }
    }))
  };
}

function graphOf(pages: DiscoveredPage[], showBoards: boolean) {
  const nodes: ScreenNode[] = pages.map((page) => {
    const board = showBoards ? boardMetrics(page) : null;
    return {
      id: page.id,
      type: "screen",
      data: { board, label: page.name, page },
      position: { x: 0, y: 0 },
      style: board
        ? { width: BOARD_NODE_WIDTH, height: board.height + BOARD_FOOTER_HEIGHT + 16 }
        : { width: nodeWidth(page.name), height: NODE_HEIGHT }
    };
  });

  const edges: NavigationEdge[] = routeEdges(pages);
  for (const page of pages) {
    const parent = parentOf(page, pages);
    const action = page.recipe.at(-1);
    if (!parent || !action) continue;
    edges.push({
      id: `action:${parent.id}:${page.id}:${action.locator}`,
      source: parent.id,
      target: page.id,
      type: "branch",
      data: { kind: "action", label: action.label || action.locator },
      ariaLabel: `${parent.name} to ${page.name}: ${action.label || action.locator}`
    });
  }

  let columnLeft = CANVAS_PADDING;
  let columnWidth = 0;
  let nextTop = CANVAS_PADDING;
  const placedNodes = connectedFlows(nodes, edges).flatMap((flow) => {
    const placed = layoutFlow(flow.nodes, flow.edges);
    if (nextTop > CANVAS_PADDING && nextTop + placed.height > CANVAS_PADDING + FLOW_COLUMN_HEIGHT) {
      columnLeft += columnWidth + FLOW_COLUMN_GAP;
      columnWidth = 0;
      nextTop = CANVAS_PADDING;
    }
    const result = placed.nodes.map((node) => ({
      ...node,
      position: {
        x: node.position.x + columnLeft,
        y: node.position.y + nextTop
      }
    }));
    columnWidth = Math.max(columnWidth, placed.width);
    nextTop += placed.height + FLOW_GAP;
    return result;
  });

  return {
    edges,
    nodes: placedNodes
  };
}

function ScreenTextNode({ data, selected }: NodeProps<ScreenNode>) {
  const t = useT();
  return (
    <div className={`screen-flow-node${data.board ? " is-board" : ""}${selected ? " is-selected" : ""}`} title={data.page.route}>
      <Handle className="screen-flow-handle" position={Position.Left} type="target" />
      {data.board && (
        <span
          className="screen-flow-board-preview"
          style={{ width: data.board.width, height: data.board.height }}
        >
          {data.page.thumbnail ? (
            <img alt="" draggable={false} src={data.page.thumbnail.dataUrl} />
          ) : data.page.layerTree?.tree ? (
            <span
              className="screen-flow-board-layers"
              style={{ transform: `scale(${data.board.scale})` }}
            >
              <PageLayers
                height={data.page.layerTree.height}
                tree={data.page.layerTree.tree}
                width={data.page.layerTree.width}
              />
            </span>
          ) : (
            <small>{t("inventory.previewUnavailable")}</small>
          )}
        </span>
      )}
      <span>{data.label}</span>
      <Handle className="screen-flow-handle" position={Position.Right} type="source" />
    </div>
  );
}

/**
 * Every sibling uses the same midpoint between its source and target columns.
 * Their overlapping vertical segments become the shared bracket in the visual
 * reference instead of a bundle of separate curves.
 */
function BranchEdge({ id, sourceX, sourceY, targetX, targetY, data, selected }: EdgeProps<NavigationEdge>) {
  // A fixed offset from the parent makes every sibling share exactly one
  // trunk even when their text has different widths and therefore different
  // left edges.
  const trunkX = Math.min(sourceX + 58, targetX - 24);
  const path = `M ${sourceX} ${sourceY} H ${trunkX} V ${targetY} H ${targetX}`;
  const labelX = trunkX + (targetX - trunkX) / 2;
  const showLabel = selected && data?.label;

  return (
    <>
      <BaseEdge
        className={`screen-flow-edge is-${data?.kind ?? "action"}${selected ? " is-selected" : ""}`}
        id={id}
        interactionWidth={18}
        path={path}
      />
      {showLabel && (
        <EdgeLabelRenderer>
          <span
            className={`screen-flow-edge-label${selected ? " is-selected" : ""}`}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${targetY - 15}px)` }}
          >
            {data.label}
          </span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { screen: ScreenTextNode };
const edgeTypes = { branch: BranchEdge };

function isTypingTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (
    target.isContentEditable
    || target.matches("input, textarea, select")
  );
}

function nodeCenter(node: ScreenNode) {
  return {
    x: node.position.x + Number(node.style?.width ?? MIN_NODE_WIDTH) / 2,
    y: node.position.y + Number(node.style?.height ?? NODE_HEIGHT) / 2
  };
}

/** The closest screen in the direction the key points, weighted toward the
 * same row or column so keyboard navigation follows the visible graph. */
function nextNode(nodes: ScreenNode[], selectedId: string, key: string) {
  const current = nodes.find((node) => node.id === selectedId);
  if (!current) return null;
  const from = nodeCenter(current);
  const horizontal = key === "ArrowLeft" || key === "ArrowRight";
  const sign = key === "ArrowLeft" || key === "ArrowUp" ? -1 : 1;

  return nodes
    .filter((node) => node.id !== selectedId)
    .map((node) => {
      const at = nodeCenter(node);
      const primary = horizontal ? at.x - from.x : at.y - from.y;
      const cross = horizontal ? Math.abs(at.y - from.y) : Math.abs(at.x - from.x);
      return { node, primary, score: Math.abs(primary) + cross * 1.6 };
    })
    .filter((candidate) => Math.sign(candidate.primary) === sign)
    .sort((left, right) => left.score - right.score)[0]?.node ?? null;
}

export function ScreenFlow({ pages, onOpen }: {
  pages: DiscoveredPage[];
  onOpen: (page: DiscoveredPage) => void;
}) {
  const t = useT();
  const [showBoards, setShowBoards] = useState(false);
  const graph = useMemo(() => graphOf(pages, showBoards), [pages, showBoards]);
  const graphKey = `${showBoards ? "boards" : "labels"}:${pages.map((page) => page.id).join(":")}`;
  const flow = useRef<ReactFlowInstance<ScreenNode, NavigationEdge> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const nodes = useMemo(() => graph.nodes.map((node) => ({
    ...node,
    selected: node.id === selectedId
  })), [graph.nodes, selectedId]);

  useEffect(() => {
    if (selectedId && !graph.nodes.some((node) => node.id === selectedId)) setSelectedId(null);
  }, [graph.nodes, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target) || !flow.current) return;
      const instance = flow.current;
      const duration = 120;

      if (event.shiftKey && event.code === "Digit1") {
        event.preventDefault();
        void instance.fitView({ padding: 0.18, minZoom: showBoards ? 0.1 : 0.25, maxZoom: 1.1, duration });
        return;
      }
      if (event.shiftKey && event.code === "Digit2" && selectedId) {
        event.preventDefault();
        void instance.fitView({ nodes: [{ id: selectedId }], padding: 0.8, minZoom: 0.45, maxZoom: 1.35, duration });
        return;
      }
      if (event.code === "Digit0" && !event.altKey) {
        event.preventDefault();
        void instance.zoomTo(1, { duration });
        return;
      }
      if (event.key === "+" || ((event.metaKey || event.ctrlKey) && event.key === "=")) {
        event.preventDefault();
        void instance.zoomIn({ duration });
        return;
      }
      if (event.key === "-") {
        event.preventDefault();
        void instance.zoomOut({ duration });
        return;
      }
      if (event.key === "Escape" && selectedId) {
        event.preventDefault();
        setSelectedId(null);
        return;
      }
      if (event.key === "Enter" && selectedId) {
        const selected = graph.nodes.find((node) => node.id === selectedId);
        if (selected) {
          event.preventDefault();
          onOpen(selected.data.page);
        }
        return;
      }
      if (!event.key.startsWith("Arrow")) return;
      event.preventDefault();

      if (selectedId) {
        const next = nextNode(graph.nodes, selectedId, event.key);
        if (!next) return;
        const center = nodeCenter(next);
        setSelectedId(next.id);
        void instance.setCenter(center.x, center.y, { zoom: instance.getZoom(), duration });
        return;
      }

      // Figma pans farther while Shift is held. Viewport x/y are screen pixels,
      // so the distance stays tactile at every zoom level.
      const distance = event.shiftKey ? 160 : 40;
      const viewport = instance.getViewport();
      const x = viewport.x + (event.key === "ArrowLeft" ? distance : event.key === "ArrowRight" ? -distance : 0);
      const y = viewport.y + (event.key === "ArrowUp" ? distance : event.key === "ArrowDown" ? -distance : 0);
      void instance.setViewport({ ...viewport, x, y }, { duration: 80 });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [graph.nodes, onOpen, selectedId, showBoards]);

  return (
    <section className="screen-flow" aria-label={t("inventory.viewFlow")}>
      <div className="screen-flow-canvas">
        <ReactFlow<ScreenNode, NavigationEdge>
          colorMode="light"
          deleteKeyCode={null}
          edges={graph.edges}
          edgesFocusable
          edgeTypes={edgeTypes}
          elementsSelectable
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: showBoards ? 0.1 : 0.45, maxZoom: 1.1 }}
          key={graphKey}
          maxZoom={1.7}
          minZoom={showBoards ? 0.1 : 0.25}
          nodes={nodes}
          nodesConnectable={false}
          nodesDraggable={false}
          nodeTypes={nodeTypes}
          onInit={(instance) => { flow.current = instance; }}
          onNodeClick={(_event, node) => setSelectedId(node.id)}
          onNodeDoubleClick={(_event, node) => onOpen(node.data.page)}
          onPaneClick={() => setSelectedId(null)}
          panActivationKeyCode="Space"
          panOnDrag={[1, 2]}
          panOnScroll
          proOptions={{ hideAttribution: true }}
          zoomActivationKeyCode={["Meta", "Control"]}
          zoomOnDoubleClick={false}
          zoomOnScroll={false}
        >
          <Controls position="bottom-left" showInteractive={false} />
          <Panel className="screen-flow-board-toggle" position="bottom-left">
            <button
              aria-label={t(showBoards ? "inventory.flowHideBoards" : "inventory.flowShowBoards")}
              aria-pressed={showBoards}
              onClick={() => setShowBoards((visible) => !visible)}
              title={t(showBoards ? "inventory.flowHideBoards" : "inventory.flowShowBoards")}
              type="button"
            >
              <PanelsTopLeft size={14} />
            </button>
          </Panel>
        </ReactFlow>
        {graph.edges.length === 0 && pages.length > 1 && (
          <p className="screen-flow-note">{t("inventory.flowNoActions")}</p>
        )}
      </div>
    </section>
  );
}
