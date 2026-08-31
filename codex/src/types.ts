export type ScreenStatus = "observed" | "proposed" | "modified" | "deleted";

export type SourceRef = { file: string; line: number; column: number; component?: string };

export type CanvasSelection =
  | { kind: "screen"; screenId: string; sourceRef?: SourceRef | null }
  | { kind: "edge"; edgeId: string; sourceRef?: SourceRef | null }
  | {
      kind: "node";
      screenId: string;
      nodeId: string;
      name?: string;
      sourceRef?: SourceRef | null;
      pointer?: { x: number; y: number; clientX: number; clientY: number };
    };

export type NormalizedPoint = { x: number; y: number };

export type NormalizedBounds = NormalizedPoint & { width: number; height: number };

export type CrankVisualAnnotation = {
  version: 1;
  id: string;
  inventoryId: string;
  screenId: string;
  screenName: string;
  comment: string;
  target: {
    kind: "node" | "point";
    point: NormalizedPoint;
    boundingBox?: NormalizedBounds;
    nodeId?: string;
    name?: string;
    sourceRef?: SourceRef | null;
  };
  createdAt: string;
};

export type GraphScreen = {
  id: string;
  name: string;
  route?: string;
  annotation?: string;
  status: ScreenStatus;
  sourceRef?: SourceRef;
};

export type GraphEdge = {
  id: string;
  fromScreenId: string;
  toScreenId: string;
  status: ScreenStatus;
  trigger?: { type?: "click" | "submit" | "route" | "redirect" | "automatic" | "state-change" | "unknown"; label?: string };
  condition?: string;
  action?: string;
  sourceRef?: SourceRef;
};

export type AppGraph = {
  version: 1;
  project: { name: string; root?: string; inventoryId?: string };
  screens: GraphScreen[];
  edges: GraphEdge[];
  groups: unknown[];
  annotations: unknown[];
};

export type CanvasScene = {
  version: 1;
  layoutVersion?: number;
  stateVersion: number;
  inventoryId: string;
  view: "map" | "screens";
  showPreviews: boolean;
  nodes: Array<{ id: string; x: number; y: number }>;
  selection: CanvasSelection | null;
  updatedAt: string;
};

export type CanvasPayload = {
  inventoryId: string;
  observedGraph: AppGraph;
  intentGraph: AppGraph;
  scene: CanvasScene;
  stateVersion: number;
  exportSettings: { figmaUrl: string | null };
};

export type CrankJob = {
  id: string;
  kind: string;
  state: "running" | "complete" | "error";
  progress?: unknown;
  result?: unknown;
  error?: string | null;
};

export type FigmaSendResult = {
  ok: boolean;
  message?: string | null;
  pairingCode?: string;
  expiresAt?: string;
  screenCount?: number;
  requiresPairing?: boolean;
  fileName?: string;
  fileKey?: string;
  missing?: string[];
  missingReasons?: string[];
  dropped?: string[];
  substitutedFonts?: string[];
};

export type FigmaSyncStatus = {
  state: "waiting" | "running" | "complete" | "error" | "expired";
  expiresAt?: string;
  createdCount?: number;
  reusedCount?: number;
  renderedCount?: number;
  substitutedFonts?: string[];
  message?: string | null;
};

export type PaperCopyResult = {
  ok: boolean;
  message?: string | null;
  screens?: string[];
  missing?: string[];
  dropped?: string[];
};

export type PaperPushResult = {
  ok: boolean;
  message?: string | null;
  created?: string[];
  updated?: string[];
  failed?: Array<{ name: string; reason: string }>;
  fileName?: string | null;
  missing?: string[];
  dropped?: string[];
};

export type ScreenPreview =
  | { state: "loading" }
  | { state: "ready"; dataUrl: string }
  | { state: "error"; message: string };

export type PageDocument =
  | {
      kind: "layers";
      width: number;
      height: number;
      layerTree: { width: number; height: number; tree: unknown };
      dataUrl?: string;
    }
  | {
      kind: "image";
      width: number;
      height: number;
      dataUrl: string;
    };

export type PageDocumentState =
  | { state: "loading" }
  | { state: "ready"; document: PageDocument }
  | { state: "error"; message: string };

export type PreparedReview = {
  inventoryId: string;
  screenId: string;
  url: string;
  hasEditableLayers: boolean;
};
