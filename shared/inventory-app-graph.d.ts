import type { AppGraph } from "./app-graph.js";

export type InventoryPage = {
  id: string;
  name: string;
  route?: string;
  recipe?: Array<{ kind?: string; locator: string; label?: string }>;
  snapshot?: { links?: Array<{ href: string; label: string }> } | null;
  layerTree?: { tree?: unknown } | null;
  uiTree?: { sourceHint?: string } | null;
};

export type SuccessfulInventory = {
  ok: true;
  source?: { kind: "folder" | "url"; target: string };
  pages: InventoryPage[];
};

export function buildInventoryAppGraph(
  inventory: SuccessfulInventory,
  options?: { inventoryId?: string | null; name?: string }
): AppGraph;
