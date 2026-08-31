/**
 * Turns every MCP host-context notification into a distinct layout signal.
 *
 * Codex can acknowledge fullscreen before its iframe has reached the final
 * size. The later notification may repeat `fullscreen`, or carry only updated
 * safe-area/height fields. Treating display mode as the whole state made React
 * discard that second signal, so the canvas stayed painted at the old bounds
 * until an unrelated window resize woke it up.
 */

const DISPLAY_MODES = new Set(["inline", "fullscreen", "pip"]);

export function advanceHostLayout(current, nextMode) {
  return {
    mode: DISPLAY_MODES.has(nextMode) ? nextMode : current.mode,
    revision: current.revision + 1
  };
}
