export type PaintedLayer = {
  tag: "div" | "img";
  style: Record<string, string | number | undefined>;
  src?: string;
  text?: string;
  children: unknown[];
};

export function paintLayer(layer: unknown): PaintedLayer;
export function styleText(style: Record<string, unknown>): string;
