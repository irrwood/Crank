import { useEffect, useMemo, useRef, useState } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Panel,
  Position,
  ReactFlow,
  reconnectEdge,
  type Connection,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type Node,
  type NodeChange,
  type NodeProps,
  type ReactFlowInstance
} from "@xyflow/react";
import { graphlib, layout } from "@dagrejs/dagre";
import { Check, ClipboardCopy, ExternalLink, PanelsTopLeft, RotateCcw, Sparkles, X } from "lucide-react";
import { PageLayers } from "./PageLayers";
import type { DiscoveredPage } from "./types";
import { useT } from "./lib/locale";
import {
  buildChangeManifest,
  buildCodexFlowPrompt,
  diffAppGraphs,
  diffCount,
  type AppGraph
} from "../shared/app-graph.js";
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
type NavigationEdgeData = {
  label: string;
  kind: "route" | "action" | "proposed";
  status: "observed" | "proposed" | "modified";
};
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
      data: { kind: "route" as const, label, status: "observed" as const },
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
      deletable: false,
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
      data: { kind: "action", label: action.label || action.locator, status: "observed" },
      ariaLabel: `${parent.name} to ${page.name}: ${action.label || action.locator}`
    });
  }

  return { edges, nodes: placeNodes(nodes, edges) };
}

function placeNodes(nodes: ScreenNode[], edges: NavigationEdge[]) {
  let columnLeft = CANVAS_PADDING;
  let columnWidth = 0;
  let nextTop = CANVAS_PADDING;
  return connectedFlows(nodes, edges).flatMap((flow) => {
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
        className={`screen-flow-edge is-${data?.kind ?? "action"} is-${data?.status ?? "observed"}${selected ? " is-selected" : ""}`}
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

function appGraphOf(
  pages: DiscoveredPage[],
  edges: NavigationEdge[],
  projectName: string,
  projectRoot: string | null
): AppGraph {
  return {
    version: 1,
    project: { name: projectName, ...(projectRoot ? { root: projectRoot } : {}) },
    screens: pages.map((page) => ({
      id: page.id,
      name: page.name,
      route: page.route,
      status: "observed"
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      fromScreenId: edge.source,
      toScreenId: edge.target,
      status: edge.data?.status ?? "observed",
      trigger: {
        type: edge.data?.kind === "route" ? "route" : edge.data?.kind === "action" ? "click" : "unknown",
        ...(edge.data?.label ? { label: edge.data.label } : {})
      }
    })),
    groups: [],
    annotations: []
  };
}

function sameEndpoints(left: NavigationEdge, right: Pick<NavigationEdge, "source" | "target">) {
  return left.source === right.source && left.target === right.target;
}

export function ScreenFlow({ pages, onOpen, projectName, projectRoot }: {
  pages: DiscoveredPage[];
  onOpen: (page: DiscoveredPage) => void;
  projectName: string;
  projectRoot: string | null;
}) {
  const t = useT();
  // Screens, not names. The flow is a picture of an application, and a column
  // of labels asks the reader to remember which screen each one was — which is
  // the thing they opened this view to see.
  const [showBoards, setShowBoards] = useState(true);
  const observedVisual = useMemo(() => graphOf(pages, false), [pages]);
  const [intentNodes, setIntentNodes] = useState<ScreenNode[]>(() => graphOf(pages, true).nodes);
  const [intentEdges, setIntentEdges] = useState<NavigationEdge[]>(() => graphOf(pages, true).edges);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const flow = useRef<ReactFlowInstance<ScreenNode, NavigationEdge> | null>(null);
  const pagesKey = pages.map((page) => `${page.id}:${page.signature}`).join("|");

  const observedGraph = useMemo(
    () => appGraphOf(pages, observedVisual.edges, projectName, projectRoot),
    [observedVisual.edges, pages, projectName, projectRoot]
  );
  const intentGraph = useMemo(
    () => appGraphOf(pages, intentEdges, projectName, projectRoot),
    [intentEdges, pages, projectName, projectRoot]
  );
  const graphDiff = useMemo(() => diffAppGraphs(observedGraph, intentGraph), [intentGraph, observedGraph]);
  const changeCount = diffCount(graphDiff);
  const manifest = useMemo(
    () => buildChangeManifest(observedGraph, intentGraph),
    [intentGraph, observedGraph]
  );
  const codexPrompt = useMemo(
    () => buildCodexFlowPrompt(observedGraph, intentGraph, manifest),
    [intentGraph, manifest, observedGraph]
  );

  const nodes = useMemo(() => intentNodes.map((node) => ({
    ...node,
    selected: node.id === selectedId
  })), [intentNodes, selectedId]);
  const edges = useMemo(() => intentEdges.map((edge) => {
    const observed = observedVisual.edges.find((candidate) => candidate.id === edge.id);
    const status: NavigationEdgeData["status"] = observed
      ? sameEndpoints(observed, edge) ? "observed" : "modified"
      : observedVisual.edges.some((candidate) => sameEndpoints(candidate, edge)) ? "observed" : "proposed";
    return {
      ...edge,
      data: {
        kind: edge.data?.kind ?? "proposed",
        label: edge.data?.label ?? "",
        status
      },
      selected: edge.id === selectedEdgeId
    };
  }), [intentEdges, observedVisual.edges, selectedEdgeId]);

  // A new scan is new evidence and therefore a new immutable observed graph.
  // Canvas display changes do not enter this effect, so toggling previews never
  // discards a manually arranged intent graph.
  useEffect(() => {
    const next = graphOf(pages, showBoards);
    setIntentNodes(next.nodes);
    setIntentEdges(next.edges);
    setSelectedId(null);
    setSelectedEdgeId(null);
    setReviewOpen(false);
  // pagesKey is the stable capture identity; the array itself is renderer state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pagesKey]);

  useEffect(() => {
    const fresh = graphOf(pages, showBoards).nodes;
    setIntentNodes((current) => {
      const positions = new Map(current.map((node) => [node.id, node.position]));
      return fresh.map((node) => ({ ...node, position: positions.get(node.id) ?? node.position }));
    });
  // Page changes are handled above; this effect exists only for preview size.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showBoards]);

  useEffect(() => {
    if (selectedId && !intentNodes.some((node) => node.id === selectedId)) setSelectedId(null);
    if (selectedEdgeId && !intentEdges.some((edge) => edge.id === selectedEdgeId)) setSelectedEdgeId(null);
  }, [intentEdges, intentNodes, selectedEdgeId, selectedId]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      if (event.key === "Escape" && reviewOpen) {
        event.preventDefault();
        setReviewOpen(false);
        return;
      }
      if (!flow.current) return;
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
      if (event.key === "Escape" && (selectedId || selectedEdgeId)) {
        event.preventDefault();
        setSelectedId(null);
        setSelectedEdgeId(null);
        return;
      }
      if (event.key === "Enter" && selectedId) {
        const selected = intentNodes.find((node) => node.id === selectedId);
        if (selected) {
          event.preventDefault();
          onOpen(selected.data.page);
        }
        return;
      }
      if (!event.key.startsWith("Arrow")) return;
      event.preventDefault();

      if (selectedId) {
        const next = nextNode(intentNodes, selectedId, event.key);
        if (!next) return;
        const center = nodeCenter(next);
        setSelectedId(next.id);
        void instance.setCenter(center.x, center.y, { zoom: instance.getZoom(), duration });
        return;
      }

      const distance = event.shiftKey ? 160 : 40;
      const viewport = instance.getViewport();
      const x = viewport.x + (event.key === "ArrowLeft" ? distance : event.key === "ArrowRight" ? -distance : 0);
      const y = viewport.y + (event.key === "ArrowUp" ? distance : event.key === "ArrowDown" ? -distance : 0);
      void instance.setViewport({ ...viewport, x, y }, { duration: 80 });
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [intentNodes, onOpen, reviewOpen, selectedEdgeId, selectedId, showBoards]);

  const onNodesChange = (changes: NodeChange<ScreenNode>[]) => {
    setIntentNodes((current) => applyNodeChanges(changes, current));
  };

  const onEdgesChange = (changes: EdgeChange<NavigationEdge>[]) => {
    if (changes.some((change) => change.type === "remove" && change.id === selectedEdgeId)) {
      setSelectedEdgeId(null);
    }
    setIntentEdges((current) => applyEdgeChanges(changes, current));
  };

  const onConnect = (connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    setIntentEdges((current) => {
      if (current.some((edge) => sameEndpoints(edge, connection))) return current;
      const observed = observedVisual.edges.find((edge) => sameEndpoints(edge, connection));
      if (observed) return [...current, { ...observed }];
      return addEdge<NavigationEdge>({
        ...connection,
        id: `proposed:${connection.source}:${connection.target}:${Date.now()}`,
        type: "branch",
        data: { kind: "proposed", label: "", status: "proposed" },
        ariaLabel: `${connection.source} to ${connection.target}`
      }, current);
    });
  };

  const onReconnect = (oldEdge: NavigationEdge, connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    setIntentEdges((current) => reconnectEdge(
      oldEdge,
      connection,
      current.map((edge) => edge.id === oldEdge.id
        ? {
            ...edge,
            data: {
              kind: edge.data?.kind ?? "proposed",
              label: edge.data?.label ?? "",
              status: "modified"
            }
          }
        : edge)
    ));
  };

  const resetIntent = () => {
    const next = graphOf(pages, showBoards);
    setIntentNodes(next.nodes);
    setIntentEdges(next.edges);
    setSelectedId(null);
    setSelectedEdgeId(null);
  };

  const autoLayout = () => {
    setIntentNodes((current) => placeNodes(
      current.map((node) => ({ ...node, position: { x: 0, y: 0 } })),
      intentEdges
    ));
    window.setTimeout(() => {
      void flow.current?.fitView({ padding: 0.18, minZoom: showBoards ? 0.1 : 0.25, maxZoom: 1.1, duration: 160 });
    }, 0);
  };

  const copyInstructions = async () => {
    await window.uiSync?.copyText?.(codexPrompt);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const implementWithCodex = async () => {
    if (!projectRoot || !window.uiSync?.openFlowChangeInCodex) return;
    setHandoffError(null);
    try {
      await window.uiSync.openFlowChangeInCodex(projectRoot, codexPrompt);
      setReviewOpen(false);
    } catch (error) {
      setHandoffError(error instanceof Error ? error.message : t("flow.codexOpenFailed"));
    }
  };

  return (
    <section className="screen-flow" aria-label={t("inventory.viewFlow")}>
      <header className="screen-flow-header">
        <div className="screen-flow-title">
          <strong>{projectName}</strong>
          <small>{t("flow.intentHint")}</small>
        </div>
        <div className="screen-flow-actions">
          <button className="flow-tool-button" onClick={autoLayout} title={t("flow.autoLayout")} type="button">
            <Sparkles size={13} /> {t("flow.autoLayout")}
          </button>
          <button className="flow-tool-button" disabled={changeCount === 0} onClick={resetIntent} title={t("flow.reset")} type="button">
            <RotateCcw size={13} /> {t("flow.reset")}
          </button>
          <button className="flow-apply-button" disabled={changeCount === 0} onClick={() => setReviewOpen(true)} type="button">
            {changeCount > 0 ? t("flow.applyCount", { count: changeCount }) : t("flow.applyChanges")}
          </button>
        </div>
      </header>
      <div className="screen-flow-canvas">
        <ReactFlow<ScreenNode, NavigationEdge>
          colorMode="light"
          deleteKeyCode={["Backspace", "Delete"]}
          edges={edges}
          edgesFocusable
          edgesReconnectable
          edgeTypes={edgeTypes}
          elementsSelectable
          fitView
          fitViewOptions={{ padding: 0.18, minZoom: showBoards ? 0.1 : 0.45, maxZoom: 1.1 }}
          maxZoom={1.7}
          minZoom={showBoards ? 0.1 : 0.25}
          nodes={nodes}
          nodesConnectable
          nodesDraggable
          nodeTypes={nodeTypes}
          onConnect={onConnect}
          onEdgesChange={onEdgesChange}
          onEdgeClick={(_event, edge) => { setSelectedEdgeId(edge.id); setSelectedId(null); }}
          onInit={(instance) => { flow.current = instance; }}
          onNodeClick={(_event, node) => { setSelectedId(node.id); setSelectedEdgeId(null); }}
          onNodeDoubleClick={(_event, node) => onOpen(node.data.page)}
          onNodesChange={onNodesChange}
          onPaneClick={() => { setSelectedId(null); setSelectedEdgeId(null); }}
          onReconnect={onReconnect}
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
        {intentEdges.length === 0 && pages.length > 1 && (
          <p className="screen-flow-note">{t("inventory.flowNoActions")}</p>
        )}
        <p className="screen-flow-edit-hint">{t("flow.editHint")}</p>
      </div>

      {reviewOpen && (
        <div className="flow-review-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setReviewOpen(false); }}>
          <section aria-label={t("flow.reviewTitle")} aria-modal="true" className="flow-review" role="dialog">
            <header>
              <div>
                <strong>{t("flow.reviewTitle")}</strong>
                <small>{t("flow.reviewCount", { count: manifest.changes.length })}</small>
              </div>
              <button aria-label={t("common.close")} onClick={() => setReviewOpen(false)} type="button"><X size={14} /></button>
            </header>
            <p>{manifest.summary}</p>
            {manifest.changes.length > 1 && (
              <ol>
                {manifest.changes.map((change, index) => <li key={`${change.type}-${index}`}>{change.description}</li>)}
              </ol>
            )}
            <details className="flow-manifest-json">
              <summary>{t("flow.showManifest")}</summary>
              <pre>{JSON.stringify(manifest, null, 2)}</pre>
            </details>
            {!projectRoot && <small className="flow-review-note">{t("flow.copyOnly")}</small>}
            {handoffError && <small className="flow-review-error">{handoffError}</small>}
            <footer>
              <button className="secondary-button" onClick={() => void copyInstructions()} type="button">
                {copied ? <Check size={14} /> : <ClipboardCopy size={14} />}
                {t(copied ? "flow.copied" : "flow.copyInstructions")}
              </button>
              {projectRoot && (
                <button className="primary-button" onClick={() => void implementWithCodex()} type="button">
                  <ExternalLink size={14} /> {t("flow.implementWithCodex")}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
