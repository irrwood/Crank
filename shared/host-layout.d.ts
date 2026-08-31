export type HostDisplayMode = "inline" | "fullscreen" | "pip";

export type HostLayout = {
  mode: HostDisplayMode;
  revision: number;
};

export function advanceHostLayout(
  current: HostLayout,
  nextMode?: HostDisplayMode
): HostLayout;
