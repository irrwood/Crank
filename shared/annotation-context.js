/**
 * Turns visual comments staged in Crank into compact model-visible context.
 *
 * The canvas may hold large captured trees, but the next Codex message needs
 * only the selected screen, deterministic node/source identity, coordinates,
 * and what the person asked to change. Keeping that reduction here prevents a
 * renderer refactor from silently sending a whole page through the host bridge.
 */

function percent(value) {
  return `${Math.round(Math.min(1, Math.max(0, Number(value) || 0)) * 100)}%`;
}

export function formatCrankAnnotationContext(annotations) {
  if (!Array.isArray(annotations) || annotations.length === 0) return "";
  const lines = annotations.map((annotation, index) => {
    const target = annotation?.target ?? {};
    const point = target.point ?? {};
    const identity = target.nodeId
      ? target.name ? `\"${target.name}\"` : "selected UI element"
      : `page point ${percent(point.x)}, ${percent(point.y)}`;
    const source = target.sourceRef?.file
      ? ` (${target.sourceRef.file}:${target.sourceRef.line})`
      : "";
    return `${index + 1}. ${annotation.screenName}, ${identity}${source}: ${annotation.comment}`;
  });
  return `Crank comments:\n${lines.join("\n")}`;
}
