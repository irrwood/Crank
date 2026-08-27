import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, Dispatch, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, SetStateAction, WheelEvent as ReactWheelEvent } from "react";
import { AlignHorizontalJustifyCenter, AlignHorizontalJustifyEnd, AlignHorizontalJustifyStart, AlignVerticalJustifyCenter, AlignVerticalJustifyEnd, AlignVerticalJustifyStart, ArrowLeftRight, ArrowUpDown, ChevronLeft, ChevronRight, Copy, Crosshair, Droplet, Eye, EyeOff, FlipHorizontal2, FlipVertical2, Image, Layers3, Lock, Minus, MoreHorizontal, MousePointer2, Plus, Radius, Redo2, RotateCw, Scan, Search, SlidersHorizontal, Type, Undo2, Unlock } from "lucide-react";
import { PageLayers } from "./PageLayers";
import type { DiscoveredPage, FigmaTree } from "./types";
import { useT } from "./lib/locale";

/**
 * The first platform-neutral editing surface in Crank.
 *
 * It edits a copy of the captured layer tree rather than browser markup or
 * Swift source. That separation matters: the same controls can operate on a
 * served React page and on any later capture pipeline that produces the scene
 * vocabulary, while every mutation stays explicit in the change manifest.
 */

type SceneLayer = {
  kind: "element" | "text" | "svg" | "image";
  id: string;
  name?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  text?: string;
  style?: Record<string, unknown>;
  children?: SceneLayer[];
  [key: string]: unknown;
};

type FlatLayer = {
  layer: SceneLayer;
  depth: number;
  globalX: number;
  globalY: number;
  parentId: string | null;
};

type ManifestChange = {
  id: string;
  nodeId: string;
  nodeName: string;
  property: string;
  before: unknown;
  after: unknown;
};

type Snapshot = { root: SceneLayer; changes: ManifestChange[] };
type RailNode = { entry: FlatLayer; children: RailNode[] };
type InspectorSection = "position" | "layout" | "appearance" | "fill" | "stroke" | "effects" | "export";

type Interaction =
  | { kind: "pan"; clientX: number; clientY: number; panX: number; panY: number }
  | {
      kind: "move";
      clientX: number;
      clientY: number;
      id: string;
      x: number;
      y: number;
      before: SceneLayer;
      changes: ManifestChange[];
    }
  | {
      kind: "resize";
      clientX: number;
      clientY: number;
      direction: "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
      id: string;
      x: number;
      y: number;
      width: number;
      height: number;
      before: SceneLayer;
      changes: ManifestChange[];
    };

const clone = <T,>(value: T): T => structuredClone(value);
const CANVAS_ID_PREFIX = "__crank_canvas__:";

function colourSwatch(value: unknown): string {
  const colour = String(value ?? "").trim();
  if (/^#[0-9a-f]{6}$/i.test(colour)) return colour;
  if (/^#[0-9a-f]{3}$/i.test(colour)) return `#${colour.slice(1).split("").map((part) => `${part}${part}`).join("")}`;
  const rgb = colour.match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)/i);
  if (!rgb) return "#000000";
  return `#${rgb.slice(1, 4).map((part) => Math.max(0, Math.min(255, Math.round(Number(part)))).toString(16).padStart(2, "0")).join("")}`;
}

function rounded(value: number): number {
  return Math.round(value * 100) / 100;
}

function flatten(root: SceneLayer): FlatLayer[] {
  const found: FlatLayer[] = [];
  const visit = (layer: SceneLayer, depth: number, parentX: number, parentY: number, parentId: string | null) => {
    const globalX = parentX + (Number(layer.x) || 0);
    const globalY = parentY + (Number(layer.y) || 0);
    found.push({ depth, globalX, globalY, layer, parentId });
    for (const child of layer.children ?? []) visit(child, depth + 1, globalX, globalY, layer.id);
  };
  visit(root, 0, 0, 0, null);
  return found;
}

function visibleInLayers(layer: SceneLayer, rootId: string, depth: number): boolean {
  if (layer.id === rootId) return true;
  if (layer.kind === "text") return Boolean(layer.text?.trim());
  if (layer.kind === "image" || layer.kind === "svg") return layer.width * layer.height >= 4_096;
  const style = layer.style ?? {};
  const generatedWrapper = /^(div|span|i|p|a)\s*·\s*(glass-|ui-|[a-f0-9]{3,})/i.test(layer.name ?? "");
  const painted = Boolean(style.backgroundColor && style.backgroundColor !== "transparent" && style.backgroundColor !== "rgba(0, 0, 0, 0)")
    || Number(style.borderRadius ?? 0) > 0
    || ["borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth"].some((key) => Number(style[key] ?? 0) > 0)
    || Boolean(style.boxShadow && style.boxShadow !== "none")
    || style.clipsContent === true;
  if (painted && (!generatedWrapper || layer.width * layer.height >= 40_000)) return true;
  const name = layer.name?.trim() ?? "";
  if (/^(button|input|textarea|select|nav|header|main|aside|section|form|dialog|ul|ol|li)(?:\s|·|$)/i.test(name)) return true;
  if (name && !/^(div|span|i|p|a|body|html|text|icon)(?:\s|·|$)/i.test(name)) return true;
  return depth <= 1 && (layer.children?.length ?? 0) > 1;
}

/** A capture can contain hundreds of layout-only DOM wrappers. The scene keeps
 * them for rendering, while the layer rail exposes only objects with visual or
 * semantic meaning. Hidden wrappers do not add fake nesting depth. */
function flattenEditable(root: SceneLayer): FlatLayer[] {
  const found: FlatLayer[] = [];
  const visit = (layer: SceneLayer, sourceDepth: number, panelDepth: number, parentX: number, parentY: number, parentId: string | null) => {
    const globalX = parentX + (Number(layer.x) || 0);
    const globalY = parentY + (Number(layer.y) || 0);
    const shown = visibleInLayers(layer, root.id, sourceDepth);
    if (shown) found.push({ depth: panelDepth, globalX, globalY, layer, parentId });
    for (const child of layer.children ?? []) {
      visit(child, sourceDepth + 1, shown ? panelDepth + 1 : panelDepth, globalX, globalY, layer.id);
    }
  };
  visit(root, 0, 0, 0, 0, null);
  return found;
}

function layerRail(entries: FlatLayer[]): RailNode[] {
  const roots: RailNode[] = [];
  const stack: RailNode[] = [];
  for (const entry of entries) {
    const node = { children: [], entry } satisfies RailNode;
    while (stack.length > entry.depth) stack.pop();
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  return roots;
}

function updateLayer(root: SceneLayer, id: string, update: (layer: SceneLayer) => SceneLayer): SceneLayer {
  if (root.id === id) return update(root);
  let changed = false;
  const children = (root.children ?? []).map((child) => {
    const next = updateLayer(child, id, update);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...root, children } : root;
}

/** Text keeps a measured glyph box and a layout box. Moving only the measured
 * box moves the selection while paintLayer continues drawing at layoutX, which
 * looks exactly like the layer is trapped behind a mask. Keep both geometries
 * together while editing; capture/export can still retain their distinction. */
function moveLayer(layer: SceneLayer, x: number, y: number): SceneLayer {
  const deltaX = x - layer.x;
  return {
    ...layer,
    x,
    y,
    ...(layer.kind === "text" && typeof layer.layoutX === "number"
      ? { layoutX: layer.layoutX + deltaX }
      : {})
  };
}

function resizeLayer(layer: SceneLayer, frame: { x: number; y: number; width: number; height: number }): SceneLayer {
  const deltaWidth = frame.width - layer.width;
  const moved = moveLayer(layer, frame.x, frame.y);
  return {
    ...moved,
    width: frame.width,
    height: frame.height,
    ...(layer.kind === "text" && typeof layer.layoutWidth === "number"
      ? { layoutWidth: Math.max(1, layer.layoutWidth + deltaWidth) }
      : {})
  };
}

function editorCanvasFor(artboard: SceneLayer, width: number, height: number): SceneLayer {
  return {
    children: [moveLayer(clone(artboard), 0, 0)],
    height,
    id: `${CANVAS_ID_PREFIX}${artboard.id}`,
    kind: "element",
    name: "Crank canvas",
    style: { clipsContent: false },
    width,
    x: 0,
    y: 0
  };
}

function takeLayer(root: SceneLayer, id: string): { root: SceneLayer; layer: SceneLayer | null } {
  let taken: SceneLayer | null = null;
  const children: SceneLayer[] = [];
  for (const child of root.children ?? []) {
    if (child.id === id) {
      taken = child;
      continue;
    }
    if (!taken) {
      const nested = takeLayer(child, id);
      if (nested.layer) {
        taken = nested.layer;
        children.push(nested.root);
        continue;
      }
    }
    children.push(child);
  }
  return { layer: taken, root: taken ? { ...root, children } : root };
}

/** Reparenting is a design-editor operation, not a DOM operation. Absolute
 * position is preserved while ownership changes between a Frame and the
 * infinite canvas, matching how Figma moves layers across frame boundaries. */
function reparentLayer(root: SceneLayer, id: string, parentId: string): SceneLayer {
  const entries = flatten(root);
  const entry = entries.find((item) => item.layer.id === id);
  const parent = entries.find((item) => item.layer.id === parentId);
  if (!entry || !parent || entry.parentId === parentId) return root;
  const removed = takeLayer(root, id);
  if (!removed.layer) return root;
  const placed = moveLayer(removed.layer, entry.globalX - parent.globalX, entry.globalY - parent.globalY);
  return updateLayer(removed.root, parentId, (layer) => ({ ...layer, children: [...(layer.children ?? []), placed] }));
}

function hasAncestor(root: SceneLayer, id: string, ancestorId: string): boolean {
  const entries = flatten(root);
  let current = entries.find((entry) => entry.layer.id === id)?.parentId ?? null;
  while (current) {
    if (current === ancestorId) return true;
    current = entries.find((entry) => entry.layer.id === current)?.parentId ?? null;
  }
  return false;
}

function LayerIcon({ layer }: { layer: SceneLayer }) {
  if (layer.kind === "text") return <Type size={12} />;
  if (layer.kind === "image") return <Image size={12} />;
  if (layer.kind === "svg") return <Scan size={12} />;
  return <Scan size={12} />;
}

export function SceneEditor({ imageFallback, layerTree, page, onClose }: {
  imageFallback: boolean;
  layerTree: FigmaTree;
  page: DiscoveredPage;
  onClose: () => void;
}) {
  const t = useT();
  const artboardId = (layerTree.tree as SceneLayer).id;
  const canvasId = `${CANVAS_ID_PREFIX}${artboardId}`;
  const [root, setRoot] = useState(() => editorCanvasFor(layerTree.tree as SceneLayer, layerTree.width, layerTree.height));
  const [selectedId, setSelectedId] = useState(artboardId);
  const [changes, setChanges] = useState<ManifestChange[]>([]);
  const [undo, setUndo] = useState<Snapshot[]>([]);
  const [redo, setRedo] = useState<Snapshot[]>([]);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 40, y: 40 });
  const [spaceDown, setSpaceDown] = useState(false);
  const [layerQuery, setLayerQuery] = useState("");
  const [showAllLayers, setShowAllLayers] = useState(false);
  const [expandedLayers, setExpandedLayers] = useState(() => new Set([canvasId, artboardId]));
  const [openSections, setOpenSections] = useState<Set<InspectorSection>>(() => new Set(["position", "layout", "appearance", "fill"]));
  const [lockedAspectLayers, setLockedAspectLayers] = useState<Set<string>>(() => new Set());
  const [editingTextId, setEditingTextId] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const surface = useRef<HTMLDivElement>(null);
  const textEditor = useRef<HTMLTextAreaElement>(null);
  const textEditStart = useRef<Snapshot | null>(null);
  const interaction = useRef<Interaction | null>(null);
  const rootRef = useRef(root);
  rootRef.current = root;
  const flat = useMemo(() => flatten(root), [root]);
  const editableFlat = useMemo(() => flattenEditable(root), [root]);
  const selected = flat.find((entry) => entry.layer.id === selectedId)
    ?? flat.find((entry) => entry.layer.id === artboardId)
    ?? flat[0];

  const nameOf = useCallback((layer: SceneLayer): string => {
    if (layer.id === canvasId) return t("editor.layerCanvas");
    if (layer.id === artboardId) return t("editor.layerScreen");
    if (layer.kind === "text") return layer.text?.trim().replace(/\s+/g, " ").slice(0, 40) || t("editor.layerText");
    const name = layer.name?.trim() ?? "";
    if (name && !/^(div|span|i|p|a|body|html|text|icon)(?:\s|·|$)/i.test(name)) return name;
    const semantic = name.split("·")[1]?.trim();
    if (semantic && !/^glass-[a-z0-9]+$/i.test(semantic)) return semantic.replace(/[-_]+/g, " ");
    if (layer.kind === "image") return t("editor.layerImage");
    if (layer.kind === "svg") return t("editor.layerVector");
    return t("editor.layerFrame");
  }, [artboardId, canvasId, t]);

  const layerSource = showAllLayers ? flat : editableFlat;
  const rail = useMemo(() => layerRail(layerSource), [layerSource]);
  const shownLayers = useMemo(() => {
    const query = layerQuery.trim().toLocaleLowerCase();
    if (query) return layerSource
      .filter(({ layer }) => nameOf(layer).toLocaleLowerCase().includes(query))
      .map((entry) => ({ entry: { ...entry, depth: 0 }, hasChildren: false }));
    const visible: Array<{ entry: FlatLayer; hasChildren: boolean }> = [];
    const visit = (nodes: RailNode[]) => {
      for (const node of nodes) {
        visible.push({ entry: node.entry, hasChildren: node.children.length > 0 });
        if (expandedLayers.has(node.entry.layer.id)) visit(node.children);
      }
    };
    visit(rail);
    return visible;
  }, [expandedLayers, layerQuery, layerSource, nameOf, rail]);

  const fit = useCallback(() => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return;
    const next = Math.min(1, Math.max(0.08, Math.min((box.width - 120) / layerTree.width, (box.height - 120) / layerTree.height)));
    setZoom(next);
    setPan({ x: (box.width - layerTree.width * next) / 2, y: (box.height - layerTree.height * next) / 2 });
  }, [layerTree.height, layerTree.width]);

  useEffect(() => {
    const watcher = new ResizeObserver(fit);
    if (surface.current) watcher.observe(surface.current);
    fit();
    return () => watcher.disconnect();
  }, [fit]);

  const commit = useCallback((next: SceneLayer, change: Omit<ManifestChange, "id">) => {
    if (Object.is(change.before, change.after)) return;
    setUndo((current) => [...current, { changes: clone(changes), root: clone(root) }]);
    setRedo([]);
    rootRef.current = next;
    setRoot(next);
    setChanges((current) => [...current, { ...change, id: crypto.randomUUID() }]);
  }, [changes, root]);

  const geometryLocked = Boolean(selected && [canvasId, artboardId].includes(selected.layer.id));
  const aspectLocked = Boolean(selected && lockedAspectLayers.has(selected.layer.id));

  const changeGeometryProperty = (property: "x" | "y" | "width" | "height", value: number) => {
    if (!selected || geometryLocked || !Number.isFinite(value)) return;
    const before = property === "width" || property === "height"
      ? { height: selected.layer.height, width: selected.layer.width }
      : selected.layer[property];
    const next = updateLayer(root, selected.layer.id, (layer) => {
      if (property === "x") return moveLayer(layer, value, layer.y);
      if (property === "y") return moveLayer(layer, layer.x, value);
      if (property === "width") {
        const width = Math.max(1, value);
        const height = aspectLocked && layer.width > 0 ? Math.max(1, layer.height * width / layer.width) : layer.height;
        return resizeLayer(layer, { x: layer.x, y: layer.y, width: rounded(width), height: rounded(height) });
      }
      const height = Math.max(1, value);
      const width = aspectLocked && layer.height > 0 ? Math.max(1, layer.width * height / layer.height) : layer.width;
      return resizeLayer(layer, { x: layer.x, y: layer.y, width: rounded(width), height: rounded(height) });
    });
    const changed = flatten(next).find((entry) => entry.layer.id === selected.layer.id)?.layer;
    commit(next, {
      after: property === "width" || property === "height"
        ? { height: changed?.height, width: changed?.width }
        : value,
      before,
      nodeId: selected.layer.id,
      nodeName: nameOf(selected.layer),
      property: property === "width" || property === "height" ? "dimensions" : property
    });
  };

  const changeStyleProperties = (properties: Record<string, unknown>, property: string) => {
    if (!selected) return;
    const names = Object.keys(properties);
    const before = names.length === 1
      ? selected.layer.style?.[names[0]]
      : Object.fromEntries(names.map((name) => [name, selected.layer.style?.[name]]));
    const after = names.length === 1 ? properties[names[0]] : properties;
    const next = updateLayer(root, selected.layer.id, (layer) => ({
      ...layer,
      style: { ...layer.style, ...properties }
    }));
    commit(next, {
      after,
      before,
      nodeId: selected.layer.id,
      nodeName: nameOf(selected.layer),
      property
    });
  };

  const alignSelected = (axis: "horizontal" | "vertical", alignment: "start" | "center" | "end") => {
    if (!selected || geometryLocked || !selected.parentId) return;
    const parent = flat.find((entry) => entry.layer.id === selected.parentId)?.layer;
    if (!parent) return;
    const before = { x: selected.layer.x, y: selected.layer.y };
    const available = axis === "horizontal"
      ? parent.width - selected.layer.width
      : parent.height - selected.layer.height;
    const position = alignment === "start" ? 0 : alignment === "center" ? available / 2 : available;
    const after = axis === "horizontal"
      ? { x: rounded(position), y: selected.layer.y }
      : { x: selected.layer.x, y: rounded(position) };
    const next = updateLayer(root, selected.layer.id, (layer) => moveLayer(layer, after.x, after.y));
    commit(next, {
      after,
      before,
      nodeId: selected.layer.id,
      nodeName: nameOf(selected.layer),
      property: "position"
    });
  };

  const toggleInspectorSection = (section: InspectorSection) => {
    setOpenSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section); else next.add(section);
      return next;
    });
  };

  const beginTextEdit = useCallback((entry: FlatLayer) => {
    if (entry.layer.kind !== "text") return;
    textEditStart.current = { changes: clone(changes), root: clone(rootRef.current) };
    setSelectedId(entry.layer.id);
    setTextDraft(entry.layer.text ?? "");
    setEditingTextId(entry.layer.id);
  }, [changes]);

  const updateTextDraft = useCallback((value: string) => {
    setTextDraft(value);
    if (!editingTextId) return;
    // The captured text layer remains the renderer while the textarea only
    // supplies selection, a caret and keyboard input. Relying on a transparent
    // native control to redraw captured fonts made the entire string disappear
    // in Chromium as soon as editing began for some pages.
    setRoot((current) => {
      const next = updateLayer(current, editingTextId, (layer) => ({ ...layer, text: value }));
      rootRef.current = next;
      return next;
    });
  }, [editingTextId]);

  const finishTextEdit = useCallback((save: boolean) => {
    const start = textEditStart.current;
    if (!editingTextId || !start) return;
    const before = flatten(start.root).find(({ layer }) => layer.id === editingTextId);
    const after = flatten(rootRef.current).find(({ layer }) => layer.id === editingTextId);
    textEditStart.current = null;
    setEditingTextId(null);
    if (!save) {
      rootRef.current = start.root;
      setRoot(start.root);
      return;
    }
    if (!before || !after || before.layer.text === after.layer.text) return;
    setUndo((current) => [...current, start]);
    setRedo([]);
    setChanges([...start.changes, {
      after: after.layer.text ?? "",
      before: before.layer.text ?? "",
      id: crypto.randomUUID(),
      nodeId: before.layer.id,
      nodeName: nameOf(before.layer),
      property: "text"
    }]);
  }, [editingTextId, nameOf]);

  useEffect(() => {
    if (!editingTextId) return;
    const input = textEditor.current;
    input?.focus();
    input?.setSelectionRange(0, input.value.length);
  }, [editingTextId]);

  const restore = (from: Snapshot[], setFrom: Dispatch<SetStateAction<Snapshot[]>>, setTo: Dispatch<SetStateAction<Snapshot[]>>) => {
    const previous = from.at(-1);
    if (!previous) return;
    setTo((current) => [...current, { changes: clone(changes), root: clone(root) }]);
    setFrom(from.slice(0, -1));
    rootRef.current = previous.root;
    setRoot(previous.root);
    setChanges(previous.changes);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.matches("input, textarea, [contenteditable='true']");
      if (event.code === "Space" && !typing) { event.preventDefault(); setSpaceDown(true); }
      if (typing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) restore(redo, setRedo, setUndo);
        else restore(undo, setUndo, setRedo);
        return;
      }
      if (event.key === "Escape") { onClose(); return; }
      if (event.key === "0") { event.preventDefault(); setZoom(1); return; }
      if (event.key === "1" && event.shiftKey) { event.preventDefault(); fit(); return; }
      if (event.key === "+" || event.key === "=") { event.preventDefault(); setZoom((value) => Math.min(4, value * 1.15)); return; }
      if (event.key === "-") { event.preventDefault(); setZoom((value) => Math.max(0.05, value / 1.15)); return; }
      if (event.key === "Enter" && selected?.layer.kind === "text") {
        event.preventDefault();
        beginTextEdit(selected);
        return;
      }
      const delta = event.shiftKey ? 10 : 1;
      const move = event.key === "ArrowLeft" ? [-delta, 0] : event.key === "ArrowRight" ? [delta, 0]
        : event.key === "ArrowUp" ? [0, -delta] : event.key === "ArrowDown" ? [0, delta] : null;
      if (move && selected && ![canvasId, artboardId].includes(selected.layer.id)) {
        event.preventDefault();
        const before = { x: selected.layer.x, y: selected.layer.y };
        const after = { x: selected.layer.x + move[0], y: selected.layer.y + move[1] };
        const next = updateLayer(root, selected.layer.id, (layer) => moveLayer(layer, after.x, after.y));
        commit(next, { after, before, nodeId: selected.layer.id, nodeName: nameOf(selected.layer), property: "position" });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => { if (event.code === "Space") setSpaceDown(false); };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [artboardId, beginTextEdit, canvasId, changes, commit, fit, nameOf, onClose, redo, root, selected, undo]);

  const pointInScene = (clientX: number, clientY: number) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return null;
    return { x: (clientX - box.left - pan.x) / zoom, y: (clientY - box.top - pan.y) / zoom };
  };

  const hitAt = (clientX: number, clientY: number) => {
    const point = pointInScene(clientX, clientY);
    if (!point) return null;
    return [...(showAllLayers ? flat : editableFlat)]
      .filter(({ globalX, globalY, layer }) => point.x >= globalX && point.y >= globalY
        && point.x <= globalX + layer.width && point.y <= globalY + layer.height)
      .sort((a, b) => b.depth - a.depth || a.layer.width * a.layer.height - b.layer.width * b.layer.height)[0] ?? null;
  };

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === 1 || spaceDown) {
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      interaction.current = { clientX: event.clientX, clientY: event.clientY, kind: "pan", panX: pan.x, panY: pan.y };
      return;
    }
    if (event.button !== 0) return;
    const hit = hitAt(event.clientX, event.clientY);
    if (!hit) { setSelectedId(""); return; }
    setSelectedId(hit.layer.id);
    if ([canvasId, artboardId].includes(hit.layer.id)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    interaction.current = {
      before: clone(root),
      changes: clone(changes),
      clientX: event.clientX,
      clientY: event.clientY,
      id: hit.layer.id,
      kind: "move",
      x: hit.layer.x,
      y: hit.layer.y
    };
  };

  const doubleClick = (event: ReactMouseEvent<HTMLDivElement>) => {
    const hit = hitAt(event.clientX, event.clientY);
    if (!hit || hit.layer.kind !== "text") return;
    event.preventDefault();
    beginTextEdit(hit);
  };

  const startResize = (event: ReactPointerEvent<HTMLButtonElement>, direction: Extract<Interaction, { kind: "resize" }>["direction"]) => {
    if (!selected || [canvasId, artboardId].includes(selected.layer.id)) return;
    event.preventDefault();
    event.stopPropagation();
    surface.current?.setPointerCapture(event.pointerId);
    interaction.current = {
      before: clone(root),
      changes: clone(changes),
      clientX: event.clientX,
      clientY: event.clientY,
      direction,
      height: selected.layer.height,
      id: selected.layer.id,
      kind: "resize",
      width: selected.layer.width,
      x: selected.layer.x,
      y: selected.layer.y
    };
  };

  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = interaction.current;
    if (!active) return;
    if (active.kind === "pan") {
      setPan({ x: active.panX + event.clientX - active.clientX, y: active.panY + event.clientY - active.clientY });
      return;
    }
    const dx = (event.clientX - active.clientX) / zoom;
    const dy = (event.clientY - active.clientY) / zoom;
    if (active.kind === "move") {
      const x = Math.round((active.x + dx) * 100) / 100;
      const y = Math.round((active.y + dy) * 100) / 100;
      setRoot((current) => {
        const next = updateLayer(current, active.id, (layer) => moveLayer(layer, x, y));
        rootRef.current = next;
        return next;
      });
      return;
    }
    const west = active.direction.includes("w");
    const east = active.direction.includes("e");
    const north = active.direction.includes("n");
    const south = active.direction.includes("s");
    const width = Math.max(1, active.width + (east ? dx : west ? -dx : 0));
    const height = Math.max(1, active.height + (south ? dy : north ? -dy : 0));
    const x = west ? active.x + active.width - width : active.x;
    const y = north ? active.y + active.height - height : active.y;
    setRoot((current) => {
      const next = updateLayer(current, active.id, (layer) => resizeLayer(layer, {
        height: Math.round(height * 100) / 100,
        width: Math.round(width * 100) / 100,
        x: Math.round(x * 100) / 100,
        y: Math.round(y * 100) / 100
      }));
      rootRef.current = next;
      return next;
    });
  };

  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const active = interaction.current;
    interaction.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (!active || active.kind === "pan") return;
    const beforeEntry = flatten(active.before).find((entry) => entry.layer.id === active.id);
    let finalRoot = rootRef.current;
    let movedEntry = flatten(finalRoot).find((entry) => entry.layer.id === active.id);

    if (active.kind === "move" && movedEntry) {
      const artboard = flatten(finalRoot).find((entry) => entry.layer.id === artboardId);
      const center = {
        x: movedEntry.globalX + movedEntry.layer.width / 2,
        y: movedEntry.globalY + movedEntry.layer.height / 2
      };
      const insideArtboard = Boolean(artboard
        && center.x >= artboard.globalX
        && center.y >= artboard.globalY
        && center.x <= artboard.globalX + artboard.layer.width
        && center.y <= artboard.globalY + artboard.layer.height);
      const startedInArtboard = hasAncestor(active.before, active.id, artboardId);

      if (startedInArtboard && !insideArtboard) {
        finalRoot = reparentLayer(finalRoot, active.id, canvasId);
      } else if (!startedInArtboard && movedEntry.parentId === canvasId && insideArtboard) {
        finalRoot = reparentLayer(finalRoot, active.id, artboardId);
      }
      if (finalRoot !== rootRef.current) {
        rootRef.current = finalRoot;
        setRoot(finalRoot);
        movedEntry = flatten(finalRoot).find((entry) => entry.layer.id === active.id);
      }
    }

    const moved = movedEntry?.layer;
    const beforeFrame = { x: active.x, y: active.y, width: "width" in active ? active.width : moved?.width, height: "height" in active ? active.height : moved?.height };
    const afterFrame = moved ? { x: moved.x, y: moved.y, width: moved.width, height: moved.height } : null;
    if (!moved || !afterFrame || JSON.stringify(beforeFrame) === JSON.stringify(afterFrame)) return;
    setUndo((current) => [...current, { changes: active.changes, root: active.before }]);
    setRedo([]);
    const nextChanges: ManifestChange[] = [{
      after: active.kind === "move" ? { x: moved.x, y: moved.y } : afterFrame,
      before: active.kind === "move" ? { x: active.x, y: active.y } : beforeFrame,
      id: crypto.randomUUID(),
      nodeId: moved.id,
      nodeName: nameOf(moved),
      property: active.kind === "move" ? "position" : "frame"
    }];
    if (beforeEntry?.parentId !== movedEntry?.parentId) {
      nextChanges.push({
        after: movedEntry?.parentId ?? null,
        before: beforeEntry?.parentId ?? null,
        id: crypto.randomUUID(),
        nodeId: moved.id,
        nodeName: nameOf(moved),
        property: "parent"
      });
    }
    setChanges((current) => [...current, ...nextChanges]);
  };

  const wheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.metaKey || event.ctrlKey) {
      const next = Math.min(4, Math.max(0.05, zoom * Math.exp(-event.deltaY * 0.002)));
      const box = surface.current?.getBoundingClientRect();
      if (!box) return;
      const sceneX = (event.clientX - box.left - pan.x) / zoom;
      const sceneY = (event.clientY - box.top - pan.y) / zoom;
      setPan({ x: event.clientX - box.left - sceneX * next, y: event.clientY - box.top - sceneY * next });
      setZoom(next);
    } else {
      setPan((value) => ({ x: value.x - event.deltaX, y: value.y - event.deltaY }));
    }
  };

  return (
    <section className="scene-editor">
      <header className="scene-editor-toolbar">
        <button className="scene-tool scene-editor-back" onClick={onClose} type="button"><ChevronLeft size={15} /> {t("editor.back")}</button>
        <div className="scene-editor-title"><strong>{page.name}</strong><span>{t("editor.title")}</span></div>
        <div className="scene-editor-history">
          <button aria-label={t("editor.undo")} className="scene-tool is-icon" disabled={undo.length === 0} onClick={() => restore(undo, setUndo, setRedo)} type="button"><Undo2 size={15} /></button>
          <button aria-label={t("editor.redo")} className="scene-tool is-icon" disabled={redo.length === 0} onClick={() => restore(redo, setRedo, setUndo)} type="button"><Redo2 size={15} /></button>
        </div>
        <span className={`scene-editor-mode${imageFallback ? " is-fallback" : ""}`} title={imageFallback ? t("editor.imageFallbackHint") : undefined}>
          <MousePointer2 size={13} /> {imageFallback ? t("editor.imageFallback") : t("editor.sceneGraph")}
        </span>
        <button className="scene-tool" disabled={changes.length === 0} onClick={() => void window.uiSync?.copyText?.(JSON.stringify({ page: page.id, changes }, null, 2))} type="button"><Copy size={14} /> {t("editor.copyManifest")}</button>
      </header>

      <div className="scene-editor-body">
        <aside className="scene-layer-panel">
          <h2>
            <Layers3 size={14} /> {t("editor.layers")}
            <button onClick={() => setShowAllLayers((value) => !value)} type="button">
              {showAllLayers ? t("editor.designLayers") : t("editor.allLayers")}
            </button>
          </h2>
          <label className="scene-layer-search">
            <Search size={12} />
            <input aria-label={t("editor.searchLayers")} onChange={(event) => setLayerQuery(event.target.value)} placeholder={t("editor.searchLayers")} value={layerQuery} />
          </label>
          <div className="scene-layer-list">
            {shownLayers.map(({ entry, hasChildren }) => {
              const { depth, layer } = entry;
              return (
              <button
                aria-pressed={selectedId === layer.id}
                className="scene-layer-row"
                key={layer.id}
                onClick={() => setSelectedId(layer.id)}
                onDoubleClick={() => beginTextEdit(entry)}
                style={{ paddingLeft: 10 + Math.min(depth, 7) * 12 }}
                title={nameOf(layer)}
                type="button"
              >
                <span
                  aria-label={t("editor.expandLayer")}
                  className={`scene-layer-disclosure${expandedLayers.has(layer.id) ? " is-open" : ""}${hasChildren ? "" : " is-empty"}`}
                  onClick={(event) => {
                    if (!hasChildren) return;
                    event.stopPropagation();
                    setExpandedLayers((current) => {
                      const next = new Set(current);
                      if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id);
                      return next;
                    });
                  }}
                  onKeyDown={(event) => {
                    if (hasChildren && (event.key === "Enter" || event.key === " ")) event.currentTarget.click();
                  }}
                  role="button"
                  tabIndex={hasChildren ? 0 : -1}
                >
                  <ChevronRight size={10} />
                </span>
                <LayerIcon layer={layer} /><span>{nameOf(layer)}</span>
              </button>
              );
            })}
          </div>
        </aside>

        <div
          className={`scene-canvas${spaceDown ? " is-panning" : ""}`}
          onDoubleClick={doubleClick}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onWheel={wheel}
          ref={surface}
        >
          <div className="scene-artboard-transform" style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}>
            <div className="scene-artboard" style={{ height: layerTree.height, width: layerTree.width }}>
              <PageLayers allowOverflow height={layerTree.height} tree={root} width={layerTree.width} />
              {selected && (
                <div
                  className={`scene-selection${selected.layer.width * zoom < 24 || selected.layer.height * zoom < 18 ? " is-compact" : ""}`}
                  style={{
                    "--scene-handle": `${7 / zoom}px`,
                    borderWidth: `${1.5 / zoom}px`,
                    height: selected.layer.height,
                    left: selected.globalX,
                    top: selected.globalY,
                    transform: Number(selected.layer.style?.rotation ?? 0) ? `rotate(${Number(selected.layer.style?.rotation ?? 0)}deg)` : undefined,
                    transformOrigin: "center",
                    width: selected.layer.width
                  } as CSSProperties}
                >
                  {![canvasId, artboardId].includes(selected.layer.id) && (["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const).map((direction) => (
                    <button
                      aria-label={t("editor.resizeHandle")}
                      className={`scene-resize-handle is-${direction}`}
                      key={direction}
                      onPointerDown={(event) => startResize(event, direction)}
                      tabIndex={-1}
                      type="button"
                    />
                  ))}
                </div>
              )}
              {selected && editingTextId === selected.layer.id && selected.layer.kind === "text" && (
                <textarea
                  aria-label={t("editor.editText")}
                  className="scene-inline-text"
                  onBlur={() => finishTextEdit(true)}
                  onChange={(event) => updateTextDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { event.preventDefault(); finishTextEdit(false); }
                    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") event.currentTarget.blur();
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  ref={textEditor}
                  spellCheck={false}
                  style={{
                    caretColor: String(selected.layer.style?.color ?? "#20211f"),
                    color: "transparent",
                    fontFamily: selected.layer.style?.resolvedFontFamily ? `"${String(selected.layer.style.resolvedFontFamily)}", sans-serif` : undefined,
                    fontSize: Number(selected.layer.style?.fontSize ?? 14),
                    fontWeight: selected.layer.style?.fontWeight as CSSProperties["fontWeight"],
                    height: Math.max(selected.layer.height, Number(selected.layer.style?.lineHeight ?? 18)),
                    left: selected.globalX + Number(selected.layer.layoutX ?? selected.layer.x) - selected.layer.x,
                    letterSpacing: Number(selected.layer.style?.letterSpacing ?? 0),
                    lineHeight: selected.layer.style?.lineHeight ? `${Number(selected.layer.style.lineHeight)}px` : undefined,
                    textAlign: selected.layer.style?.textAlign as CSSProperties["textAlign"],
                    top: selected.globalY,
                    WebkitTextFillColor: "transparent",
                    width: Number(selected.layer.layoutWidth ?? selected.layer.width)
                  }}
                  value={textDraft}
                />
              )}
            </div>
          </div>
          <div className="scene-zoom">
            <button onClick={() => setZoom((value) => Math.max(0.05, value / 1.15))} type="button">−</button>
            <button onClick={fit} type="button">{Math.round(zoom * 100)}%</button>
            <button onClick={() => setZoom((value) => Math.min(4, value * 1.15))} type="button">+</button>
          </div>
        </div>

        <aside className="scene-inspector">
          {selected ? (
            <>
              <header className="scene-inspector-header">
                <div className="scene-selected-name"><LayerIcon layer={selected.layer} /><strong>{nameOf(selected.layer)}</strong></div>
                <button
                  aria-label={selected.layer.style?.visible === false ? t("editor.showLayer") : t("editor.hideLayer")}
                  aria-pressed={selected.layer.style?.visible !== false}
                  onClick={() => changeStyleProperties({ visible: selected.layer.style?.visible === false }, "visibility")}
                  type="button"
                >
                  {selected.layer.style?.visible === false ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
                <button aria-label={t("editor.moreProperties")} disabled type="button"><MoreHorizontal size={16} /></button>
              </header>

              <section className="scene-inspector-section is-open">
                <button className="scene-section-heading" onClick={() => toggleInspectorSection("position")} type="button">
                  <span>{t("editor.position")}</span><ChevronRight className={openSections.has("position") ? "is-open" : ""} size={14} />
                </button>
                {openSections.has("position") && (
                  <div className="scene-section-content">
                    <span className="scene-property-label">{t("editor.alignment")}</span>
                    <div className="scene-alignment-grid">
                      <button aria-label={t("editor.alignLeft")} disabled={geometryLocked} onClick={() => alignSelected("horizontal", "start")} type="button"><AlignHorizontalJustifyStart size={15} /></button>
                      <button aria-label={t("editor.alignHorizontalCenter")} disabled={geometryLocked} onClick={() => alignSelected("horizontal", "center")} type="button"><AlignHorizontalJustifyCenter size={15} /></button>
                      <button aria-label={t("editor.alignRight")} disabled={geometryLocked} onClick={() => alignSelected("horizontal", "end")} type="button"><AlignHorizontalJustifyEnd size={15} /></button>
                      <button aria-label={t("editor.alignTop")} disabled={geometryLocked} onClick={() => alignSelected("vertical", "start")} type="button"><AlignVerticalJustifyStart size={15} /></button>
                      <button aria-label={t("editor.alignVerticalCenter")} disabled={geometryLocked} onClick={() => alignSelected("vertical", "center")} type="button"><AlignVerticalJustifyCenter size={15} /></button>
                      <button aria-label={t("editor.alignBottom")} disabled={geometryLocked} onClick={() => alignSelected("vertical", "end")} type="button"><AlignVerticalJustifyEnd size={15} /></button>
                    </div>

                    <span className="scene-property-label">{t("editor.position")}</span>
                    <div className="scene-control-row">
                      {(["x", "y"] as const).map((property) => (
                        <label className="scene-number-field" key={property}>
                          <span>{property.toUpperCase()}</span>
                          <input disabled={geometryLocked} onChange={(event) => changeGeometryProperty(property, Number(event.target.value))} type="number" value={rounded(selected.layer[property])} />
                        </label>
                      ))}
                    </div>

                    <span className="scene-property-label">{t("editor.constraints")}</span>
                    <div className="scene-constraints-grid">
                      <div className="scene-constraint-selects">
                        <label className="scene-select-field"><ArrowLeftRight size={13} /><select disabled={geometryLocked} onChange={(event) => changeStyleProperties({ constraintHorizontal: event.target.value }, "horizontalConstraint")} value={String(selected.layer.style?.constraintHorizontal ?? "left")}><option value="left">{t("editor.constraintLeft")}</option><option value="center">{t("editor.constraintCenter")}</option><option value="right">{t("editor.constraintRight")}</option><option value="scale">{t("editor.constraintScale")}</option></select></label>
                        <label className="scene-select-field"><ArrowUpDown size={13} /><select disabled={geometryLocked} onChange={(event) => changeStyleProperties({ constraintVertical: event.target.value }, "verticalConstraint")} value={String(selected.layer.style?.constraintVertical ?? "top")}><option value="top">{t("editor.constraintTop")}</option><option value="center">{t("editor.constraintCenter")}</option><option value="bottom">{t("editor.constraintBottom")}</option><option value="scale">{t("editor.constraintScale")}</option></select></label>
                      </div>
                      <div aria-label={t("editor.constraintPreview")} className="scene-constraint-preview"><Crosshair size={24} /></div>
                    </div>

                    <span className="scene-property-label">{t("editor.rotation")}</span>
                    <div className="scene-rotation-row">
                      <label className="scene-number-field"><RotateCw size={13} /><input onChange={(event) => changeStyleProperties({ rotation: Number(event.target.value) }, "rotation")} type="number" value={Number(selected.layer.style?.rotation ?? 0)} /><em>°</em></label>
                      <div className="scene-icon-group">
                        <button aria-label={t("editor.rotateClockwise")} onClick={() => changeStyleProperties({ rotation: (Number(selected.layer.style?.rotation ?? 0) + 90) % 360 }, "rotation")} type="button"><RotateCw size={15} /></button>
                        <button aria-label={t("editor.flipHorizontal")} aria-pressed={selected.layer.style?.flipX === true} onClick={() => changeStyleProperties({ flipX: selected.layer.style?.flipX !== true }, "flipHorizontal")} type="button"><FlipHorizontal2 size={15} /></button>
                        <button aria-label={t("editor.flipVertical")} aria-pressed={selected.layer.style?.flipY === true} onClick={() => changeStyleProperties({ flipY: selected.layer.style?.flipY !== true }, "flipVertical")} type="button"><FlipVertical2 size={15} /></button>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              <section className="scene-inspector-section">
                <button className="scene-section-heading" onClick={() => toggleInspectorSection("layout")} type="button">
                  <span>{t("editor.layout")}</span><ChevronRight className={openSections.has("layout") ? "is-open" : ""} size={14} />
                </button>
                {openSections.has("layout") && (
                  <div className="scene-section-content">
                    <span className="scene-property-label">{t("editor.dimensions")}</span>
                    <div className="scene-dimensions-row">
                      {(["width", "height"] as const).map((property) => (
                        <label className="scene-number-field" key={property}>
                          <span>{property === "width" ? "W" : "H"}</span>
                          <input disabled={geometryLocked} min="1" onChange={(event) => changeGeometryProperty(property, Number(event.target.value))} type="number" value={rounded(selected.layer[property])} />
                        </label>
                      ))}
                      <button aria-label={aspectLocked ? t("editor.unlockAspect") : t("editor.lockAspect")} aria-pressed={aspectLocked} className="scene-aspect-button" disabled={geometryLocked} onClick={() => setLockedAspectLayers((current) => { const next = new Set(current); if (next.has(selected.layer.id)) next.delete(selected.layer.id); else next.add(selected.layer.id); return next; })} type="button">{aspectLocked ? <Lock size={14} /> : <Unlock size={14} />}</button>
                    </div>
                    {selected.layer.kind === "text" && (
                      <><button className="scene-edit-text-button" onClick={() => beginTextEdit(selected)} type="button">{t("editor.editOnCanvas")}</button><p className="scene-field-hint">{t("editor.doubleClickText")}</p></>
                    )}
                  </div>
                )}
              </section>

              <section className="scene-inspector-section">
                <button className="scene-section-heading" onClick={() => toggleInspectorSection("appearance")} type="button">
                  <span>{t("editor.appearance")}</span><div className="scene-heading-actions"><Eye size={14} /><Droplet size={14} /><ChevronRight className={openSections.has("appearance") ? "is-open" : ""} size={14} /></div>
                </button>
                {openSections.has("appearance") && (
                  <div className="scene-section-content">
                    <div className="scene-control-row">
                      <label className="scene-stacked-field"><span>{t("editor.opacity")}</span><span className="scene-number-field"><SlidersHorizontal size={13} /><input max="100" min="0" onChange={(event) => changeStyleProperties({ opacity: Number(event.target.value) / 100 }, "opacity")} type="number" value={rounded(Number(selected.layer.style?.opacity ?? 1) * 100)} /><em>%</em></span></label>
                      <label className="scene-stacked-field"><span>{t("editor.cornerRadius")}</span><span className="scene-number-field"><Radius size={13} /><input disabled={selected.layer.kind !== "element"} min="0" onChange={(event) => changeStyleProperties({ borderRadius: Math.max(0, Number(event.target.value)) }, "borderRadius")} type="number" value={Number(selected.layer.style?.borderRadius ?? 0)} /></span></label>
                    </div>
                  </div>
                )}
              </section>

              <section className="scene-inspector-section">
                <button className="scene-section-heading" onClick={() => toggleInspectorSection("fill")} type="button">
                  <span>{t("editor.fill")}</span><div className="scene-heading-actions"><Plus size={15} /><ChevronRight className={openSections.has("fill") ? "is-open" : ""} size={14} /></div>
                </button>
                {openSections.has("fill") && (
                  <div className="scene-section-content">
                    {selected.layer.kind === "element" || selected.layer.kind === "text" ? (
                      <div className="scene-paint-row">
                        <input aria-label={t("editor.fillColour")} className="scene-color-swatch" onChange={(event) => changeStyleProperties({ [selected.layer.kind === "text" ? "color" : "backgroundColor"]: event.target.value }, "fill")} type="color" value={colourSwatch(selected.layer.style?.[selected.layer.kind === "text" ? "color" : "backgroundColor"])} />
                        <input aria-label={t("editor.fill")} className="scene-paint-value" onChange={(event) => changeStyleProperties({ [selected.layer.kind === "text" ? "color" : "backgroundColor"]: event.target.value }, "fill")} placeholder={t("editor.transparent")} value={String(selected.layer.style?.[selected.layer.kind === "text" ? "color" : "backgroundColor"] ?? "")} />
                        <button aria-label={selected.layer.style?.fillVisible === false ? t("editor.showFill") : t("editor.hideFill")} onClick={() => changeStyleProperties({ fillVisible: selected.layer.style?.fillVisible === false }, "fillVisibility")} type="button">{selected.layer.style?.fillVisible === false ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                      </div>
                    ) : <p className="scene-empty-copy">{t("editor.originalPaint")}</p>}
                  </div>
                )}
              </section>

              <section className="scene-inspector-section">
                <button className="scene-section-heading" onClick={() => toggleInspectorSection("stroke")} type="button">
                  <span>{t("editor.stroke")}</span><div className="scene-heading-actions"><Plus size={15} /><ChevronRight className={openSections.has("stroke") ? "is-open" : ""} size={14} /></div>
                </button>
                {openSections.has("stroke") && (
                  <div className="scene-section-content">
                    {selected.layer.kind === "element" ? <div className="scene-stroke-row">
                      <input aria-label={t("editor.strokeColour")} className="scene-color-swatch" onChange={(event) => changeStyleProperties({ borderBottomColor: event.target.value, borderLeftColor: event.target.value, borderRightColor: event.target.value, borderTopColor: event.target.value }, "strokeColor")} type="color" value={colourSwatch(selected.layer.style?.borderTopColor)} />
                      <label className="scene-number-field"><span>{t("editor.weight")}</span><input min="0" onChange={(event) => { const width = Math.max(0, Number(event.target.value)); changeStyleProperties({ borderBottomWidth: width, borderLeftWidth: width, borderRightWidth: width, borderTopWidth: width }, "strokeWidth"); }} type="number" value={Number(selected.layer.style?.borderTopWidth ?? selected.layer.style?.borderRightWidth ?? selected.layer.style?.borderBottomWidth ?? selected.layer.style?.borderLeftWidth ?? 0)} /></label>
                    </div> : <p className="scene-empty-copy">{t("editor.strokeUnavailable")}</p>}
                  </div>
                )}
              </section>

              <section className="scene-inspector-section">
                <button className="scene-section-heading" onClick={() => toggleInspectorSection("effects")} type="button">
                  <span>{t("editor.effects")}</span><div className="scene-heading-actions"><Plus size={15} /><ChevronRight className={openSections.has("effects") ? "is-open" : ""} size={14} /></div>
                </button>
                {openSections.has("effects") && (
                  <div className="scene-section-content"><label className="scene-stacked-field"><span>{t("editor.shadow")}</span><input className="scene-text-field" onChange={(event) => changeStyleProperties({ boxShadow: event.target.value }, "boxShadow")} placeholder={t("editor.shadowPlaceholder")} value={String(selected.layer.style?.boxShadow ?? "")} /></label></div>
                )}
              </section>

              <section className="scene-inspector-section scene-export-section">
                <button className="scene-section-heading" onClick={() => toggleInspectorSection("export")} type="button">
                  <span>{t("editor.export")}</span><div className="scene-heading-actions"><span>{changes.length}</span>{openSections.has("export") ? <Minus size={15} /> : <Plus size={15} />}</div>
                </button>
                {openSections.has("export") && (
                  <div className="scene-section-content scene-manifest">
                    <h2>{t("editor.manifest")}<span>{changes.length}</span></h2>
                    {changes.length === 0 ? <p className="scene-empty-copy">{t("editor.manifestEmpty")}</p> : <ol>{[...changes].reverse().map((change) => <li key={change.id}><strong>{change.nodeName}</strong><span>{change.property}</span></li>)}</ol>}
                  </div>
                )}
              </section>
            </>
          ) : <p className="scene-empty-copy">{t("editor.selectLayer")}</p>}
        </aside>
      </div>
    </section>
  );
}
