const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { z } = require("zod");

/**
 * The buttons on a SwiftUI screen that the system drew, and where they ended up.
 *
 * A button Apple styles is not a shape anyone designed, and a file that has
 * Apple's component should get that component with this button's words in it —
 * the same bargain the Tab Bar already strikes.
 *
 * Which buttons those are is not written down anywhere in most projects. A
 * toolbar button carries no style modifier at all: it is the placement that
 * makes it glass, so the placement is what is read here. A button that draws its
 * own background is the opposite case — somebody designed that one, and it stays
 * exactly as it was exported.
 */

const buttonFrameSchema = z.object({
  x: z.number().finite().min(-10000).max(10000),
  y: z.number().finite().min(-10000).max(10000),
  width: z.number().finite().positive().max(10000),
  height: z.number().finite().positive().max(10000)
}).strict();

const sourceNativeButtonSchema = z.object({
  syncId: z.string().regex(/^swift\/[A-Za-z0-9_:/.-]{1,480}$/),
  label: z.string().min(1).max(200),
  material: z.enum(["glass", "glassProminent"]),
  controlSize: z.enum(["mini", "small", "regular", "large", "extraLarge"]).optional(),
  isEnabled: z.boolean().optional(),
  destructive: z.boolean().optional(),
  /** What made this button count as the system's. */
  reason: z.enum(["buttonStyle", "toolbar"])
}).strict();

const nativeButtonSchema = sourceNativeButtonSchema.extend({ frame: buttonFrameSchema }).strict();

/** The ranges of every `.toolbar { … }` block in a file. */
function toolbarRanges(source) {
  const ranges = [];
  const text = String(source || "");
  for (const match of text.matchAll(/\.toolbar\s*(?:\([^)]*\)\s*)?\{/g)) {
    let depth = 0;
    for (let index = match.index + match[0].length - 1; index < text.length; index += 1) {
      if (text[index] === "{") depth += 1;
      else if (text[index] === "}") {
        depth -= 1;
        if (depth === 0) { ranges.push([match.index, index]); break; }
      }
    }
  }
  return ranges;
}

/** The button's own words, from its label rather than from its action. */
function labelIn(expression) {
  const direct = expression.match(/^\s*Button\s*\(\s*"((?:[^"\\]|\\.){1,200})"/);
  if (direct) return direct[1];
  const titleKey = expression.match(/^\s*Button\s*\(\s*(?:title\s*:\s*)?LocalizedStringKey\s*\(\s*"((?:[^"\\]|\\.){1,200})"/);
  if (titleKey) return titleKey[1];
  const inLabel = expression.match(/Text\s*\(\s*"((?:[^"\\]|\\.){1,200})"\s*\)/);
  return inLabel ? inLabel[1] : null;
}

function materialIn(expression) {
  if (/\.buttonStyle\s*\(\s*\.glassProminent\b/.test(expression)) return "glassProminent";
  if (/\.buttonStyle\s*\(\s*\.glass\b/.test(expression)) return "glass";
  // On iOS 26 the bordered styles are drawn as glass as well, prominent or not.
  if (/\.buttonStyle\s*\(\s*\.borderedProminent\b/.test(expression)) return "glassProminent";
  if (/\.buttonStyle\s*\(\s*\.bordered\b/.test(expression)) return "glass";
  return null;
}

/** A button that draws its own look is one somebody designed, not the system's. */
function isDesigned(expression) {
  return /\.background\s*\(/.test(expression)
    || /\.buttonStyle\s*\(\s*\.(?:plain|borderless)\b/.test(expression)
    || /\.buttonStyle\s*\(\s*[A-Z]/.test(expression);
}

function controlSizeIn(expression) {
  return expression.match(/\.controlSize\s*\(\s*\.(mini|small|regular|large|extraLarge)\b/)?.[1] ?? null;
}

/**
 * Reads the system-styled buttons a screen declares.
 *
 * `toolbarRangesByFile` says, per source file, where the toolbar blocks are; a
 * button inside one is the system's however plainly it is written.
 */
function collectSwiftNativeButtons(uiTree, toolbarRangesByFile = new Map()) {
  const buttons = [];
  const seen = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "button" && typeof node.syncId === "string" && !seen.has(node.syncId)) {
      const expression = String(node.sourceExpression || "");
      const material = materialIn(expression);
      const ranges = toolbarRangesByFile.get(node.sourceFile) ?? [];
      const offset = node.sourceRange?.startOffset;
      const inToolbar = Number.isInteger(offset) && ranges.some(([start, end]) => offset >= start && offset <= end);
      const label = labelIn(expression);
      if (label && !isDesigned(expression) && (material || inToolbar)) {
        seen.add(node.syncId);
        const controlSize = controlSizeIn(expression);
        buttons.push(sourceNativeButtonSchema.parse({
          syncId: node.syncId,
          label,
          material: material ?? "glass",
          reason: material ? "buttonStyle" : "toolbar",
          ...(controlSize ? { controlSize } : {}),
          ...(/\.disabled\s*\(\s*true\s*\)/.test(expression) ? { isEnabled: false } : {}),
          ...(/role\s*:\s*\.destructive\b/.test(expression) ? { destructive: true } : {})
        }));
      }
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(uiTree);
  return buttons;
}

/** Reads the toolbar blocks of every file a screen's buttons come from. */
async function readToolbarRanges(root, uiTree) {
  const files = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "button" && typeof node.sourceFile === "string") files.add(node.sourceFile);
    for (const child of node.children ?? []) visit(child);
  };
  visit(uiTree);
  const ranges = new Map();
  for (const file of files) {
    const source = await readFile(path.join(root, file), "utf8").catch(() => null);
    if (source) ranges.set(file, toolbarRanges(source));
  }
  return ranges;
}

/**
 * Places each declared button where the run actually drew it.
 *
 * A button the run never reached has no frame, and is dropped rather than
 * guessed at: a component at a made-up position is worse than a button left as
 * the vector it was exported as.
 */
function placeSwiftNativeButtons(buttons, snapshot, pageSourceName, coordinateSpace = null) {
  const captures = new Map((snapshot?.nodes ?? [])
    .filter((node) => !pageSourceName || node.pageSourceName === pageSourceName)
    .map((node) => [node.syncId, node]));
  const origin = coordinateSpace ?? snapshot?.environment?.viewport ?? { x: 0, y: 0, width: 1, height: 1 };
  const scaleX = coordinateSpace?.outputWidth ? coordinateSpace.outputWidth / origin.width : 1;
  const scaleY = coordinateSpace?.outputHeight ? coordinateSpace.outputHeight / origin.height : 1;
  return buttons.flatMap((button) => {
    const capture = captures.get(button.syncId);
    if (!capture?.frame || capture.frame.width <= 0 || capture.frame.height <= 0) return [];
    return [nativeButtonSchema.parse({
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

/** The whole job: read the sources, pick the system's buttons, place them. */
async function resolveSwiftNativeButtons(root, uiTree, snapshot, pageSourceName, coordinateSpace = null) {
  const ranges = await readToolbarRanges(root, uiTree);
  return placeSwiftNativeButtons(collectSwiftNativeButtons(uiTree, ranges), snapshot, pageSourceName, coordinateSpace);
}

module.exports = {
  collectSwiftNativeButtons,
  nativeButtonSchema,
  placeSwiftNativeButtons,
  resolveSwiftNativeButtons,
  sourceNativeButtonSchema,
  toolbarRanges
};
