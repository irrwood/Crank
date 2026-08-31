export type GraphScreen = {
  id: string;
  name: string;
  route?: string;
  annotation?: string;
  status: "observed" | "proposed" | "modified" | "deleted";
  sourceRef?: SourceRef;
};

export type SourceRef = { file: string; line: number; column: number; component?: string };

export type GraphEdge = {
  id: string;
  fromScreenId: string;
  toScreenId: string;
  status: "observed" | "proposed" | "modified" | "deleted";
  trigger?: {
    type?: "click" | "submit" | "route" | "redirect" | "automatic" | "state-change" | "unknown";
    label?: string;
  };
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

export type GraphDiff = {
  addedScreens: Array<{ after: GraphScreen }>;
  removedScreens: Array<{ before: GraphScreen }>;
  modifiedScreens: Array<{ before: GraphScreen; after: GraphScreen }>;
  addedEdges: Array<{ after: GraphEdge }>;
  removedEdges: Array<{ before: GraphEdge }>;
  modifiedEdges: Array<{ before: GraphEdge; after: GraphEdge }>;
  annotations: unknown[];
  groupChanges: unknown[];
};

export type ChangeOperation = {
  type: "add_screen" | "remove_screen" | "update_screen" | "add_transition" | "remove_transition" | "change_transition";
  description: string;
  [key: string]: unknown;
};

export type ChangeManifest = {
  version: string;
  flow: string;
  summary: string;
  changes: ChangeOperation[];
  annotations: unknown[];
  affectedSources: unknown[];
};

export function cloneAppGraph(graph: AppGraph): AppGraph;
export function reconnectIntentEdge(graph: AppGraph, edgeId: string, sourceScreenId: string, targetScreenId: string): AppGraph;
export function diffAppGraphs(observedGraph: AppGraph, intentGraph: AppGraph): GraphDiff;
export function diffCount(diff: GraphDiff): number;
export function buildChangeManifest(observedGraph: AppGraph, intentGraph: AppGraph): ChangeManifest;
export function buildCodexFlowPrompt(observedGraph: AppGraph, intentGraph: AppGraph, manifest?: ChangeManifest): string;
