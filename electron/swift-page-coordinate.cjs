function normalizeSwiftTreeForPdfPage(node, contentFrame, pageSize, isRoot = true) {
  if (!node || typeof node !== "object") return node;
  const offsetFrame = (frame) => frame ? {
    ...frame,
    x: Math.round((frame.x - contentFrame.x) * 100) / 100,
    y: Math.round((frame.y - contentFrame.y) * 100) / 100
  } : frame;
  const children = node.children?.map((child) => normalizeSwiftTreeForPdfPage(child, contentFrame, pageSize, false));
  return {
    ...node,
    ...(node.runtimeFrame ? { runtimeFrame: offsetFrame(node.runtimeFrame) } : {}),
    ...(node.runtimeInstances ? { runtimeInstances: node.runtimeInstances.map(offsetFrame) } : {}),
    ...(isRoot && node.runtimeEnvironment ? {
      runtimeEnvironment: {
        ...node.runtimeEnvironment,
        viewport: { x: 0, y: 0, width: pageSize.width, height: pageSize.height }
      }
    } : {}),
    ...(children ? { children } : {})
  };
}

module.exports = { normalizeSwiftTreeForPdfPage };
