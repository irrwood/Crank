export type FlowLayoutEdge = { fromScreenId: string; toScreenId: string };
export type FlowLayoutStyle = "flow" | "vertical" | "grid";

export type FlowLayoutOptions = {
  width: number;
  height: number;
  ranksep: number;
  nodesep: number;
  marginx: number;
  marginy: number;
  style?: FlowLayoutStyle;
  maxRankRows?: number;
};

export function layoutScreenPositions(
  screenIds: string[],
  edges: FlowLayoutEdge[],
  options: FlowLayoutOptions
): Array<{ id: string; x: number; y: number }>;
