import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BaseEdge,
  ConnectionMode,
  Controls,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getSmoothStepPath,
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
import { diffAppGraphs, diffCount, reconnectIntentEdge } from "../../shared/app-graph.js";
import { layoutScreenPositions, type FlowLayoutStyle } from "../../shared/flow-layout.js";
import { fitPageToViewport, measureAtViewportSettlingPoints } from "../../shared/page-viewport.js";
import { PageLayers, type PageLayerSelection } from "../../src/PageLayers";
import { useLocale, useT } from "../../src/lib/locale";
import {
  copyForPaper,
  drawInPaper,
  figmaSendResult,
  initialHostLayout,
  initialPayload,
  loadFigmaSyncStatus,
  loadJob,
  loadPageDocument,
  loadPagePreview,
  openRepositoryCanvas,
  onHostLayoutChange,
  onToolPayload,
  openReviewInCodex,
  prepareReview,
  requestFullscreen,
  saveCanvasState,
  startRepositoryRescan,
  startFigmaSend,
  updateModelContext
} from "./bridge";
import type { AppGraph, CanvasPayload, CanvasSelection, CrankVisualAnnotation, FigmaSendResult, FigmaSyncStatus, GraphEdge, GraphScreen, PageDocumentState, ScreenPreview, SourceRef } from "./types";
import "@xyflow/react/dist/style.css";

/**
 * This is the MCP Apps adapter for Crank's existing Screen Flow. The semantic
 * graph comes from the same shared inventory and diff modules as Electron;
 * previews are the captured pages themselves, read through the MCP bridge so
 * the iframe never depends on Electron's local asset protocol.
 */

type FlowNodeData = {
  screen: GraphScreen;
  sequence?: number;
  preview?: ScreenPreview;
  showPreview?: boolean;
  openScreen?: (id: string) => void;
};
type FlowNode = Node<FlowNodeData, "screen">;
type FlowEdge = Edge<{ graphEdge: GraphEdge }, "crank">;
const COMPACT_NODE = { width: 176, height: 44 };
const PREVIEW_NODE = { width: 216, height: 210 };
const COMPACT_MIN_ZOOM = 0.2;
const PREVIEW_MIN_ZOOM = 0.58;
const FLOW_LAYOUT_VERSION = 2;
const AUTO_LAYOUT_STYLES: FlowLayoutStyle[] = ["vertical", "grid", "flow"];
const AUTO_LAYOUT_LABELS = {
  flow: "flow.layoutSmart",
  vertical: "flow.layoutVertical",
  grid: "flow.layoutGrid"
} as const;

function savedLayout(payload: CanvasPayload | null) {
  return payload?.scene.layoutVersion === FLOW_LAYOUT_VERSION ? payload.scene.nodes : [];
}

const samplePayload: CanvasPayload = {
  inventoryId: "0123456789abcdef",
  observedGraph: {
    version: 1,
    project: { name: "Crank sample", inventoryId: "0123456789abcdef" },
    screens: [
      { id: "dashboard", name: "Dashboard", route: "/", status: "observed" },
      { id: "amount", name: "Amount", route: "/transfer", status: "observed" },
      { id: "review", name: "Review", route: "/transfer/review", status: "observed" }
    ],
    edges: [
      { id: "dashboard-amount", fromScreenId: "dashboard", toScreenId: "amount", status: "observed", trigger: { type: "click", label: "Transfer" } },
      { id: "amount-review", fromScreenId: "amount", toScreenId: "review", status: "observed", trigger: { type: "submit", label: "Continue" } }
    ],
    groups: [], annotations: []
  },
  intentGraph: {
    version: 1,
    project: { name: "Crank sample", inventoryId: "0123456789abcdef" },
    screens: [
      { id: "dashboard", name: "Dashboard", route: "/", status: "observed" },
      { id: "amount", name: "Amount", route: "/transfer", status: "observed" },
      { id: "review", name: "Review", route: "/transfer/review", status: "observed" }
    ],
    edges: [
      { id: "dashboard-amount", fromScreenId: "dashboard", toScreenId: "amount", status: "observed", trigger: { type: "click", label: "Transfer" } },
      { id: "amount-review", fromScreenId: "amount", toScreenId: "review", status: "observed", trigger: { type: "submit", label: "Continue" } }
    ],
    groups: [], annotations: []
  },
  scene: {
    version: 1, layoutVersion: FLOW_LAYOUT_VERSION, stateVersion: 0, inventoryId: "0123456789abcdef", view: "map", showPreviews: true,
    nodes: [], selection: null, updatedAt: "2026-01-01T00:00:00.000Z"
  },
  stateVersion: 0,
  exportSettings: { figmaUrl: null }
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function layoutGraph(graph: AppGraph, withPreviews = true, saved: Array<{ id: string; x: number; y: number }> = [], style: FlowLayoutStyle = "flow") {
  const size = withPreviews ? PREVIEW_NODE : COMPACT_NODE;
  const positions = new Map(layoutScreenPositions(
    graph.screens.map((screen) => screen.id),
    graph.edges,
    {
      ...size,
      ranksep: withPreviews ? 130 : 110,
      nodesep: withPreviews ? 74 : 54,
      marginx: 42,
      marginy: 42,
      style,
      maxRankRows: withPreviews ? 3 : 6
    }
  ).map((position) => [position.id, position]));
  const savedPositions = new Map(saved.map((position) => [position.id, position]));
  return graph.screens.map<FlowNode>((screen) => {
    const point = savedPositions.get(screen.id) ?? positions.get(screen.id) ?? { x: 0, y: 0 };
    return {
      id: screen.id,
      type: "screen",
      position: { x: point.x, y: point.y },
      data: { screen }
    };
  });
}

function sourceRefFromAnchor(value?: string): SourceRef | null {
  const match = /^(.+):(\d+):(\d+)$/.exec(value ?? "");
  return match ? { file: match[1], line: Number(match[2]), column: Number(match[3]) } : null;
}

const HANDLE_POSITIONS = {
  top: Position.Top,
  right: Position.Right,
  bottom: Position.Bottom,
  left: Position.Left
} as const;

function edgeHandles(source?: FlowNode, target?: FlowNode) {
  if (!source || !target) return {};
  const dx = target.position.x - source.position.x;
  const dy = target.position.y - source.position.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0
    ? { sourceHandle: "right", targetHandle: "left" }
    : { sourceHandle: "left", targetHandle: "right" };
  return dy >= 0
    ? { sourceHandle: "bottom", targetHandle: "top" }
    : { sourceHandle: "top", targetHandle: "bottom" };
}

function graphEdges(graph: AppGraph, nodes: FlowNode[] = []): FlowEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return graph.edges.map((edge) => ({
    id: edge.id,
    source: edge.fromScreenId,
    target: edge.toScreenId,
    className: `is-${edge.status}`,
    label: edge.trigger?.label || edge.condition || "",
    data: { graphEdge: edge },
    type: "crank",
    ...edgeHandles(byId.get(edge.fromScreenId), byId.get(edge.toScreenId)),
    interactionWidth: 36,
    style: {
      stroke: edge.status === "proposed"
        ? "var(--crank-edge-proposed)"
        : edge.status === "modified"
          ? "var(--crank-edge-modified)"
          : "var(--crank-edge-observed)",
      strokeWidth: 1.7
    },
    markerEnd: {
      type: MarkerType.ArrowClosed,
      color: edge.status === "proposed"
        ? "var(--crank-edge-proposed)"
        : edge.status === "modified"
          ? "var(--crank-edge-modified)"
          : "var(--crank-edge-observed)"
    }
  }));
}

function FlowTransitionEdge({
  id,
  interactionWidth,
  label,
  markerEnd,
  selected,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY
}: EdgeProps<FlowEdge>) {
  const [path, labelX, labelY] = getSmoothStepPath({
    borderRadius: 12,
    offset: 30,
    sourcePosition,
    sourceX,
    sourceY,
    targetPosition,
    targetX,
    targetY
  });
  return <>
    <BaseEdge id={id} interactionWidth={interactionWidth} markerEnd={markerEnd} path={path} style={style} />
    {selected && label && <EdgeLabelRenderer>
      <div
        className="flow-edge-label nodrag nopan"
        style={{ transform: `translate(-50%, calc(-100% - 8px)) translate(${labelX}px, ${labelY}px)` }}
        title={String(label)}
      >{label}</div>
    </EdgeLabelRenderer>}
  </>;
}

const edgeTypes = { crank: FlowTransitionEdge };

function Preview({ preview }: { preview?: ScreenPreview }) {
  const t = useT();
  if (preview?.state === "ready") return <img alt={t("codex.previewAlt")} draggable={false} src={preview.dataUrl} />;
  if (preview?.state === "error") return <small>{t("inventory.previewUnavailable")}</small>;
  return <small>{t("codex.previewLoading")}</small>;
}

function ScreenNode({ data, selected }: NodeProps<FlowNode>) {
  const t = useT();
  const { preview, screen, showPreview } = data;
  const route = screen.route?.trim();
  const visibleRoute = route === "/" ? "" : route;
  const sequence = data.sequence ? String(data.sequence).padStart(2, "0") : "";
  const identity = <div className="screen-node__footer">
    <span aria-hidden="true" className="screen-node__status" />
    <div className="screen-node__copy">
      <div className="screen-node__heading">
        {sequence && <span className="screen-node__index">{sequence}</span>}
        <strong title={screen.name}>{screen.name}</strong>
      </div>
      {visibleRoute && <small title={visibleRoute}>{visibleRoute}</small>}
    </div>
  </div>;
  return <div className={`screen-node screen-node--${screen.status}${showPreview ? " is-preview" : ""}${selected ? " is-selected" : ""}`}>
    {Object.entries(HANDLE_POSITIONS).map(([id, position]) => <Handle id={id} key={id} type="source" position={position} />)}
    {showPreview && identity}
    {showPreview && <button
      aria-label={t("codex.openScreen", { name: screen.name })}
      className="screen-node__preview"
      onClick={(event) => { event.stopPropagation(); data.openScreen?.(screen.id); }}
      onPointerDown={(event) => event.stopPropagation()}
      type="button"
    ><Preview preview={preview} /></button>}
    {!showPreview && identity}
  </div>;
}

// React Flow treats a new node-types object as a renderer replacement. Keeping
// this stable prevents card interaction state from being remounted when the
// surrounding canvas updates.
const nodeTypes = { screen: ScreenNode };

// One shared value: a fresh literal per render would restart the viewer's
// measuring for as long as the document takes to load.
const LOADING_DOCUMENT: PageDocumentState = { state: "loading" };

function PageDocumentViewer({ annotations, documentState, screen, position, total, onAddAnnotation, onBackToMap, onDeleteAnnotation, onMove, onOpenCodexReview, onSelectLayer, selectedLayerId, viewportRevision }: {
  annotations: CrankVisualAnnotation[];
  documentState: PageDocumentState;
  screen: GraphScreen;
  position: number;
  total: number;
  onAddAnnotation: (target: CrankVisualAnnotation["target"], comment: string) => void;
  onBackToMap: () => void;
  onDeleteAnnotation: (id: string) => void;
  onMove: (delta: number) => void;
  onOpenCodexReview: () => Promise<void>;
  onSelectLayer: (selection: PageLayerSelection) => void;
  selectedLayerId: string | null;
  viewportRevision: number;
}) {
  const t = useT();
  const stage = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1);
  const [paintRevision, setPaintRevision] = useState(0);
  const [fit, setFit] = useState(true);
  const [view, setView] = useState<"vector" | "image">("vector");
  const [annotating, setAnnotating] = useState(false);
  const [draftTarget, setDraftTarget] = useState<CrankVisualAnnotation["target"] | null>(null);
  const [draftAnchor, setDraftAnchor] = useState<{ x: number; y: number } | null>(null);
  const [comment, setComment] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [reviewFailed, setReviewFailed] = useState(false);
  const reviewRequest = useRef(0);

  useEffect(() => {
    setView(documentState.state === "ready" && documentState.document.kind === "image" ? "image" : "vector");
    setFit(true);
    setDraftTarget(null);
    setDraftAnchor(null);
    setComment("");
  }, [documentState, screen.id]);

  useEffect(() => {
    // Loading the same document moves through loading and ready states. Tying
    // this reset to that transition unlocked the button while its first review
    // request was still running, so one click could open duplicate tabs.
    reviewRequest.current += 1;
    setReviewing(false);
    setReviewFailed(false);
  }, [screen.id]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && draftTarget) {
        setDraftTarget(null);
        setDraftAnchor(null);
        setComment("");
      } else if (event.key === "Escape" && annotating) {
        setAnnotating(false);
      } else if (event.key === "Escape") onBackToMap();
      else if (event.key === "ArrowLeft") onMove(-1);
      else if (event.key === "ArrowRight") onMove(1);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [annotating, draftTarget, onBackToMap, onMove]);

  // Opening a screen also asks Codex for fullscreen, so the host resizes the
  // panel while the page document is still being fetched. Gating the whole
  // effect on a ready document threw that one geometry notification away and
  // left the first fit measured against the old inline bounds, which is why the
  // opened screen only settled once an unrelated window resize arrived. Keep the
  // measuring attached for the whole open and gate only the fit itself.
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    element.scrollTo({ left: 0, top: 0 });
    let measuredWidth = -1;
    let measuredHeight = -1;
    let repaintTimer = 0;
    const resize = () => {
      const box = element.getBoundingClientRect();
      if (Math.abs(box.width - measuredWidth) > 0.5 || Math.abs(box.height - measuredHeight) > 0.5) {
        measuredWidth = box.width;
        measuredHeight = box.height;
        window.clearTimeout(repaintTimer);
        // A Codex fullscreen promotion can preserve the old composited iframe
        // surface even after layout is correct. Remount the page once its
        // actual stage box settles, which invalidates that surface without
        // asking the user to resize the app window.
        repaintTimer = window.setTimeout(() => setPaintRevision((current) => current + 1), 80);
      }
      if (documentState.state !== "ready" || !fit) return;
      const next = fitPageToViewport({
        pageWidth: documentState.document.width,
        pageHeight: documentState.document.height,
        viewportWidth: box.width,
        viewportHeight: box.height
      });
      if (next !== null) setZoom((current) => Math.abs(current - next) < 0.0005 ? current : next);
    };
    resize();
    const stopMeasuring = measureAtViewportSettlingPoints(
      resize,
      window.setTimeout.bind(window),
      window.clearTimeout.bind(window)
    );
    // Codex resizes the iframe element while promoting it into the fullscreen
    // surface. That changes this stage's border box without necessarily
    // emitting a child-window resize event, so observe the stable flex item
    // itself. Unlike observing the document root, fitting its child cannot
    // change this box and therefore cannot form a resize feedback loop.
    const resizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(element);
    const visualViewport = window.visualViewport;
    window.addEventListener("resize", resize);
    visualViewport?.addEventListener("resize", resize);
    return () => {
      resizeObserver?.disconnect();
      window.clearTimeout(repaintTimer);
      window.removeEventListener("resize", resize);
      visualViewport?.removeEventListener("resize", resize);
      stopMeasuring();
    };
  }, [documentState, fit, viewportRevision]);

  const zoomBy = (factor: number) => {
    setFit(false);
    setZoom((current) => Math.min(4, Math.max(0.08, current * factor)));
  };
  const source = documentState.state === "ready"
    ? t(documentState.document.kind === "layers"
      ? view === "vector" ? "codex.vectorLayers" : "codex.originalCapture"
      : "codex.rasterFallback")
    : "";
  const canSwitchView = documentState.state === "ready"
    && documentState.document.kind === "layers"
    && Boolean(documentState.document.dataUrl);

  const chooseLayer = (layer: PageLayerSelection) => {
    onSelectLayer(layer);
    if (!annotating) return;
    const sourceRef = sourceRefFromAnchor(layer.source);
    setDraftTarget({
      kind: "node",
      nodeId: layer.id,
      name: layer.name,
      sourceRef: sourceRef ? { ...sourceRef, component: layer.name } : null,
      point: layer.point ?? (layer.boundingBox
        ? { x: layer.boundingBox.x + layer.boundingBox.width / 2, y: layer.boundingBox.y + layer.boundingBox.height / 2 }
        : { x: 0.5, y: 0.5 }),
      boundingBox: layer.boundingBox
    });
    setDraftAnchor(layer.clientPoint ?? null);
    setComment("");
  };

  const choosePoint = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (!annotating) return;
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width <= 0 || box.height <= 0) return;
    setDraftTarget({
      kind: "point",
      point: {
        x: Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)),
        y: Math.min(1, Math.max(0, (event.clientY - box.top) / box.height))
      }
    });
    setDraftAnchor({ x: event.clientX, y: event.clientY });
    setComment("");
  };

  const addAnnotation = () => {
    if (!draftTarget || !comment.trim()) return;
    onAddAnnotation(draftTarget, comment.trim());
    setDraftTarget(null);
    setDraftAnchor(null);
    setComment("");
  };

  const openCodexAnnotation = async () => {
    if (reviewing || documentState.state !== "ready") return;
    const request = ++reviewRequest.current;
    setReviewing(true);
    setReviewFailed(false);
    try {
      await onOpenCodexReview();
    } catch {
      if (reviewRequest.current === request) setReviewFailed(true);
    } finally {
      if (reviewRequest.current === request) setReviewing(false);
    }
  };

  return <section aria-label={screen.name} aria-modal="true" className="document-viewer" role="dialog">
    <header className="document-viewer__bar">
      <div className="document-viewer__identity">
        <button className="document-viewer__back" onClick={onBackToMap}>{t("codex.backToMap")}</button>
        <strong>{screen.name}</strong>
        <span>{screen.route || t("codex.noRoute")}</span>
        {source && <small>{source}</small>}
      </div>
      <div className="document-viewer__paging">
        <button aria-label={t("codex.previousScreen")} disabled={position <= 0} onClick={() => onMove(-1)}>‹</button>
        <span>{position + 1} / {total}</span>
        <button aria-label={t("codex.nextScreen")} disabled={position >= total - 1} onClick={() => onMove(1)}>›</button>
      </div>
      <div className="document-viewer__tools">
        {canSwitchView && <span className="document-viewer__mode">
          <button aria-pressed={view === "vector"} onClick={() => setView("vector")}>{t("codex.layerView")}</button>
          <button aria-pressed={view === "image"} onClick={() => setView("image")}>{t("codex.captureView")}</button>
        </span>}
        <button aria-label={t("codex.zoomOut")} onClick={() => zoomBy(0.8)}>−</button>
        <button className="document-viewer__zoom" onClick={() => setFit(true)}>{fit ? t("codex.fit") : `${Math.round(zoom * 100)}%`}</button>
        <button aria-label={t("codex.zoomIn")} onClick={() => zoomBy(1.25)}>＋</button>
        <button
          aria-pressed={annotating}
          className="document-viewer__annotate"
          onClick={() => {
            setAnnotating((current) => !current);
            setDraftTarget(null);
            setDraftAnchor(null);
            setComment("");
          }}
        >{annotating ? t("common.done") : t("codex.annotate")}{annotations.length > 0 ? ` · ${annotations.length}` : ""}</button>
        <button
          className="document-viewer__codex-annotate"
          disabled={reviewing || documentState.state !== "ready"}
          onClick={() => void openCodexAnnotation()}
        >{t(reviewing ? "codex.reviewPreparing" : "codex.annotateWithCodex")}</button>
      </div>
    </header>
    {reviewFailed && <div className="document-viewer__review-error" role="status">{t("codex.reviewFailed")}</div>}
    <div className={`document-viewer__stage${annotating ? " is-annotating" : ""}`} ref={stage}>
      {documentState.state === "loading" && <div className="document-viewer__status">{t("codex.documentLoading")}</div>}
      {documentState.state === "error" && <div className="document-viewer__status is-error"><strong>{t("codex.documentUnavailable")}</strong><span>{documentState.message}</span></div>}
      {documentState.state === "ready" && <div
        key={`${screen.id}:${documentState.document.kind}:${paintRevision}`}
        className="document-viewer__sheet-space"
        style={{ width: documentState.document.width * zoom, height: documentState.document.height * zoom }}
      >
        <div className="document-viewer__sheet" onClick={choosePoint} style={{
          width: documentState.document.width,
          height: documentState.document.height,
          transform: `translateZ(0) scale(${zoom})`,
          transformOrigin: "0 0"
        }}>
          {documentState.document.kind === "layers" && view === "vector"
            ? <PageLayers
              tree={documentState.document.layerTree.tree}
              width={documentState.document.width}
              height={documentState.document.height}
              onSelectLayer={chooseLayer}
              selectedLayerId={selectedLayerId}
            />
            : <img alt={screen.name} draggable={false} src={documentState.document.dataUrl} />}
          {annotations.map((annotation, index) => <div className="crank-annotation" key={annotation.id}>
            {annotating && annotation.target.boundingBox && <span className="crank-annotation__box" style={{
              left: annotation.target.boundingBox.x * documentState.document.width,
              top: annotation.target.boundingBox.y * documentState.document.height,
              width: annotation.target.boundingBox.width * documentState.document.width,
              height: annotation.target.boundingBox.height * documentState.document.height
            }} />}
            <span className="crank-annotation__pin" style={{
              left: annotation.target.point.x * documentState.document.width,
              top: annotation.target.point.y * documentState.document.height
            }}>{index + 1}</span>
          </div>)}
          {draftTarget && <div className="crank-annotation is-draft">
            {draftTarget.boundingBox && <span className="crank-annotation__box" style={{
              left: draftTarget.boundingBox.x * documentState.document.width,
              top: draftTarget.boundingBox.y * documentState.document.height,
              width: draftTarget.boundingBox.width * documentState.document.width,
              height: draftTarget.boundingBox.height * documentState.document.height
            }} />}
            <span className="crank-annotation__pin" style={{
              left: draftTarget.point.x * documentState.document.width,
              top: draftTarget.point.y * documentState.document.height
            }}>＋</span>
          </div>}
        </div>
      </div>}
      {annotating && !draftTarget && <div className="annotation-hint">{t("codex.annotationHint")}</div>}
      {draftTarget && <form className="annotation-composer" style={draftAnchor ? {
        left: Math.min(Math.max(12, draftAnchor.x + 14), Math.max(12, window.innerWidth - 336)),
        top: Math.min(Math.max(64, draftAnchor.y + 14), Math.max(64, window.innerHeight - 190))
      } : undefined} onSubmit={(event) => { event.preventDefault(); addAnnotation(); }}>
        <div>
          <strong>{draftTarget.name || t(draftTarget.kind === "node" ? "codex.selectedElement" : "codex.selectedArea")}</strong>
          {draftTarget.sourceRef && <small>{draftTarget.sourceRef.file}:{draftTarget.sourceRef.line}</small>}
        </div>
        <textarea
          autoFocus
          maxLength={2000}
          onChange={(event) => setComment(event.target.value)}
          placeholder={t("codex.annotationPlaceholder")}
          rows={3}
          value={comment}
        />
        <div className="annotation-composer__actions">
          <button onClick={() => { setDraftTarget(null); setDraftAnchor(null); setComment(""); }} type="button">{t("common.cancel")}</button>
          <button className="is-primary" disabled={!comment.trim()} type="submit">{t("codex.addAnnotation")}</button>
        </div>
      </form>}
      {annotating && !draftTarget && annotations.length > 0 && <aside className="annotation-list">
        <strong>{t("codex.annotations", { count: annotations.length })}</strong>
        <ol>{annotations.map((annotation, index) => <li key={annotation.id}>
          <span>{index + 1}</span>
          <p>{annotation.comment}</p>
          <button aria-label={t("codex.deleteAnnotation", { number: index + 1 })} onClick={() => onDeleteAnnotation(annotation.id)} type="button">×</button>
        </li>)}</ol>
      </aside>}
    </div>
  </section>;
}

function ExportPanel({
  busy,
  currentName,
  feedback,
  figmaResult,
  figmaStatus,
  figmaUrl,
  onClose,
  onCopy,
  onDraw,
  onFigmaUrl,
  onScope,
  onSend,
  scope,
  total
}: {
  busy: "figma" | "copy" | "paper" | null;
  currentName: string;
  feedback: string;
  figmaResult: FigmaSendResult | null;
  figmaStatus: FigmaSyncStatus | null;
  figmaUrl: string;
  onClose: () => void;
  onCopy: () => void;
  onDraw: () => void;
  onFigmaUrl: (value: string) => void;
  onScope: (value: "all" | "current") => void;
  onSend: () => void;
  scope: "all" | "current";
  total: number;
}) {
  const t = useT();
  const pairingCode = figmaResult?.pairingCode;
  const figmaMessage = figmaStatus?.state === "complete"
    ? t("codex.figmaComplete", { count: figmaStatus.renderedCount ?? figmaResult?.screenCount ?? 0 })
    : figmaStatus?.state === "error" || figmaStatus?.state === "expired"
      ? t("codex.figmaFailed")
      : pairingCode && figmaResult?.requiresPairing
        ? t("codex.figmaPairing", { code: `${pairingCode.slice(0, 3)} ${pairingCode.slice(3)}` })
        : figmaResult
          ? t("codex.figmaWaiting")
          : "";

  return <aside aria-labelledby="crank-export-title" aria-modal="true" className="export-panel" role="dialog">
    <div className="export-panel__heading">
      <div><small>{t("codex.export")}</small><strong id="crank-export-title">{t("codex.exportTitle")}</strong></div>
      <button aria-label={t("common.close")} onClick={onClose}>×</button>
    </div>
    <fieldset className="export-scope">
      <legend>{t("codex.exportScope")}</legend>
      <label><input checked={scope === "all"} name="crank-export-scope" onChange={() => onScope("all")} type="radio" /> <span>{t("codex.exportAll", { count: total })}</span></label>
      <label><input checked={scope === "current"} name="crank-export-scope" onChange={() => onScope("current")} type="radio" /> <span>{t("codex.exportCurrent", { name: currentName })}</span></label>
    </fieldset>
    <section className="export-destination">
      <div className="export-destination__title"><strong>{t("codex.figma")}</strong></div>
      <label>{t("codex.figmaDestination")}<input onChange={(event) => onFigmaUrl(event.target.value)} placeholder={t("inventory.figmaUrlPlaceholder")} value={figmaUrl} /></label>
      <button className="export-action is-primary" disabled={busy !== null || !figmaUrl.trim()} onClick={onSend} type="button">
        {busy === "figma" ? t("codex.figmaPreparing") : t("codex.sendToFigma")}
      </button>
      {figmaMessage && <p className={`export-result${figmaStatus?.state === "error" || figmaStatus?.state === "expired" ? " is-error" : ""}`}>{figmaMessage}</p>}
    </section>
    <section className="export-destination">
      <div className="export-destination__title"><strong>{t("codex.paper")}</strong></div>
      <p>{t("codex.paperDescription")}</p>
      <div className="export-paper-actions">
        <button className="export-action" disabled={busy !== null} onClick={onCopy} type="button">{busy === "copy" ? t("codex.copyingForPaper") : t("codex.copyForPaper")}</button>
        <button className="export-action" disabled={busy !== null} onClick={onDraw} type="button">{busy === "paper" ? t("codex.drawingInPaper") : t("codex.drawInPaper")}</button>
      </div>
    </section>
    {feedback && <p className="export-feedback" role="status">{feedback}</p>}
  </aside>;
}

export function FlowCanvas() {
  const t = useT();
  const { locale } = useLocale();
  const [payload, setPayload] = useState<CanvasPayload | null>(() => initialPayload());
  const [intent, setIntent] = useState<AppGraph | null>(() => payload ? clone(payload.intentGraph) : null);
  const [nodes, setNodes] = useState<FlowNode[]>(() => intent ? layoutGraph(intent, payload?.scene.showPreviews, savedLayout(payload)) : []);
  const [edges, setEdges] = useState<FlowEdge[]>(() => {
    if (!intent) return [];
    const initialNodes = layoutGraph(intent, payload?.scene.showPreviews, savedLayout(payload));
    return graphEdges(intent, initialNodes);
  });
  const [previews, setPreviews] = useState<Record<string, ScreenPreview>>({});
  const [documents, setDocuments] = useState<Record<string, PageDocumentState>>({});
  const [detailScreenId, setDetailScreenId] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<CrankVisualAnnotation[]>([]);
  const [showPreviews, setShowPreviews] = useState(() => payload?.scene.showPreviews ?? true);
  const [nextLayoutStyle, setNextLayoutStyle] = useState<FlowLayoutStyle>(AUTO_LAYOUT_STYLES[0]);
  const [view, setView] = useState<"map" | "screens">(() => payload?.scene.view ?? "map");
  const [selection, setSelection] = useState<CanvasSelection | null>(() => payload?.scene.selection ?? null);
  const [notice, setNotice] = useState<string>("");
  const [rescanBusy, setRescanBusy] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportScope, setExportScope] = useState<"all" | "current">("all");
  const [figmaUrl, setFigmaUrl] = useState(() => payload?.exportSettings.figmaUrl ?? "");
  const [exportBusy, setExportBusy] = useState<"figma" | "copy" | "paper" | null>(null);
  const [exportFeedback, setExportFeedback] = useState("");
  const [figmaResultState, setFigmaResultState] = useState<FigmaSendResult | null>(null);
  const [figmaSyncState, setFigmaSyncState] = useState<FigmaSyncStatus | null>(null);
  const [hostLayout, setHostLayout] = useState(initialHostLayout);
  const lastAnnotationContext = useRef<string | null>(null);
  const displayMode = hostLayout.mode;
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance<FlowNode, FlowEdge> | null>(null);
  const flowWrap = useRef<HTMLDivElement>(null);
  const mapMinZoom = showPreviews ? PREVIEW_MIN_ZOOM : COMPACT_MIN_ZOOM;

  const fitCanvas = useCallback(() => {
    if (!flowInstance) return;
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        void flowInstance.fitView({
          padding: displayMode === "fullscreen" ? 0.1 : 0.2,
          minZoom: mapMinZoom,
          maxZoom: 1
        });
      });
    });
  }, [displayMode, flowInstance, mapMinZoom]);

  const load = useCallback((next: CanvasPayload) => {
    const graph = clone(next.intentGraph);
    setPayload(next);
    setIntent(graph);
    const nextNodes = layoutGraph(
      graph,
      next.scene.showPreviews,
      next.scene.layoutVersion === FLOW_LAYOUT_VERSION ? next.scene.nodes : []
    );
    setNodes(nextNodes);
    setEdges(graphEdges(graph, nextNodes));
    setShowPreviews(next.scene.showPreviews);
    setView(next.scene.view);
    setSelection(next.scene.selection);
    setDetailScreenId(null);
    setDocuments({});
    setAnnotations((current) => current.every((annotation) => annotation.inventoryId === next.inventoryId) ? current : []);
    setNotice("");
    setFigmaUrl(next.exportSettings.figmaUrl ?? "");
    setExportOpen(false);
    setExportFeedback("");
    setFigmaResultState(null);
    setFigmaSyncState(null);
  }, []);

  useEffect(() => onToolPayload(load), [load]);
  useEffect(() => onHostLayoutChange(setHostLayout), []);
  useEffect(() => {
    if (payload) return;
    const timer = window.setTimeout(() => load(samplePayload), 250);
    return () => window.clearTimeout(timer);
  }, [load, payload]);

  const previewKey = payload?.observedGraph.screens.map((screen) => screen.id).join("|") ?? "";
  useEffect(() => {
    if (!payload || payload === samplePayload) return;
    let active = true;
    const screens = payload.observedGraph.screens;
    setPreviews(Object.fromEntries(screens.map((screen) => [screen.id, { state: "loading" } satisfies ScreenPreview])));
    for (const screen of screens) {
      void loadPagePreview(payload.inventoryId, screen.id).then((dataUrl) => {
        if (!active) return;
        setPreviews((current) => ({ ...current, [screen.id]: { state: "ready", dataUrl } }));
      }).catch((error) => {
        if (!active) return;
        setPreviews((current) => ({
          ...current,
          [screen.id]: { state: "error", message: error instanceof Error ? error.message : String(error) }
        }));
      });
    }
    return () => { active = false; };
  // The IDs are the stable identity of the captured preview set.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payload?.inventoryId, previewKey]);

  useEffect(() => {
    // Mounting a canvas with no staged comments is not a user edit. Skipping
    // that empty bridge call keeps ordinary opening and clicking completely
    // silent, while a later deletion can still clear a previously staged note.
    const serialized = JSON.stringify(annotations);
    if (lastAnnotationContext.current === null && annotations.length === 0) {
      lastAnnotationContext.current = serialized;
      return;
    }
    // React StrictMode replays mount effects in development. Comparing the
    // serialized value keeps that replay silent without suppressing a real
    // non-empty -> empty transition when the last annotation is deleted.
    if (lastAnnotationContext.current === serialized) return;
    lastAnnotationContext.current = serialized;
    void updateModelContext(annotations);
  }, [annotations]);

  useEffect(() => {
    if (!payload || payload === samplePayload || !intent) return;
    const timer = window.setTimeout(() => {
      void saveCanvasState(payload.inventoryId, intent, {
        layoutVersion: FLOW_LAYOUT_VERSION,
        view,
        showPreviews,
        nodes: nodes.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
        selection
      }).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [intent, nodes, payload, selection, showPreviews, view]);

  useEffect(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    setEdges((current) => current.map((edge) => ({
      ...edge,
      ...edgeHandles(byId.get(edge.source), byId.get(edge.target))
    })));
  }, [nodes]);

  useEffect(() => {
    if (!flowInstance) return;
    // Codex grows the iframe after it accepts fullscreen. React Flow observes
    // the new bounds but deliberately keeps its old transform, which leaves a
    // card-sized graph floating in a full-screen canvas. Wait for both the host
    // and React Flow resize observers, then fit once against the real viewport.
    let innerFrame = 0;
    let outerFrame = 0;
    let settleTimer = 0;
    const fit = () => {
      window.cancelAnimationFrame(outerFrame);
      window.cancelAnimationFrame(innerFrame);
      window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(() => {
        outerFrame = window.requestAnimationFrame(() => {
          innerFrame = window.requestAnimationFrame(() => {
            void flowInstance.fitView({
              padding: displayMode === "fullscreen" ? 0.1 : 0.2,
              minZoom: mapMinZoom,
              maxZoom: 1
            });
          });
        });
      }, 60);
    };
    fit();
    const resizeObserver = typeof ResizeObserver === "function" && flowWrap.current
      ? new ResizeObserver(fit)
      : null;
    if (resizeObserver && flowWrap.current) resizeObserver.observe(flowWrap.current);
    return () => {
      resizeObserver?.disconnect();
      window.clearTimeout(settleTimer);
      window.cancelAnimationFrame(outerFrame);
      if (innerFrame) window.cancelAnimationFrame(innerFrame);
    };
  }, [displayMode, flowInstance, hostLayout.revision, mapMinZoom]);

  const syncIntent = useCallback((nextNodes: FlowNode[], nextEdges: FlowEdge[]) => {
    setIntent((current) => current ? {
      ...current,
      screens: nextNodes.map((node) => node.data.screen),
      edges: nextEdges.map((edge) => edge.data?.graphEdge ?? {
        id: edge.id, fromScreenId: edge.source, toScreenId: edge.target, status: "proposed",
        trigger: { type: "click", label: typeof edge.label === "string" ? edge.label : "" }
      })
    } : current);
  }, []);

  const onNodesChange = useCallback((changes: NodeChange<FlowNode>[]) => {
    setNodes((current) => {
      const next = applyNodeChanges(changes, current);
      // Position changes deliberately stay in React Flow state. Only removal is
      // product intent and therefore enters the semantic graph.
      if (changes.some((change) => change.type === "remove")) {
        const ids = new Set(next.map((node) => node.id));
        const nextEdges = edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target));
        setEdges(nextEdges);
        syncIntent(next, nextEdges);
      }
      return next;
    });
  }, [edges, syncIntent]);

  const onEdgesChange = useCallback((changes: EdgeChange<FlowEdge>[]) => {
    setEdges((current) => {
      const next = applyEdgeChanges(changes, current);
      if (changes.some((change) => change.type === "remove")) syncIntent(nodes, next);
      return next;
    });
  }, [nodes, syncIntent]);

  const onConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const graphEdge: GraphEdge = {
      id: `proposed:${connection.source}:${connection.target}:${Date.now()}`,
      fromScreenId: connection.source, toScreenId: connection.target, status: "proposed",
      trigger: { type: "click", label: t("codex.newTransition") }
    };
    setEdges((current) => {
      if (current.some((edge) => edge.source === connection.source && edge.target === connection.target)) return current;
      const next = addEdge({
        ...connection,
        id: graphEdge.id,
        className: "is-proposed",
        type: "crank",
        interactionWidth: 36,
        label: graphEdge.trigger?.label,
        style: { stroke: "var(--crank-edge-proposed)", strokeWidth: 1.7 },
        markerEnd: { type: MarkerType.ArrowClosed, color: "var(--crank-edge-proposed)" },
        data: { graphEdge }
      }, current);
      syncIntent(nodes, next);
      return next;
    });
  }, [nodes, syncIntent, t]);

  const onReconnect = useCallback((oldEdge: FlowEdge, connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    // Updating intent from inside the setEdges updater let React commit the
    // visual endpoint while retaining the old semantic target. Compute the
    // reconnected collection once so canvas and manifest receive one value.
    const next = reconnectEdge(oldEdge, connection, edges).map((edge) => {
      if (edge.id !== oldEdge.id) return edge;
      const status = edge.data!.graphEdge.status === "proposed" ? "proposed" as const : "modified" as const;
      return {
        ...edge,
        className: `is-${status}`,
        data: {
          graphEdge: {
            ...edge.data!.graphEdge,
            fromScreenId: connection.source!,
            toScreenId: connection.target!,
            status
          }
        }
      };
    });
    setEdges(next);
    setIntent((current) => current
      ? reconnectIntentEdge(current, oldEdge.id, connection.source!, connection.target!)
      : current);
  }, [edges]);

  const addScreen = useCallback(() => {
    if (!intent) return;
    const id = `proposed-screen-${Date.now()}`;
    const screen: GraphScreen = { id, name: t("codex.newScreen"), route: "", annotation: "", status: "proposed" };
    const next = { ...intent, screens: [...intent.screens, screen] };
    setIntent(next);
    setNodes((current) => [...current, { id, type: "screen", position: { x: 80 + current.length * 22, y: 100 + current.length * 16 }, data: { screen } }]);
    setSelection({ kind: "screen", screenId: id });
  }, [intent, t]);

  const changeCount = useMemo(() => payload && intent ? diffCount(diffAppGraphs(payload.observedGraph, intent)) : 0, [intent, payload]);
  const readyPreviewCount = Object.values(previews).filter((preview) => preview.state === "ready").length;

  const reset = useCallback(() => {
    if (!payload) return;
    const graph = clone(payload.observedGraph);
    const nextNodes = layoutGraph(graph, showPreviews);
    setIntent(graph);
    setNodes(nextNodes);
    setEdges(graphEdges(graph, nextNodes));
    setSelection(null);
    setDetailScreenId(null);
    setNotice("");
    setNextLayoutStyle(AUTO_LAYOUT_STYLES[0]);
    fitCanvas();
  }, [fitCanvas, payload, showPreviews]);

  const autoLayout = useCallback(() => {
    if (!intent) return;
    const appliedStyle = nextLayoutStyle;
    const nextNodes = layoutGraph(intent, showPreviews, [], appliedStyle);
    setNodes(nextNodes);
    setEdges(graphEdges(intent, nextNodes));
    const appliedIndex = AUTO_LAYOUT_STYLES.indexOf(appliedStyle);
    setNextLayoutStyle(AUTO_LAYOUT_STYLES[(appliedIndex + 1) % AUTO_LAYOUT_STYLES.length]);
    setNotice(t("flow.layoutApplied", { style: t(AUTO_LAYOUT_LABELS[appliedStyle]) }));
    fitCanvas();
  }, [fitCanvas, intent, nextLayoutStyle, showPreviews, t]);

  const openCodexAnnotation = useCallback(async (screenId: string) => {
    if (!payload) throw new Error("Crank has no open inventory.");
    const review = await prepareReview(payload.inventoryId, screenId, locale);
    await openReviewInCodex(review);
  }, [locale, payload]);

  const expand = useCallback(async () => {
    setNotice("");
    try {
      if (!await requestFullscreen()) setNotice(t("codex.fullscreenUnavailable"));
    } catch {
      setNotice(t("codex.fullscreenUnavailable"));
    }
  }, [t]);

  const rescan = useCallback(async () => {
    const repoPath = payload?.intentGraph.project.root;
    if (!repoPath || rescanBusy) return;
    setRescanBusy(true);
    setNotice(t("codex.rescanning"));
    try {
      let job = await startRepositoryRescan(repoPath);
      while (job.state === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        job = await loadJob(job.id);
      }
      if (job.state === "error") throw new Error(job.error || "Rescan failed");
      const next = await openRepositoryCanvas(repoPath);
      load(next);
      setNotice(t("codex.rescanComplete", { count: next.observedGraph.screens.length }));
    } catch {
      setNotice(t("codex.rescanFailed"));
    } finally {
      setRescanBusy(false);
    }
  }, [load, payload?.intentGraph.project.root, rescanBusy, t]);

  const addVisualAnnotation = useCallback((screen: GraphScreen, target: CrankVisualAnnotation["target"], comment: string) => {
    if (!payload) return;
    setAnnotations((current) => [...current, {
      version: 1,
      id: `crank-annotation-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`,
      inventoryId: payload.inventoryId,
      screenId: screen.id,
      screenName: screen.name,
      comment,
      target,
      createdAt: new Date().toISOString()
    }]);
  }, [payload]);

  const deleteVisualAnnotation = useCallback((id: string) => {
    setAnnotations((current) => current.filter((annotation) => annotation.id !== id));
  }, []);

  const exportScreen = useMemo(() => {
    if (!intent) return null;
    const id = detailScreenId
      ?? (selection?.kind === "screen" || selection?.kind === "node" ? selection.screenId : null)
      ?? intent.screens[0]?.id;
    return intent.screens.find((screen) => screen.id === id) ?? intent.screens[0] ?? null;
  }, [detailScreenId, intent, selection]);
  const exportPageIds = useCallback(() => (
    exportScope === "current" && exportScreen ? [exportScreen.id] : undefined
  ), [exportScope, exportScreen]);

  const sendToFigma = useCallback(async () => {
    if (!payload || exportBusy) return;
    if (!figmaUrl.trim()) {
      setExportFeedback(t("codex.figmaUrlRequired"));
      return;
    }
    setExportBusy("figma");
    setExportFeedback("");
    setFigmaResultState(null);
    setFigmaSyncState(null);
    try {
      let job = await startFigmaSend(payload.inventoryId, figmaUrl.trim(), exportPageIds());
      while (job.state === "running") {
        await new Promise((resolve) => window.setTimeout(resolve, 450));
        job = await loadJob(job.id);
      }
      if (job.state === "error") throw new Error(job.error || "Figma preparation failed");
      const result = figmaSendResult(job.result);
      if (!result.ok || !result.pairingCode) throw new Error(result.message || "Figma preparation failed");
      setFigmaResultState(result);
      setFigmaSyncState({ state: "waiting" });
    } catch {
      setExportFeedback(t("codex.figmaFailed"));
    } finally {
      setExportBusy(null);
    }
  }, [exportBusy, exportPageIds, figmaUrl, payload, t]);

  useEffect(() => {
    const pairingCode = figmaResultState?.pairingCode;
    if (!pairingCode) return;
    let cancelled = false;
    let timer = 0;
    const check = async () => {
      try {
        const status = await loadFigmaSyncStatus(pairingCode);
        if (cancelled) return;
        setFigmaSyncState(status);
        if (["complete", "error", "expired"].includes(status.state)) return;
      } catch {
        if (!cancelled) setFigmaSyncState({ state: "error" });
        return;
      }
      timer = window.setTimeout(() => void check(), 1000);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [figmaResultState?.pairingCode]);

  const copyScreensForPaper = useCallback(async () => {
    if (!payload || exportBusy) return;
    setExportBusy("copy");
    setExportFeedback("");
    try {
      const result = await copyForPaper(payload.inventoryId, intent?.project.name || t("app.name"), exportPageIds());
      setExportFeedback(result.ok
        ? t("codex.paperCopied", { count: result.screens?.length ?? 0 })
        : t("codex.paperFailed"));
    } catch {
      setExportFeedback(t("codex.paperFailed"));
    } finally {
      setExportBusy(null);
    }
  }, [exportBusy, exportPageIds, intent?.project.name, payload, t]);

  const drawScreensInPaper = useCallback(async () => {
    if (!payload || exportBusy) return;
    setExportBusy("paper");
    setExportFeedback("");
    try {
      const result = await drawInPaper(payload.inventoryId, exportPageIds());
      setExportFeedback(result.ok
        ? t("codex.paperDrawn", { created: result.created?.length ?? 0, updated: result.updated?.length ?? 0 })
        : t("codex.paperFailed"));
    } catch {
      setExportFeedback(t("codex.paperFailed"));
    } finally {
      setExportBusy(null);
    }
  }, [exportBusy, exportPageIds, payload, t]);

  const openScreen = useCallback((id: string) => {
    setDetailScreenId(id);
    const screen = intent?.screens.find((candidate) => candidate.id === id);
    setSelection({ kind: "screen", screenId: id, sourceRef: screen?.sourceRef });
    // The detail viewer still works inline, but asking for the available large
    // host surface makes every open — including a cached page — behave like
    // opening that page in Crank.
    if (displayMode !== "fullscreen") void requestFullscreen().catch(() => {});
    if (!payload || documents[id]) return;
    setDocuments((current) => ({ ...current, [id]: { state: "loading" } }));
    void loadPageDocument(payload.inventoryId, id).then((document) => {
      setDocuments((current) => ({ ...current, [id]: { state: "ready", document } }));
    }).catch((error) => {
      setDocuments((current) => ({
        ...current,
        [id]: { state: "error", message: error instanceof Error ? error.message : String(error) }
      }));
    });
  }, [displayMode, documents, intent, payload]);

  const backToMap = useCallback(() => {
    setDetailScreenId(null);
    setView("map");
  }, []);

  const detailPosition = detailScreenId && intent ? intent.screens.findIndex((screen) => screen.id === detailScreenId) : -1;
  const moveDetail = useCallback((delta: number) => {
    if (!intent || detailPosition < 0) return;
    const next = intent.screens[detailPosition + delta];
    if (next) openScreen(next.id);
  }, [detailPosition, intent, openScreen]);

  const displayNodes = useMemo(() => {
    const sequenceById = new Map((intent?.screens ?? []).map((screen, index) => [screen.id, index + 1]));
    return nodes.map((node) => ({
      ...node,
      data: { ...node.data, sequence: sequenceById.get(node.id), preview: previews[node.id], showPreview: showPreviews, openScreen }
    }));
  }, [intent, nodes, openScreen, previews, showPreviews]);

  if (!intent) return <div className="loading">{t("codex.loadingCanvas")}</div>;

  return <main className="app-shell" data-display-mode={displayMode}>
    <header className="toolbar">
      <div className="brand"><div><strong>{intent.project.name}</strong><small>{t("codex.flowSummary", { screens: intent.screens.length, transitions: intent.edges.length, previews: readyPreviewCount })}</small></div></div>
      <div className="view-switch" role="tablist" aria-label={t("codex.view")}> 
        <button className={view === "map" ? "active" : ""} aria-selected={view === "map"} role="tab" onClick={() => setView("map")}>{t("codex.map")}</button>
        <button className={view === "screens" ? "active" : ""} aria-selected={view === "screens"} role="tab" onClick={() => setView("screens")}>{t("codex.screens")}</button>
      </div>
      <div className="toolbar__actions">
        {notice && <span className="notice">{notice}</span>}
        <button className="quiet rescan" disabled={rescanBusy || !intent.project.root} onClick={() => void rescan()} type="button">
          {t(rescanBusy ? "codex.rescanning" : "inventory.actions.rescan")}
        </button>
        {view === "map" && <button className="quiet preview-toggle" aria-pressed={showPreviews} onClick={() => setShowPreviews((visible) => !visible)}>{t(showPreviews ? "inventory.flowHideBoards" : "inventory.flowShowBoards")}</button>}
        <button className="quiet layout-toggle" onClick={autoLayout} title={t("flow.layoutCycleHint")}>{t("flow.autoLayout")} · {t(AUTO_LAYOUT_LABELS[nextLayoutStyle])}</button>
        <button className="quiet" disabled={changeCount === 0} onClick={reset}>{t("flow.reset")}</button>
        {displayMode !== "fullscreen" && <button className="quiet fullscreen" onClick={() => void expand()}>{t("codex.expand")}</button>}
        <button className="quiet export-toggle" aria-expanded={exportOpen} onClick={() => setExportOpen((open) => !open)}>{t("codex.export")}</button>
      </div>
    </header>
    <section className={`workspace workspace--${view}`}>
      {view === "map" ? <div className="flow-wrap" ref={flowWrap}>
        <ReactFlow<FlowNode, FlowEdge>
          nodes={displayNodes}
          edges={edges}
          onInit={setFlowInstance}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onReconnect={onReconnect}
          connectionMode={ConnectionMode.Loose}
          onNodeClick={(_, node) => setSelection({ kind: "screen", screenId: node.id, sourceRef: node.data.screen.sourceRef })}
          onEdgeClick={(_, edge) => setSelection({ kind: "edge", edgeId: edge.id, sourceRef: edge.data?.graphEdge.sourceRef })}
          connectionRadius={28}
          reconnectRadius={28}
          onPaneClick={(event) => {
            setSelection(null);
            if (event.detail === 2) addScreen();
          }}
          fitView
          fitViewOptions={{ padding: 0.2, minZoom: mapMinZoom, maxZoom: 1 }}
          minZoom={mapMinZoom}
          maxZoom={2}
          deleteKeyCode={["Backspace", "Delete"]}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="var(--crank-canvas-grid)" gap={24} size={1} />
          <Controls showInteractive={false} />
          <div className="canvas-hint">{t("codex.canvasHint")}</div>
        </ReactFlow>
      </div> : <div className="screen-grid">
        {intent.screens.map((screen, index) => <article key={screen.id} className={`screen-card screen-card--${screen.status}${selection?.kind === "screen" && selection.screenId === screen.id ? " is-selected" : ""}`}>
          <button aria-label={t("codex.openScreen", { name: screen.name })} className="screen-card__preview" onClick={() => openScreen(screen.id)} type="button"><span>{String(index + 1).padStart(2, "0")}</span><Preview preview={previews[screen.id]} /></button>
          <button className="screen-card__copy" onClick={() => setSelection({ kind: "screen", screenId: screen.id, sourceRef: screen.sourceRef })} type="button"><strong>{screen.name}</strong></button>
        </article>)}
        <button className="screen-card screen-card--add" onClick={addScreen}><span>＋</span><strong>{t("codex.newScreen")}</strong></button>
      </div>}
      {exportOpen && exportScreen && <ExportPanel
        busy={exportBusy}
        currentName={exportScreen.name}
        feedback={exportFeedback}
        figmaResult={figmaResultState}
        figmaStatus={figmaSyncState}
        figmaUrl={figmaUrl}
        onClose={() => setExportOpen(false)}
        onCopy={() => void copyScreensForPaper()}
        onDraw={() => void drawScreensInPaper()}
        onFigmaUrl={setFigmaUrl}
        onScope={setExportScope}
        onSend={() => void sendToFigma()}
        scope={exportScope}
        total={intent.screens.length}
      />}
    </section>
    {detailScreenId && detailPosition >= 0 && <PageDocumentViewer
      annotations={annotations.filter((annotation) => annotation.screenId === detailScreenId)}
      documentState={documents[detailScreenId] ?? LOADING_DOCUMENT}
      onAddAnnotation={(target, comment) => addVisualAnnotation(intent.screens[detailPosition], target, comment)}
      onBackToMap={backToMap}
      onDeleteAnnotation={deleteVisualAnnotation}
      onMove={moveDetail}
      onOpenCodexReview={() => openCodexAnnotation(detailScreenId)}
      position={detailPosition}
      screen={intent.screens[detailPosition]}
      selectedLayerId={selection?.kind === "node" && selection.screenId === detailScreenId ? selection.nodeId : null}
      total={intent.screens.length}
      viewportRevision={hostLayout.revision}
      onSelectLayer={(layer) => setSelection({
        kind: "node",
        screenId: detailScreenId,
        nodeId: layer.id,
        name: layer.name,
        sourceRef: sourceRefFromAnchor(layer.source)
      })}
    />}
  </main>;
}
