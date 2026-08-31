/**
 * Keeps a page viewer fitted while its MCP host changes the iframe viewport.
 *
 * Codex can acknowledge fullscreen before the containing panel has finished
 * animating to its final size. Measuring on every animation frame caused an
 * iframe/content ResizeObserver feedback loop in the real host, and Chromium
 * withheld the first vector paint until the user resized the window. A few
 * bounded settling measurements catch the late host resize without keeping a
 * layout loop alive.
 */

export function fitPageToViewport({ pageWidth, pageHeight, viewportWidth, viewportHeight, inset = 56, minZoom = 0.08, maxZoom = 1 }) {
  if (![pageWidth, pageHeight, viewportWidth, viewportHeight].every((value) => Number.isFinite(value) && value > 0)) return null;
  if (viewportWidth <= inset || viewportHeight <= inset) return null;
  return Math.min(maxZoom, Math.max(minZoom, Math.min(
    (viewportWidth - inset) / pageWidth,
    (viewportHeight - inset) / pageHeight
  )));
}

export function measureAtViewportSettlingPoints(
  measure,
  setTimer,
  clearTimer,
  delays = [80, 240, 600, 1200]
) {
  const timerIds = delays.map((delay) => setTimer(measure, delay));
  return () => {
    for (const timerId of timerIds) clearTimer(timerId);
  };
}
