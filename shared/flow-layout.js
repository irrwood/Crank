import { graphlib, layout } from "@dagrejs/dagre";

/**
 * Computes semantic screen positions without React or the DOM. Dagre mutates
 * each node label with its final coordinates, so every screen must receive a
 * distinct size object; sharing one object collapsed the whole Codex map onto
 * the final node even though all ten captured previews had loaded correctly.
 */

export function layoutScreenPositions(screenIds, edges, options) {
  if (options.style === "grid") {
    // Grid is the deliberately non-semantic overview: it follows inventory
    // order so a dense project can be scanned without long edge-driven ranks.
    const columns = Math.max(1, Math.ceil(Math.sqrt(screenIds.length)));
    return screenIds.map((id, index) => ({
      id,
      x: options.marginx + (index % columns) * (options.width + options.ranksep),
      y: options.marginy + Math.floor(index / columns) * (options.height + options.nodesep)
    }));
  }

  const incoming = new Map(screenIds.map((id) => [id, 0]));
  const outgoing = new Map(screenIds.map((id) => [id, 0]));
  for (const edge of edges) {
    incoming.set(edge.toScreenId, (incoming.get(edge.toScreenId) ?? 0) + 1);
    outgoing.set(edge.fromScreenId, (outgoing.get(edge.fromScreenId) ?? 0) + 1);
  }
  const roots = screenIds.filter((id) => (incoming.get(id) ?? 0) === 0);
  const fanRoot = roots.length === 1 ? roots[0] : null;
  const isPureFanOut = options.style !== "vertical"
    && fanRoot
    && screenIds.length >= 6
    && edges.length === screenIds.length - 1
    && (outgoing.get(fanRoot) ?? 0) === edges.length
    && screenIds.every((id) => id === fanRoot || (incoming.get(id) === 1 && outgoing.get(id) === 0));

  if (isPureFanOut) {
    // A launch page that opens many independent projects is a hub, not a deep
    // funnel. Drawing its destinations in successive columns invented a false
    // hierarchy, while one tall Dagre rank made every preview unreadable. A
    // radial hub keeps every destination at the same visual distance and gives
    // each direct edge its own corridor.
    const children = screenIds.filter((id) => id !== fanRoot);
    const radiusX = Math.max(options.width * 2.45, 500);
    const radiusY = Math.max(options.height * 1.9, 400);
    const centerX = options.marginx + radiusX + options.width / 2;
    const centerY = options.marginy + radiusY + options.height / 2;
    const positions = [{ id: fanRoot, x: centerX - options.width / 2, y: centerY - options.height / 2 }];
    children.forEach((id, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / children.length;
      positions.push({
        id,
        x: centerX + Math.cos(angle) * radiusX - options.width / 2,
        y: centerY + Math.sin(angle) * radiusY - options.height / 2
      });
    });
    return positions;
  }

  const graph = new graphlib.Graph();
  graph.setDefaultEdgeLabel(() => ({}));
  graph.setGraph({
    rankdir: options.style === "vertical" ? "TB" : "LR",
    ranksep: options.ranksep,
    nodesep: options.nodesep,
    marginx: options.marginx,
    marginy: options.marginy
  });
  for (const id of screenIds) {
    graph.setNode(id, { width: options.width, height: options.height });
  }
  for (const edge of edges) graph.setEdge(edge.fromScreenId, edge.toScreenId);
  layout(graph);

  const points = screenIds.map((id) => ({ id, ...(graph.node(id) ?? { x: 0, y: 0 }) }));

  // A rank is meaning, not merely a packing hint. Keep ordinary Dagre ranks on
  // one axis even when the infinite canvas needs panning.

  return points.map((point) => {
    return {
      id: point.id,
      x: point.x - options.width / 2,
      y: point.y - options.height / 2
    };
  });
}
