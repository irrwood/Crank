const { z } = require("zod");

/**
 * The native buttons on a SwiftUI screen, and where they ended up.
 *
 * A button written with `.buttonStyle(.glass)` is not a shape someone drew: it
 * is Apple's, and a design file that has Apple's own component should get that
 * component with this button's words in it — the same bargain the Tab Bar
 * already strikes. What the source says (the label, which glass, how big) is
 * joined here to what the run measured (where it is), because neither half is
 * enough on its own.
 */

const glassMaterials = new Set(["glass", "glassProminent"]);

const buttonFrameSchema = z.object({
  x: z.number().finite().min(-10000).max(10000),
  y: z.number().finite().min(-10000).max(10000),
  width: z.number().finite().positive().max(10000),
  height: z.number().finite().positive().max(10000)
}).strict();

const sourceGlassButtonSchema = z.object({
  syncId: z.string().regex(/^swift\/[A-Za-z0-9_:/.-]{1,480}$/),
  label: z.string().min(1).max(200),
  material: z.enum(["glass", "glassProminent"]),
  controlSize: z.enum(["mini", "small", "regular", "large", "extraLarge"]).optional(),
  isEnabled: z.boolean().optional(),
  destructive: z.boolean().optional()
}).strict();

const glassButtonSchema = sourceGlassButtonSchema.extend({ frame: buttonFrameSchema }).strict();

/** The button's own words: its label, or the first line of text inside it. */
function labelOf(node) {
  if (typeof node?.text === "string" && node.text.trim()) return node.text.trim().slice(0, 200);
  for (const child of node?.children ?? []) {
    const label = labelOf(child);
    if (label) return label;
  }
  return null;
}

/**
 * Reads the glass buttons a screen declares.
 *
 * A button with no words in it is left alone: the component this fills is the
 * one with a text label, and an icon-only button put through it would arrive
 * captioned with something it never said.
 */
function collectSwiftGlassButtons(uiTree) {
  const buttons = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "button" && glassMaterials.has(node.material) && typeof node.syncId === "string") {
      const label = labelOf(node);
      if (label && !seen.has(node.syncId)) {
        seen.add(node.syncId);
        buttons.push(sourceGlassButtonSchema.parse({
          syncId: node.syncId,
          label,
          material: node.material,
          ...(node.controlSize ? { controlSize: node.controlSize } : {}),
          ...(node.isEnabled === undefined ? {} : { isEnabled: node.isEnabled }),
          ...(node.role === "destructive" ? { destructive: true } : {})
        }));
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(uiTree);
  return buttons;
}

/**
 * Places each declared button where the run actually drew it.
 *
 * A button the run never reached has no frame, and is dropped rather than
 * guessed at: a component placed at a made-up position is worse than a button
 * left as the vector it was exported as.
 */
function resolveCapturedSwiftGlassButtons(uiTree, snapshot, pageSourceName, coordinateSpace = null) {
  const captures = new Map((snapshot?.nodes ?? [])
    .filter((node) => !pageSourceName || node.pageSourceName === pageSourceName)
    .map((node) => [node.syncId, node]));
  const origin = coordinateSpace ?? snapshot?.environment?.viewport ?? { x: 0, y: 0, width: 1, height: 1 };
  const scaleX = coordinateSpace?.outputWidth ? coordinateSpace.outputWidth / origin.width : 1;
  const scaleY = coordinateSpace?.outputHeight ? coordinateSpace.outputHeight / origin.height : 1;
  return collectSwiftGlassButtons(uiTree).flatMap((button) => {
    const capture = captures.get(button.syncId);
    if (!capture?.frame || capture.frame.width <= 0 || capture.frame.height <= 0) return [];
    return [glassButtonSchema.parse({
      ...button,
      frame: {
        x: (capture.frame.x - origin.x) * scaleX,
        y: (capture.frame.y - origin.y) * scaleY,
        width: capture.frame.width * scaleX,
        height: capture.frame.height * scaleY
      }
    })];
  });
}

module.exports = {
  collectSwiftGlassButtons,
  glassButtonSchema,
  resolveCapturedSwiftGlassButtons,
  sourceGlassButtonSchema
};
