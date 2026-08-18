export type ProjectInfo = {
  id: string;
  root: string;
  name: string;
  kind: "web" | "desktop" | "swiftui";
  framework: string;
  analysisEngine: string;
  runtimeCapture?: {
    state: "not-run" | "running" | "captured" | "error";
    capturedAt?: string;
    capturedNodeCount?: number;
    screenCount?: number;
    deviceName?: string;
    message?: string;
  };
  figmaFileName: string | null;
  frameName: string | null;
  frameNodeId: string | null;
  fileKey: string | null;
  linkedCount: number;
  revision: number;
  snapshotCount: number;
  lastOrigin: string;
  lastSyncedAt: string | null;
  connectionStatus: "connected" | "setup";
  sourceFileCount: number;
  codexThreadId?: string | null;
  screens: DiscoveredScreen[];
};

export type DiscoveredScreen = {
  id: string;
  name: string;
  sourceType: "screen" | "modal" | "component";
  patterns: string[];
  sfSymbolCount: number;
  semanticColorCount: number;
  hasCustomFont: boolean;
  captureView?: AppView | null;
  captureEntry?: string | null;
  capturePath?: string | null;
  uiTree?: SwiftUiNode;
  runtimeCapture?: {
    state: "captured" | "static-fallback";
    capturedNodeCount: number;
    totalNodeCount: number;
    capturedAt: string;
    isVisualReference?: boolean;
  };
  figmaNodeId?: string | null;
  figmaFrameName?: string | null;
};

export type SwiftUiNode = {
  syncId?: string;
  sourceFile?: string;
  sourceName?: string;
  sourceExpression?: string;
  sourceRange?: { line: number; column: number; startOffset: number; endOffset: number };
  runtimeFrame?: { x: number; y: number; width: number; height: number };
  runtimeInstances?: Array<{ instanceId: string; x: number; y: number; width: number; height: number }>;
  runtimeStatus?: "captured";
  runtimeTextCaptured?: boolean;
  runtimeAssetCaptured?: boolean;
  runtimeEnvironment?: {
    viewport: { x: number; y: number; width: number; height: number };
    displayScale: number;
    colorScheme: "light" | "dark";
    dynamicTypeSize: string;
    layoutDirection: "leftToRight" | "rightToLeft";
  };
  visualMode?: "editable" | "snapshot-fallback";
  visualConfidence?: "high" | "medium" | "low";
  fallbackAssetId?: string;
  type: "navigation" | "vstack" | "hstack" | "zstack" | "scroll" | "list" | "section" | "text" | "label" | "symbol" | "button" | "toggle" | "field" | "divider" | "spacer" | "shape" | "progress" | "custom" | "group" | "tabview";
  name?: string;
  assetName?: string;
  text?: string;
  textKey?: string;
  symbol?: string;
  title?: string;
  direction?: "vertical" | "horizontal";
  alignment?: "leading" | "center" | "trailing" | "top" | "bottom" | "topLeading" | "topTrailing" | "bottomLeading" | "bottomTrailing";
  spacing?: number;
  fontStyle?: "largeTitle" | "title" | "title2" | "title3" | "headline" | "subheadline" | "body" | "callout" | "footnote" | "caption" | "caption2";
  fontWeight?: "regular" | "medium" | "semibold" | "bold" | "heavy" | "black";
  fontSize?: number;
  colorToken?: string;
  backgroundColorToken?: string;
  borderColorToken?: string;
  backgroundShape?: "rectangle" | "roundedRectangle" | "capsule" | "circle";
  padding?: { top: number; right: number; bottom: number; left: number };
  cornerRadius?: number;
  borderWidth?: number;
  opacity?: number;
  colorOpacity?: number;
  backgroundOpacity?: number;
  borderOpacity?: number;
  tracking?: number;
  lineSpacing?: number;
  textAlignment?: "leading" | "center" | "trailing";
  width?: number;
  height?: number;
  minLength?: number;
  offsetX?: number;
  offsetY?: number;
  blurRadius?: number;
  shadowRadius?: number;
  shadowColorToken?: string;
  shadowOpacity?: number;
  shadowX?: number;
  shadowY?: number;
  material?: "ultraThin" | "thin" | "regular" | "thick" | "ultraThick" | "glass" | "glassProminent";
  controlSize?: "mini" | "small" | "regular" | "large" | "extraLarge";
  isEnabled?: boolean;
  destructive?: boolean;
  fillWidth?: boolean;
  fillHeight?: boolean;
  tabTitle?: string;
  tabSymbol?: string;
  children?: SwiftUiNode[];
};

export type ProjectKind = ProjectInfo["kind"];

export type ProjectPreview = {
  screenId: string;
  screenshotDataUrl: string;
  width: number;
  height: number;
};

export type LivePreviewBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type LivePreviewSession = {
  url: string;
  origin: string;
  command: string;
  /** True when an already-running dev server was reused instead of spawned. */
  attached: boolean;
  blockedHosts: string[];
};

export type LivePreviewStatus = {
  running: boolean;
  url: string | null;
  command: string | null;
  attached: boolean;
  reason: "no-manifest" | "no-dev-script" | "dependencies-missing" | "package-manager-missing" | null;
  message: string | null;
};

export type SyncDirection = "to-figma" | "to-local";
export type AppView = "connections";
export type ReviewState = "idle" | "checking" | "review" | "syncing" | "complete";

export type AutomaticMappingSession = {
  pairingCode: string;
  expiresAt: string;
  screenCount: number;
  requiresPairing: boolean;
};

export type AutomaticMappingStatus = {
  state: "waiting" | "running" | "complete" | "error" | "expired";
  expiresAt?: string;
  createdCount?: number;
  reusedCount?: number;
  renderedCount?: number;
  /** Families the page asked for that Figma does not have. */
  substitutedFonts?: string[];
  message?: string | null;
  project?: ProjectInfo;
  pullPreview?: PullPreview | null;
};

export type PullPreviewChange = {
  id: string;
  screenId: string;
  area: string;
  property: string;
  before: unknown;
  after: unknown;
  route: "automatic" | "codex";
};

export type PullPreview = {
  changes: PullPreviewChange[];
  conflicts: Array<{ id: string; property: string; base: unknown; code: unknown; figma: unknown }>;
  rejected: Array<{ id: string; reason: string }>;
};

export type PullApplyResult = { changedFiles: string[]; validation: string[]; needsCodex: boolean };

export type CodexSyncResult = {
  project: ProjectInfo;
  changedFiles: string[];
  validation: string[];
  summary: string;
  codexThreadId: string;
};

export type DesignBuildResult = {
  project: ProjectInfo;
  capturedNodeCount: number;
  screenCount: number;
  deviceName: string;
  vectorReady?: boolean;
  vectorMessage?: string | null;
};

export type DesignNodeSnapshot = {
  id: string;
  name: string;
  frame: { x: number; y: number; width: number; height: number };
  cornerRadius: number | null;
  backgroundColor: string | null;
  fontSize: number | null;
  sourceHint: string;
  text?: string;
  pageName?: string;
  measurement: { frame: "runtime" | "structural"; properties: "declared" | "runtime" | "unavailable" };
};

export type SwiftUiDesignSession = {
  state: "needs-capture" | "ready";
  project: ProjectInfo;
  nodes: DesignNodeSnapshot[];
  pdfDataUrl: string | null;
  pdfReady: boolean;
  pages?: Array<{
    id: string;
    pageNumber: number;
    name: string;
    width: number;
    height: number;
    pdfDataUrl: string;
    pdfPageNumber: number;
    previewDataUrl: string;
    renderSource?: "image-renderer" | "window-fallback";
    systemTabBar?: {
      designKit?: string;
      appearance?: "classic" | "liquid-glass";
      selectedIndex: number;
      items: Array<{ title: string; systemImage: string; sourceName: string }>;
    };
    sourceScreenId?: string;
    sourceScreenName?: string;
  }>;
  screenshotDataUrl: string | null;
  vectorSvgDataUrl?: string | null;
  vectorReady?: boolean;
  vectorMessage?: string | null;
  viewport: { x: number; y: number; width: number; height: number } | null;
  deviceName: string | null;
  capturedAt: string | null;
};

export type EditContext = {
  device: string;
  canvasWidth: number;
  containerWidth: number;
  safeAreaInsets: { leading: number; trailing: number };
  dynamicTypeSize: string;
  siblings: Record<string, number>;
};

export type SemanticIntent =
  | { id: string; node: string; operation: "resize"; axis: "horizontal" | "vertical"; from: number; to: number; delta: number; context: EditContext }
  | { id: string; node: string; operation: "set_property"; property: "cornerRadius" | "backgroundColor" | "fontSize" | "text"; from: number | string | null; value: number | string }
  | { id: string; node: string; operation: "move_after"; target: string; alignment?: "leading" | "center" | "trailing" }
  | { id: string; node: string; operation: "set_alignment"; value: "leading" | "center" | "trailing" };

export type VisualEditCheck = {
  operationId: string;
  node: string;
  property: string;
  desired: unknown;
  actual: unknown;
  delta: number | null;
  passed: boolean | null;
};

export type VisualEditResult = {
  state: "awaiting-review";
  branchName: string;
  iterations: number;
  converged: boolean;
  changedFiles: string[];
  checks: VisualEditCheck[];
  summary: string;
};

export type SemanticChange = {
  id: string;
  area: string;
  property: string;
  before: string;
  after: string;
  kind: "spacing" | "shape" | "size" | "color";
};

export type HtmlSnapshot = {
  html: string;
  bytes: number;
  stats: {
    stylesheets: number;
    inlinedAssets: number;
    /** Only what genuinely holds pixels: canvas bitmaps, video frames. */
    rasterised: string[];
    skippedAssets: string[];
    svgPreserved: number;
  };
};

/** The layer tree the Figma plugin builds from, keyed for stable re-matching. */
export type FigmaTree = { width: number; height: number; tree: unknown };

export type PageVariant = {
  id: string;
  /** Named after the control that produced it — "Dark", "中文". */
  name: string;
  route: string;
  recipe: Array<{ kind: string; locator: string; label: string }>;
  thumbnail: { dataUrl: string; width: number; height: number } | null;
  snapshot: HtmlSnapshot | null;
};

export type DiscoveredPage = {
  id: string;
  name: string;
  signature: string;
  /** Address to load first; "/" when the page lives at the app root. */
  route: string;
  url: string;
  /** Clicks to replay after loading `route`. Empty when directly addressable. */
  recipe: Array<{ kind: string; locator: string; label: string }>;
  depth: number;
  thumbnail: { dataUrl: string; width: number; height: number } | null;
  /** The rendered markup: sharp at any zoom, text selectable, SVG intact. */
  snapshot: HtmlSnapshot | null;
  /** Layers ready for Figma, captured on the same visit as the markup. */
  layerTree: FigmaTree | null;
  /** The same page re-skinned — theme or language — not separate pages. */
  variants: PageVariant[];
};

export type ForeignProject = {
  kind: string;
  commands: Array<{ source: string; command: string }>;
  port: number | null;
};

export type InventoryTarget = {
  /** The app's own icon, captured from the page that declares it. */
  icon?: string | null;
  id: string;
  kind: "folder" | "url";
  target: string;
  name: string;
  addedAt: string | null;
  lastScannedAt: string | null;
  pageCount: number | null;
  /** The workspace this was picked out of, when it was. */
  parent: string | null;
};

/** A folder holding several scanned packages, shown as one expandable entry. */
export type InventoryGroup = {
  kind: "group";
  id: string;
  name: string;
  target: string;
  /** The workspace's own scan, when it has one. */
  root: InventoryTarget | null;
  children: InventoryTarget[];
};

export type WorkspacePackage = { root: string; name: string };

export type PageInventory =
  | { ok: false; message: string; reason?: string; packages?: WorkspacePackage[]; foreign?: ForeignProject }
  | {
      ok: true;
      /** Where the pages were served from on this run — a fresh port each scan. */
      origin: string;
      /** What was scanned: the folder, or the address as typed. Stable. */
      source?: { kind: "folder" | "url"; target: string };
      pages: DiscoveredPage[];
      /** Controls skipped because their label reads as destructive. */
      skipped: Array<{ label: string; reason: string }>;
      /** States left out for changing too little, with the measured ratio. */
      filtered: Array<{ label: string; from: string; reason: string; magnitude: number }>;
      /** Controls that left the page exactly as it was — they did nothing. */
      inert?: Array<{ label: string; from: string }>;
      sources: { sitemap: number; seeds: number; crawled: number };
      blocked: { mutations: string[]; external: string[] };
    };

export type PageInventoryFiltered = { label: string; from: string; reason: string; magnitude: number };

export type ScanStatus = { phase: "starting" | "scanning" | "capturing"; detail: string; id?: string };

/** Which target a background scan belongs to, so it can run while you look elsewhere. */
export type ScanLifecycle = {
  phase: "started" | "finished";
  id: string;
  kind?: "folder" | "url";
  target?: string;
  ok?: boolean;
};

export type ScanProgress = { name: string; route: string; depth: number; id?: string };
