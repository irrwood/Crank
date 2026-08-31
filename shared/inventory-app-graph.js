/**
 * Turns one stored capture into the small, semantic graph shared by both Crank
 * products. The capture remains the evidence: direct routes come from anchors
 * Chromium observed, while nested states come only from replayable click paths.
 * Keeping this outside either renderer prevents the desktop and Codex canvases
 * from showing different flows for the same inventory.
 */

function recipeKey(recipe = []) {
  return recipe.map((step) => `${step.kind}:${step.locator}`).join(">");
}

function routeKey(value = "/") {
  try {
    const parsed = new URL(value, "https://crank.invalid/");
    if (parsed.hash.startsWith("#/")) return parsed.hash.slice(1).replace(/\/$/, "") || "/";
    return `${parsed.pathname.replace(/\/$/, "") || "/"}${parsed.search}`;
  } catch {
    return String(value).replace(/\/$/, "") || "/";
  }
}

function projectName(inventory, fallback) {
  const target = inventory.source?.target;
  if (!target) return fallback;
  try {
    const url = new URL(target);
    return url.hostname || fallback;
  } catch {
    const parts = target.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) || fallback;
  }
}

function sourceRef(value) {
  const match = /^(.+):(\d+):(\d+)$/.exec(String(value ?? ""));
  if (!match) return null;
  return { file: match[1], line: Number(match[2]), column: Number(match[3]) };
}

function firstSourceRef(page) {
  const visit = (node) => {
    if (!node || typeof node !== "object") return null;
    const own = sourceRef(node.source);
    if (own) return own;
    for (const child of node.children ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(page?.layerTree?.tree) ?? sourceRef(page?.uiTree?.sourceHint);
}

function triggerSourceRef(page, label) {
  const wanted = String(label ?? "").trim().toLocaleLowerCase();
  if (!wanted) return firstSourceRef(page);
  const containsLabel = (node) => {
    if (!node || typeof node !== "object") return false;
    if ([node.name, node.text].some((value) => String(value ?? "").trim().toLocaleLowerCase() === wanted)) return true;
    return (node.children ?? []).some(containsLabel);
  };
  const visit = (node) => {
    if (!node || typeof node !== "object") return null;
    const own = sourceRef(node.source);
    if (own && containsLabel(node)) return own;
    for (const child of node.children ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    return null;
  };
  return visit(page?.layerTree?.tree) ?? firstSourceRef(page);
}

function directRouteEdges(pages) {
  const direct = pages.filter((page) => (page.recipe ?? []).length === 0);
  const byRoute = new Map();
  for (const page of direct) {
    const key = routeKey(page.route);
    if (!byRoute.has(key)) byRoute.set(key, page);
  }
  const candidates = direct.map((page) => {
    const links = page.snapshot?.links ?? [];
    const targets = new Set(links.map((link) => routeKey(link.href)).filter((route) => byRoute.has(route)));
    targets.delete(routeKey(page.route));
    return { page, links, targetCount: targets.size };
  });
  const root = candidates.find((candidate) => routeKey(candidate.page.route) === "/")
    ?? candidates.slice().sort((left, right) => right.targetCount - left.targetCount)[0];
  if (!root || root.targetCount === 0) return [];

  const linked = new Set();
  return root.links.flatMap((link) => {
    const target = byRoute.get(routeKey(link.href));
    if (!target || target.id === root.page.id || linked.has(target.id)) return [];
    linked.add(target.id);
    return [{
      id: `route:${root.page.id}:${target.id}`,
      fromScreenId: root.page.id,
      toScreenId: target.id,
      status: "observed",
      trigger: { type: "route", label: link.label || target.name },
      ...(triggerSourceRef(root.page, link.label) ? { sourceRef: triggerSourceRef(root.page, link.label) } : {})
    }];
  });
}

function actionEdges(pages) {
  return pages.flatMap((page) => {
    const recipe = page.recipe ?? [];
    if (recipe.length === 0) return [];
    const parentRecipe = recipe.slice(0, -1);
    const parentKey = recipeKey(parentRecipe);
    const parent = pages.find((candidate) => (
      candidate.id !== page.id
      && candidate.route === page.route
      && (candidate.recipe ?? []).length === parentRecipe.length
      && recipeKey(candidate.recipe) === parentKey
    ));
    if (!parent) return [];
    const step = recipe.at(-1);
    return [{
      id: `action:${parent.id}:${page.id}`,
      fromScreenId: parent.id,
      toScreenId: page.id,
      status: "observed",
      trigger: { type: "click", label: step?.label || page.name },
      action: step?.locator || undefined,
      ...(triggerSourceRef(parent, step?.label) ? { sourceRef: triggerSourceRef(parent, step?.label) } : {})
    }];
  });
}

export function buildInventoryAppGraph(inventory, { inventoryId = null, name = "Captured app" } = {}) {
  if (!inventory?.ok) throw new Error("Only a successful Crank inventory can become an app graph.");
  const pages = inventory.pages ?? [];
  return {
    version: 1,
    project: {
      name: projectName(inventory, name),
      root: inventory.source?.kind === "folder" ? inventory.source.target : undefined,
      inventoryId: inventoryId ?? undefined
    },
    screens: pages.map((page) => ({
      id: page.id,
      name: page.name,
      route: page.route || undefined,
      status: "observed",
      annotation: "",
      ...(firstSourceRef(page) ? { sourceRef: firstSourceRef(page) } : {})
    })),
    edges: [...directRouteEdges(pages), ...actionEdges(pages)],
    groups: [],
    annotations: []
  };
}
