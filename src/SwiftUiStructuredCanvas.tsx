import type { CSSProperties, MouseEvent, PointerEvent, ReactNode } from "react";
import type { DesignNodeSnapshot, DiscoveredScreen, SemanticIntent, SwiftUiNode } from "./types";

type StudioMode = "interact" | "select";

const systemColors: Record<string, string> = {
  primary: "#1c1c1e",
  secondary: "#6e6e73",
  tertiary: "#8e8e93",
  systemBackground: "#ffffff",
  secondarySystemBackground: "#f2f2f7",
  tertiarySystemBackground: "#ffffff",
  separator: "#c6c6c8",
  accentColor: "#007aff",
  blue: "#007aff",
  green: "#34c759",
  orange: "#ff9500",
  pink: "#ff2d55",
  purple: "#af52de",
  red: "#ff3b30",
  yellow: "#ffcc00",
  white: "#ffffff",
  black: "#000000",
  clear: "transparent"
};

const fontSizes: Record<string, number> = {
  largeTitle: 34,
  title: 28,
  title2: 22,
  title3: 20,
  headline: 17,
  subheadline: 15,
  body: 17,
  callout: 16,
  footnote: 13,
  caption: 12,
  caption2: 11
};

const fontWeights: Record<string, number> = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
  heavy: 800,
  black: 900
};

const symbolFallbacks: Record<string, string> = {
  "chevron.left": "‹",
  "chevron.right": "›",
  "plus": "+",
  "minus": "−",
  "checkmark": "✓",
  "xmark": "×",
  "magnifyingglass": "⌕",
  "ellipsis": "•••",
  "gear": "⚙︎",
  "person": "●",
  "house": "⌂",
  "cart": "▱",
  "location": "⌖",
  "cloud.sun": "☀︎",
  "sun.max": "☀︎",
  "moon": "☾"
};

function humanize(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_.:/]+/g, " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}

function nodeId(node: SwiftUiNode, screen: DiscoveredScreen, path: string) {
  return node.syncId ?? `${screen.id}/${path}`;
}

function nodeName(node: SwiftUiNode) {
  const value = node.name || node.title || node.text || node.sourceName || node.type;
  return humanize(String(value)).slice(0, 160);
}

function estimatedSize(node: SwiftUiNode, viewportWidth: number) {
  const defaultHeight: Record<SwiftUiNode["type"], number> = {
    navigation: 96,
    vstack: 72,
    hstack: 48,
    zstack: 120,
    scroll: 320,
    list: 360,
    section: 88,
    text: node.fontSize ?? fontSizes[node.fontStyle ?? "body"] ?? 17,
    label: 32,
    symbol: 24,
    button: 44,
    toggle: 44,
    field: 44,
    divider: 1,
    spacer: node.minLength ?? 8,
    shape: 120,
    progress: 28,
    custom: 72,
    group: 72,
    tabview: 520
  };
  return {
    x: node.runtimeFrame?.x ?? 0,
    y: node.runtimeFrame?.y ?? 0,
    width: node.runtimeFrame?.width ?? node.width ?? Math.max(44, viewportWidth - 32),
    height: node.runtimeFrame?.height ?? node.height ?? Math.max(1, defaultHeight[node.type])
  };
}

export function collectStructuredNodes(screen: DiscoveredScreen | null, viewportWidth: number): DesignNodeSnapshot[] {
  if (!screen?.uiTree) return [];
  const snapshots: DesignNodeSnapshot[] = [];
  const visit = (node: SwiftUiNode, path: string) => {
    const frame = estimatedSize(node, viewportWidth);
    snapshots.push({
      id: nodeId(node, screen, path),
      name: nodeName(node),
      frame,
      cornerRadius: node.cornerRadius ?? null,
      backgroundColor: node.backgroundColorToken ?? null,
      fontSize: node.fontSize ?? (node.fontStyle ? fontSizes[node.fontStyle] ?? null : null),
      sourceHint: `${node.sourceFile ?? "Unknown.swift"}:${node.sourceRange?.line ?? 1}`,
      ...(node.text ? { text: node.text } : {}),
      pageName: screen.name,
      measurement: {
        frame: node.runtimeStatus === "captured" ? "runtime" : "structural",
        properties: node.cornerRadius != null || node.backgroundColorToken != null || node.fontSize != null || node.fontStyle != null ? "declared" : "unavailable"
      }
    });
    node.children?.forEach((child, index) => visit(child, `${path}/${index}`));
  };
  visit(screen.uiTree, "0");
  return snapshots.slice(0, 500);
}

function intentValues(id: string, node: SwiftUiNode, intents: SemanticIntent[]) {
  let width = node.width;
  let height = node.height;
  let cornerRadius = node.cornerRadius;
  let fontSize = node.fontSize ?? (node.fontStyle ? fontSizes[node.fontStyle] : undefined);
  let backgroundColor = node.backgroundColorToken;
  let text = node.text;
  for (const intent of intents) {
    if (intent.node !== id) continue;
    if (intent.operation === "resize") {
      if (intent.axis === "horizontal") width = intent.to;
      else height = intent.to;
    }
    if (intent.operation === "set_property") {
      if (intent.property === "cornerRadius" && typeof intent.value === "number") cornerRadius = intent.value;
      if (intent.property === "fontSize" && typeof intent.value === "number") fontSize = intent.value;
      if (intent.property === "backgroundColor" && typeof intent.value === "string") backgroundColor = intent.value;
      if (intent.property === "text" && typeof intent.value === "string") text = intent.value;
    }
  }
  return { width, height, cornerRadius, fontSize, backgroundColor, text };
}

function color(value: string | undefined, fallback?: string) {
  if (!value) return fallback;
  if (value.startsWith("#") || value.startsWith("rgb") || value === "transparent") return value;
  return systemColors[value] ?? fallback;
}

function alignment(value: SwiftUiNode["alignment"], axis: "main" | "cross") {
  if (axis === "main") {
    if (value === "trailing" || value === "bottom") return "flex-end";
    if (value === "center") return "center";
    return "flex-start";
  }
  if (value === "trailing" || value === "bottom" || value === "bottomTrailing" || value === "topTrailing") return "flex-end";
  if (value === "center" || value === "top") return "center";
  return "flex-start";
}

function styleForNode(node: SwiftUiNode, id: string, intents: SemanticIntent[]): CSSProperties {
  const values = intentValues(id, node, intents);
  const padding = node.padding;
  const style: CSSProperties = {
    boxSizing: "border-box",
    color: color(node.colorToken, "#1c1c1e"),
    backgroundColor: color(values.backgroundColor),
    borderRadius: values.cornerRadius ?? (node.backgroundShape === "capsule" ? 999 : node.backgroundShape === "circle" ? "50%" : undefined),
    borderColor: color(node.borderColorToken),
    borderStyle: node.borderColorToken ? "solid" : undefined,
    borderWidth: node.borderColorToken ? node.borderWidth ?? 1 : undefined,
    fontSize: values.fontSize,
    fontWeight: fontWeights[node.fontWeight ?? "regular"],
    letterSpacing: node.tracking,
    lineHeight: node.lineSpacing && values.fontSize ? `${values.fontSize + node.lineSpacing}px` : undefined,
    opacity: node.opacity,
    padding: padding ? `${Math.max(0, padding.top)}px ${Math.max(0, padding.right)}px ${Math.max(0, padding.bottom)}px ${Math.max(0, padding.left)}px` : undefined,
    width: node.fillWidth ? "100%" : values.width,
    height: node.fillHeight ? "100%" : values.height,
    minWidth: node.type === "spacer" ? node.minLength : undefined,
    minHeight: node.type === "spacer" ? node.minLength : undefined,
    transform: node.offsetX || node.offsetY ? `translate(${node.offsetX ?? 0}px, ${node.offsetY ?? 0}px)` : undefined,
    boxShadow: node.shadowRadius ? `${node.shadowX ?? 0}px ${node.shadowY ?? 2}px ${node.shadowRadius}px rgba(0,0,0,${node.shadowOpacity ?? 0.16})` : undefined,
    filter: node.blurRadius ? `blur(${node.blurRadius}px)` : undefined,
    textAlign: node.textAlignment === "leading" ? "left" : node.textAlignment === "trailing" ? "right" : node.textAlignment
  };
  return style;
}

function contentForLeaf(node: SwiftUiNode, editedText?: string): ReactNode {
  const displayText = editedText ?? node.text;
  if (node.type === "text") return displayText ?? node.name ?? "Text";
  if (node.type === "symbol") return <span className="swift-symbol" title={node.symbol}>{symbolFallbacks[node.symbol ?? ""] ?? "◇"}</span>;
  if (node.type === "divider") return null;
  if (node.type === "spacer") return null;
  if (node.type === "progress") return <span className="swift-progress" />;
  if (node.type === "toggle") return <><span>{displayText || node.title || "Toggle"}</span><i className="swift-toggle-track"><b /></i></>;
  if (node.type === "field") return displayText || node.title || "Text field";
  if (node.type === "label") return <><span className="swift-symbol">{symbolFallbacks[node.symbol ?? ""] ?? "◇"}</span><span>{displayText || node.title || node.name || "Label"}</span></>;
  if (node.type === "button" && !node.children?.length) return displayText || node.title || node.name || "Button";
  if (node.type === "shape" && node.symbol) return <span className="swift-symbol">{symbolFallbacks[node.symbol] ?? "◇"}</span>;
  return null;
}

function containerStyle(node: SwiftUiNode): CSSProperties {
  if (node.type === "zstack") return { display: "grid", placeItems: alignment(node.alignment, "cross") };
  const horizontal = node.type === "hstack" || node.direction === "horizontal" || node.type === "label" || node.type === "toggle";
  if (["vstack", "hstack", "navigation", "scroll", "list", "section", "group", "tabview", "custom", "button", "label", "toggle"].includes(node.type)) {
    return {
      display: "flex",
      flexDirection: horizontal ? "row" : "column",
      gap: node.spacing ?? (node.type === "list" ? 1 : node.type === "section" ? 8 : 10),
      alignItems: node.type === "toggle" ? "center" : alignment(node.alignment, "cross"),
      justifyContent: node.type === "toggle" ? "space-between" : alignment(node.alignment, "main"),
      overflow: node.type === "scroll" || node.type === "list" ? "auto" : undefined
    };
  }
  return {};
}

export function SwiftUiStructuredCanvas({
  screen,
  viewport,
  scale,
  mode,
  intents,
  selectedId,
  hoveredId,
  screenshotDataUrl,
  showReference,
  onSelect,
  onHover,
  onResizeStart
}: {
  screen: DiscoveredScreen | null;
  viewport: { width: number; height: number };
  scale: number;
  mode: StudioMode;
  intents: SemanticIntent[];
  selectedId: string | null;
  hoveredId: string | null;
  screenshotDataUrl: string | null;
  showReference: boolean;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onResizeStart: (event: PointerEvent, node: DesignNodeSnapshot, axis: "horizontal" | "vertical") => void;
}) {
  if (!screen?.uiTree) return <div className="structured-empty">This view has no editable SwiftUI structure.</div>;
  const snapshots = new Map(collectStructuredNodes(screen, viewport.width).map((node) => [node.id, node]));

  const render = (node: SwiftUiNode, path: string): ReactNode => {
    const id = nodeId(node, screen, path);
    const selected = selectedId === id;
    const hovered = hoveredId === id;
    const values = intentValues(id, node, intents);
    const children = node.children?.map((child, index) => render(child, `${path}/${index}`));
    const click = (event: MouseEvent) => {
      if (mode !== "select") return;
      event.stopPropagation();
      onSelect(id);
    };
    const classes = [
      "swift-structure-node",
      `swift-${node.type}`,
      selected ? "is-selected" : "",
      hovered ? "is-hovered" : "",
      node.runtimeStatus === "captured" ? "is-runtime-measured" : "is-source-derived"
    ].filter(Boolean).join(" ");
    return (
      <div
        key={id}
        className={classes}
        data-node-id={id}
        data-source={node.sourceFile}
        style={{ ...containerStyle(node), ...styleForNode(node, id, intents) }}
        onClick={click}
        onMouseEnter={(event) => { event.stopPropagation(); if (mode === "select") onHover(id); }}
        onMouseLeave={(event) => { event.stopPropagation(); if (hoveredId === id) onHover(null); }}
      >
        {node.type === "navigation" && node.title && <div className="swift-navigation-title">{node.title}</div>}
        {contentForLeaf(node, values.text)}
        {children}
        {(selected || hovered) && mode === "select" && <span className="structured-node-tag">{nodeName(node)}</span>}
        {selected && mode === "select" && snapshots.get(id) && <>
          <i className="structured-resize-handle is-right" onPointerDown={(event) => onResizeStart(event, snapshots.get(id)!, "horizontal")} />
          <i className="structured-resize-handle is-bottom" onPointerDown={(event) => onResizeStart(event, snapshots.get(id)!, "vertical")} />
        </>}
      </div>
    );
  };

  return (
    <div className="structured-viewport" style={{ width: viewport.width, height: viewport.height, transform: `scale(${scale})` }}>
      <div className="structured-status-bar"><strong>9:41</strong><span>● ● ◉</span></div>
      <div className="structured-page" onClick={() => mode === "select" && onSelect(nodeId(screen.uiTree!, screen, "0"))}>
        {render(screen.uiTree, "0")}
      </div>
      {showReference && screenshotDataUrl && <img className="structured-reference" src={screenshotDataUrl} alt="Simulator reference" />}
    </div>
  );
}
