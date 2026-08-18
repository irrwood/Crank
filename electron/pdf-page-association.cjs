function associatePdfPagesWithScreens(pages, screens, snapshot) {
  const viewport = snapshot?.environment?.viewport;
  if (!viewport || !Array.isArray(pages) || !Array.isArray(screens)) return pages;
  const viewportArea = Math.max(1, viewport.width * viewport.height);
  const capturesById = new Map();
  for (const node of snapshot.nodes || []) {
    const previous = capturesById.get(node.syncId);
    if (!previous || Date.parse(node.capturedAt || snapshot.capturedAt) >= Date.parse(previous.capturedAt || snapshot.capturedAt)) {
      capturesById.set(node.syncId, node);
    }
  }
  const capturedScreens = screens
    .filter((screen) => screen.sourceType !== "component" && !screen.patterns?.includes("Tab navigation"))
    .map((screen) => ({ screen, capture: capturesById.get(screen.uiTree?.syncId) }))
    .filter(({ capture }) => capture && capture.frame.width * capture.frame.height >= viewportArea * 0.45)
    .sort((left, right) => Date.parse(left.capture.capturedAt || snapshot.capturedAt) - Date.parse(right.capture.capturedAt || snapshot.capturedAt));
  const screensBySourceName = new Map(screens
    .filter((screen) => screen.uiTree?.sourceName)
    .map((screen) => [screen.uiTree.sourceName, screen]));
  const usedScreenIds = new Set();
  return pages.map((page, index) => {
    const explicit = page.sourceName ? screensBySourceName.get(page.sourceName) : null;
    const source = explicit ?? capturedScreens.map((candidate) => candidate.screen).find((screen) => !usedScreenIds.has(screen.id)) ?? capturedScreens[index]?.screen;
    if (source) usedScreenIds.add(source.id);
    return source ? { ...page, sourceScreenId: source.id, sourceScreenName: source.name } : page;
  });
}

module.exports = { associatePdfPagesWithScreens };
