export type PageViewport = {
  pageWidth: number;
  pageHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  inset?: number;
  minZoom?: number;
  maxZoom?: number;
};

export function fitPageToViewport(viewport: PageViewport): number | null;

export function measureAtViewportSettlingPoints(
  measure: () => void,
  setTimer: (callback: () => void, delay: number) => number,
  clearTimer: (timerId: number) => void,
  delays?: number[]
): () => void;
