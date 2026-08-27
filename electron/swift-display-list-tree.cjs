const { z } = require("zod");
const { createScreenshotSampler } = require("./swift-gradient-sample.cjs");

/**
 * Turns a captured SwiftUI display list into the layer tree the Figma plugin
 * already builds from.
 *
 * The existing iOS path exports each screen as a vector PDF and sends the SVG
 * that comes out of it. That works, and it throws away everything except the
 * drawing: a PDF page has no tree, no names, no identity, so a second scan
 * cannot recognise a single layer from the first, and nothing on the canvas can
 * be told apart from anything else that happens to be the same shape. This path
 * keeps all three, because `DisplayList` carries them — every item has the
 * frame the layout engine computed and an identity SwiftUI itself assigned.
 *
 * Nothing here talks to Xcode, a Simulator, or Swift. It is a function from the
 * agent's JSON to a layer tree, which is the whole reason the Swift side emits a
 * faithful copy of the display list rather than finished layers: this half can
 * be tested against a recorded capture in milliseconds, and the half that cannot
 * be tested that way stays small.
 *
 * Two shapes have to be reconciled. A display list is a *drawing* order — a card
 * is a shape item followed by its text as siblings, with the rounding of the
 * corners living in a bezier path rather than in a radius. A layer tree is a
 * *containment* order, and the Figma plugin wants a box with a corner radius and
 * text inside it. So an effect that wraps a background shape and some content is
 * turned back into one element with a fill, a radius and children — see
 * `foldBackgroundShape`. Where that cannot be done honestly the shape is kept as
 * a real vector layer instead of being guessed at.
 */

const colorSchema = z.object({
  r: z.number().finite().min(0).max(1),
  g: z.number().finite().min(0).max(1),
  b: z.number().finite().min(0).max(1),
  a: z.number().finite().min(0).max(1)
}).strict();

const frameSchema = z.object({
  x: z.number().finite().min(-100000).max(100000),
  y: z.number().finite().min(-100000).max(100000),
  width: z.number().finite().min(0).max(100000),
  height: z.number().finite().min(0).max(100000)
}).strict();

const itemSchema = z.lazy(() => z.object({
  frame: frameSchema,
  kind: z.string().min(1).max(60),
  identity: z.string().max(80).optional(),
  seed: z.string().max(80).optional(),
  path: z.string().max(2_000_000).optional(),
  fill: z.object({
    kind: z.enum(["color", "gradient", "unknown"]),
    color: colorSchema.optional(),
    type: z.string().max(300).optional()
  }).strict().optional(),
  text: z.string().max(20000).optional(),
  textStyle: z.object({
    fontName: z.string().max(200).optional(),
    fontSize: z.number().finite().min(0).max(2000).optional(),
    weight: z.number().int().min(1).max(1000).optional(),
    color: colorSchema.optional(),
    align: z.enum(["left", "center", "right", "justify"]).optional()
  }).strict().optional(),
  textSize: z.object({ width: z.number().finite(), height: z.number().finite() }).strict().optional(),
  imageSize: z.object({ width: z.number().finite(), height: z.number().finite() }).strict().optional(),
  /** The image's own pixels, as base64 PNG, when the capture could reach them. */
  png: z.string().max(24_000_000).optional(),
  effect: z.string().max(80).optional(),
  filter: z.string().max(80).optional(),
  /** How see-through an effect makes what is inside it. */
  opacity: z.number().finite().min(0).max(1).optional(),
  /** `.blur(radius:)` laid over everything inside the effect. */
  blur: z.number().finite().min(0).max(400).optional(),
  /** A material's blur, already scaled back to the points it is drawn in. */
  backdropBlur: z.number().finite().min(0).max(400).optional(),
  backdropSaturation: z.number().finite().min(0).max(20).optional(),
  opaque: z.boolean().optional(),
  shadow: z.object({
    radius: z.number().finite().min(0).max(1000).optional(),
    dx: z.number().finite().min(-1000).max(1000).optional(),
    dy: z.number().finite().min(-1000).max(1000).optional(),
    color: colorSchema.optional()
  }).strict().optional(),
  children: z.array(itemSchema).max(20000).optional()
}).strict());

const captureSchema = z.object({
  ok: z.literal(true),
  viewport: z.object({
    width: z.number().finite().positive().max(100000),
    height: z.number().finite().positive().max(100000)
  }).strict(),
  items: z.array(itemSchema).max(20000),
  /** A picture of the screen at the moment the list was read, as base64 PNG. */
  screenshot: z.string().max(32_000_000).optional(),
  description: z.string().max(20_000_000).optional()
}).strict();

const round = (value) => Math.round(value * 100) / 100;

/** The plugin reads CSS colour strings, which is what the web path gives it. */
function cssColor(color) {
  if (!color) return "rgba(0, 0, 0, 0)";
  const channel = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255);
  const alpha = Math.round(Math.max(0, Math.min(1, color.a)) * 1000) / 1000;
  return `rgba(${channel(color.r)}, ${channel(color.g)}, ${channel(color.b)}, ${alpha})`;
}

/**
 * SwiftUI writes a path as a stream of points and one-letter verbs — `12 0 m`,
 * `3 4 5 6 7 8 c`, `h` — with the operands *before* the operator. SVG puts the
 * operator first and uses different letters. The two describe the same curves,
 * so this is a transcription and not a conversion; anything unrecognised ends
 * the transcription rather than being dropped silently, because half a path
 * drawn confidently is worse on a canvas than no path at all.
 */
function svgPathData(path) {
  const tokens = String(path).trim().split(/\s+/);
  const verbs = { m: "M", l: "L", c: "C", q: "Q", h: "Z" };
  const out = [];
  let operands = [];
  for (const token of tokens) {
    const verb = verbs[token];
    if (verb === undefined) {
      const value = Number.parseFloat(token);
      if (!Number.isFinite(value)) return null;
      operands.push(round(value));
      continue;
    }
    if (verb === "Z") {
      out.push("Z");
      operands = [];
      continue;
    }
    const expected = verb === "C" ? 6 : verb === "Q" ? 4 : 2;
    if (operands.length < expected) return null;
    out.push(`${verb}${operands.slice(-expected).join(" ")}`);
    operands = [];
  }
  return out.length > 0 ? out.join(" ") : null;
}

/**
 * The corner radius of a rounded rectangle, read back off its path.
 *
 * A rounded rect reaches the display list as beziers; the radius that produced
 * them is gone. It is recovered rather than dropped because it is the single
 * most visible property of a real interface — every card, button and pill has
 * one — and a Figma layer that carries a radius stays editable, where a
 * hand-drawn vector of the same shape does not.
 *
 * The constant below is measured, not derived. Rendering known radii and
 * reading back where each corner's curve meets the straight edge gives:
 *
 *     style        curves/corner   (corner extent) / radius
 *     .circular          1               1.0000
 *     .continuous        3               1.5287
 *
 * held exactly across radii 4, 8 and 16. `RoundedRectangle(cornerRadius:)`
 * draws continuous corners by default, so the three-curve case is the common
 * one and assuming a circular corner would have reported every card as two
 * thirds as round as it is drawn.
 *
 * Above the radius a box can fit, SwiftUI clamps the corner to half the shorter
 * side and the ratio stops holding — the shape is as round as that side allows,
 * so that is what is reported.
 *
 * Returns null for anything that is not a four-cornered rounded rectangle,
 * which is the honest answer for a shape that has to stay a vector.
 */
function cornerRadiusOfRoundedRect(path, frame) {
  const tokens = String(path).trim().split(/\s+/);
  const curves = tokens.filter((token) => token === "c").length;
  const lines = tokens.filter((token) => token === "l").length;
  if (curves === 0 || curves % 4 !== 0 || lines !== 4) return null;
  if (tokens.some((token) => token === "q")) return null;

  const points = [];
  let operands = [];
  for (const token of tokens) {
    if (token.length === 1 && "mlchq".includes(token)) { operands = []; continue; }
    const value = Number.parseFloat(token);
    if (!Number.isFinite(value)) return null;
    operands.push(value);
    if (operands.length % 2 === 0) points.push([operands.at(-2), operands.at(-1)]);
  }
  if (points.length === 0) return null;

  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  // A path that does not trace its own frame is not this frame's background.
  if (Math.abs((Math.max(...xs) - minX) - frame.width) > 0.6) return null;
  if (Math.abs((Math.max(...ys) - minY) - frame.height) > 0.6) return null;

  const shortSide = Math.min(frame.width, frame.height);
  const limit = shortSide / 2;
  // Where the top-left corner's curve rejoins the left edge. Control points sit
  // nearer the corner than the tangent point does, so the farthest one that is
  // still within the corner's half of the side is the tangent point.
  const onLeftEdge = points
    .filter((point) => Math.abs(point[0] - minX) < 0.01)
    .map((point) => point[1] - minY)
    .filter((offset) => offset <= limit + 0.001);
  if (onLeftEdge.length === 0) return null;
  const extent = Math.max(...onLeftEdge);
  if (extent <= 0.01) return null;

  const perCorner = curves / 4;
  const ratio = perCorner === 1 ? 1 : 1.5287;
  // Saturated: the corner is as round as this side allows, and the ratio no
  // longer describes it.
  const radius = extent >= limit - 0.02 ? limit : extent / ratio;
  return round(Math.min(radius, limit));
}

function emptyStyle() {
  return {
    backgroundColor: "rgba(0, 0, 0, 0)",
    borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)",
    borderBottomColor: "rgba(0, 0, 0, 0)", borderLeftColor: "rgba(0, 0, 0, 0)",
    borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0,
    borderRadius: 0, opacity: 1, boxShadow: null, clipsContent: false,
    backdropBlur: 0, backdropSaturation: 1, blur: 0
  };
}

/** The plugin reads the browser's normalised form: colour first, then offsets. */
function cssBoxShadow(shadow) {
  if (!shadow) return null;
  const dx = round(shadow.dx ?? 0);
  const dy = round(shadow.dy ?? 0);
  // SwiftUI's `radius` is a blur *radius*; CSS takes a blur length that covers
  // both sides of the edge. Passing the radius through made every shadow half
  // as soft as the app draws it.
  const blur = round((shadow.radius ?? 0) * 2);
  return `${cssColor(shadow.color)} ${dx}px ${dy}px ${blur}px 0px`;
}


/**
 * The `.SFNS-Bold` a capture reports is the internal name of the system face,
 * and nothing outside the app can resolve it — Figma has no font by that name.
 * It is translated to the family everything else calls it by, with the weight
 * kept separately, so a heading arrives bold in the right typeface rather than
 * in whatever gets substituted for a name no font server knows.
 */
function fontFamilies(fontName) {
  if (!fontName) return ["system-ui"];
  if (/^\.?SFNS|^\.SF|^\.AppleSystemUIFont/i.test(fontName)) return ["SF Pro Text", "SF Pro", "system-ui"];
  return [fontName.replace(/^\./, "").replace(/-(?:Regular|Bold|Semibold|Medium|Light|Heavy|Black|Thin)$/i, ""), "system-ui"];
}

function textNodeStyle(style = {}) {
  const fontSize = round(style.fontSize ?? 14);
  return {
    color: cssColor(style.color ?? { r: 0, g: 0, b: 0, a: 1 }),
    fontSize,
    fontWeight: style.weight ?? 400,
    // SwiftUI resolves line height inside the text run and the display list
    // does not carry it. 1.2 is what the web path uses for `normal`, and using
    // the same number keeps a screen captured both ways comparable.
    lineHeight: round(fontSize * 1.2),
    letterSpacing: 0,
    textAlign: style.align ?? "left",
    fontFamilies: fontFamilies(style.fontName),
    fontStyle: "normal",
    fontStretch: "100%",
    textCase: "none",
    whiteSpace: "normal",
    wordBreak: "normal",
    overflowWrap: "normal",
    direction: "ltr",
    writingMode: "horizontal-tb"
  };
}

/** Whether a shape or colour item covers its parent exactly — i.e. is its background. */
function coversFrame(item, frame) {
  const f = item.frame;
  return Math.abs(f.x) < 0.51 && Math.abs(f.y) < 0.51
    && Math.abs(f.width - frame.width) < 0.51 && Math.abs(f.height - frame.height) < 0.51;
}

/**
 * Folds a background shape back into the element it is the background of.
 *
 * SwiftUI draws `.background(RoundedRectangle(...))` as two siblings: the shape
 * first, then the content. Sent on as-is that becomes a vector layer with some
 * text lying on top of it, which is not what the interface is and is not
 * editable as one — moving the card in Figma would leave its background behind.
 * When the first child of a group covers the group exactly and is a plain
 * fill, it is the group's background, and folding it in gives back one box with
 * a fill, a radius and children.
 *
 * Only a solid fill folds. A gradient has no single colour to fold into a
 * `backgroundColor`, so it stays a vector layer and keeps its real appearance.
 */
function foldBackgroundShape(children, frame) {
  const [first, ...rest] = children;
  if (!first || !coversFrame(first, frame)) return null;
  if (first.kind === "color" && first.fill?.color) {
    return { fill: first.fill.color, radius: 0, remaining: rest };
  }
  if (first.kind === "shape" && first.fill?.kind === "color" && first.fill.color && first.path) {
    const radius = cornerRadiusOfRoundedRect(first.path, first.frame);
    // A path that is not a rectangle is a real shape and has to stay one.
    if (radius === null && !isPlainRect(first.path, first.frame)) return null;
    return { fill: first.fill.color, radius: radius ?? 0, remaining: rest };
  }
  return null;
}

/** A path that traces the frame with straight edges and nothing else. */
function isPlainRect(path, frame) {
  const tokens = String(path).trim().split(/\s+/);
  if (tokens.some((token) => token === "c" || token === "q")) return false;
  const xs = [];
  const ys = [];
  const operands = [];
  for (const token of tokens) {
    if (token === "m" || token === "l" || token === "h") continue;
    const value = Number.parseFloat(token);
    if (!Number.isFinite(value)) return false;
    operands.push(value);
    if (operands.length % 2 === 0) { xs.push(operands.at(-2)); ys.push(operands.at(-1)); }
  }
  if (xs.length < 3) return false;
  return Math.abs((Math.max(...xs) - Math.min(...xs)) - frame.width) < 0.51
    && Math.abs((Math.max(...ys) - Math.min(...ys)) - frame.height) < 0.51;
}

/** A sampled colour as CSS. The picture is composited, so it has no alpha. */
function sampledColour(colour) {
  return `rgb(${colour.r}, ${colour.g}, ${colour.b})`;
}

/**
 * What to paint a path with: the colour the display list carries, or — for a
 * gradient, whose stops it does not carry — what was read off the screenshot.
 * A fill that is neither stays `none`, which is the honest answer for a paint
 * nobody could read.
 */
function svgFill(item, sampled, id) {
  if (item.fill?.kind === "color") return { defs: "", fill: cssColor(item.fill.color) };
  if (sampled?.kind === "flat") return { defs: "", fill: sampledColour(sampled.flat) };
  if (sampled?.kind === "gradient") {
    const name = `crank-fill-${id}`;
    const ends = sampled.vertical ? 'x1="0" y1="0" x2="0" y2="1"' : 'x1="0" y1="0" x2="1" y2="0"';
    const stops = sampled.stops
      .map((stop) => `<stop offset="${round(stop.offset)}" stop-color="${sampledColour(stop.colour)}"/>`)
      .join("");
    return {
      defs: `<defs><linearGradient id="${name}" ${ends}>${stops}</linearGradient></defs>`,
      fill: `url(#${name})`
    };
  }
  return { defs: "", fill: "none" };
}

function svgMarkup(item, sampled = null, id = "0") {
  const data = svgPathData(item.path);
  if (!data) return null;
  const { defs, fill } = svgFill(item, sampled, id);
  const width = round(Math.max(item.frame.width, 0.01));
  const height = round(Math.max(item.frame.height, 0.01));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" `
    + `viewBox="0 0 ${width} ${height}">${defs}<path d="${data}" fill="${fill}" fill-rule="nonzero"/></svg>`;
}

/**
 * Whether an item is nothing but colour: a fill, a material's own blurred
 * backdrop or its tint, or a wrapper around those and nothing else.
 */
function isColourOnly(item) {
  if (!item || typeof item !== "object") return false;
  if (item.kind === "color" || item.kind === "chameleonColor" || item.kind === "backdrop") return true;
  const children = item.children ?? [];
  return children.length > 0 && children.every(isColourOnly);
}

/** Whether a child fills its parent, rather than sitting somewhere in it. */
function fillsFrame(item, frame) {
  return item.frame.x <= 0.51 && item.frame.y <= 0.51
    && item.frame.width >= frame.width - 0.51
    && item.frame.height >= frame.height - 0.51;
}

/**
 * The blurred backdrop this group *is*, not one somewhere inside it.
 *
 * SwiftUI wraps a material in an effect or two, so the backdrop is never a
 * direct child — but it always fills what wraps it. Searching without that
 * rule found the material three levels down inside a screen and folded the
 * whole screen into it, taking every other coloured layer with it.
 */
function findBackdrop(items, frame) {
  for (const item of items ?? []) {
    if (!fillsFrame(item, frame)) continue;
    if (item.kind === "backdrop") return item;
    const inner = { ...item.frame, x: 0, y: 0 };
    const found = findBackdrop(item.children, inner);
    if (found) return found;
  }
  return null;
}

/**
 * Turns SwiftUI's recipe for a material back into one frosted box.
 *
 * `.ultraThinMaterial` is not one thing in the display list. It is the screen
 * behind it drawn at quarter scale, saturated and blurred; then a near-white
 * laid over that in a blend mode; then a grey tint at five per cent. Drawn as
 * three stacked layers in CSS the middle one is opaque, and the frosted card
 * came out a solid white slab.
 *
 * What all three describe together is a translucent tinted box with the screen
 * blurred behind it, and CSS has exactly that. So the group is folded into one
 * box carrying the backdrop's own tint and blur, and the layers that only exist
 * to compose it are dropped. Anything in the group that is not part of that
 * recipe is kept, because a material is a background and things sit on it.
 */
function foldMaterial(children, frame) {
  const own = (child) => isColourOnly(child) && fillsFrame(child, frame);
  const backdrop = findBackdrop(children.filter(own), frame);
  if (!backdrop) return null;
  return { backdrop, remaining: children.filter((child) => !own(child)) };
}

/**
 * Nests what a background shape is the background *of*.
 *
 * A display list is a drawing order, not a containment order, and how flat it
 * is depends on things that have nothing to do with structure. A card with a
 * shadow arrives wrapped in an effect, because the shadow needed one — so its
 * background and its text are already grouped. The same card without a shadow
 * arrives as a shape followed by two loose strings at the top level, with
 * nothing to say they belong together. Sent on like that, moving the card in
 * Figma leaves its text behind.
 *
 * So containment is inferred where the capture does not carry it: a filled
 * shape, then the siblings drawn after it that fall entirely inside it, are one
 * thing. This is a resemblance and not a deterministic anchor, which is why the
 * conditions are narrow — the run stops at the first sibling that is not inside,
 * a shape has to be a plain fill to be a background at all, and a shape covering
 * essentially the whole parent is treated as a backdrop rather than swallowing
 * the entire screen into one box.
 */
function groupBackgroundSiblings(items, parentFrame) {
  const insideOf = (frame, container) =>
    frame.x >= container.x - 0.51
    && frame.y >= container.y - 0.51
    && frame.x + frame.width <= container.x + container.width + 0.51
    && frame.y + frame.height <= container.y + container.height + 0.51;

  const isBackground = (item) => {
    if (item.frame.width < 1 || item.frame.height < 1) return false;
    if (item.kind === "color") return Boolean(item.fill?.color);
    if (item.kind !== "shape" || item.fill?.kind !== "color" || !item.path) return false;
    return cornerRadiusOfRoundedRect(item.path, item.frame) !== null || isPlainRect(item.path, item.frame);
  };

  const parentArea = Math.max(parentFrame.width * parentFrame.height, 1);
  const out = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    const recursed = item.children
      ? { ...item, children: groupBackgroundSiblings(item.children, item.frame) }
      : item;

    if (!isBackground(item) || (item.frame.width * item.frame.height) / parentArea > 0.98) {
      out.push(recursed);
      continue;
    }

    const absorbed = [];
    let next = index + 1;
    while (next < items.length && insideOf(items[next].frame, item.frame)) {
      absorbed.push(items[next]);
      next += 1;
    }
    if (absorbed.length === 0) {
      out.push(recursed);
      continue;
    }

    // The children of a group are positioned against it, so what was measured
    // against the parent has to be measured against the background instead.
    const rebase = (child) => ({
      ...child,
      frame: { ...child.frame, x: round(child.frame.x - item.frame.x), y: round(child.frame.y - item.frame.y) }
    });
    out.push({
      frame: item.frame,
      kind: "effect",
      effect: "inferred-background",
      identity: item.identity,
      children: [
        { ...item, frame: { ...item.frame, x: 0, y: 0 } },
        ...absorbed.map((child) => {
          const based = rebase(child);
          return based.children
            ? { ...based, children: groupBackgroundSiblings(based.children, based.frame) }
            : based;
        })
      ]
    });
    index = next - 1;
  }
  return out;
}

/**
 * Builds the layer tree for one captured screen.
 *
 * `warnings` names everything that could not be carried across rather than
 * letting it vanish: an image whose pixels the capture does not include, a
 * gradient with no stops, a path that could not be transcribed. A screen that
 * arrives with three things missing and says so is worth more than one that
 * arrives looking complete and is not.
 */
function buildLayerTree(rawCapture, { pageId = "swift-page" } = {}) {
  const capture = captureSchema.parse(rawCapture);
  const warnings = [];
  let counter = 0;
  // The colours a gradient does not carry are read off the picture the capture
  // already took of the same frame. Built once: decoding a retina screenshot
  // per shape would cost more than the whole conversion.
  const sampler = createScreenshotSampler(capture.screenshot, capture.viewport);
  const viewportArea = Math.max(1, Number(capture.viewport.width) * Number(capture.viewport.height));

  const identify = (item, parentId) => {
    counter += 1;
    // SwiftUI's own identity where it gave one — it is stable while the item is
    // on screen, which is what makes a second scan land on the same layer. The
    // counter is only for the items it did not number.
    return item.identity ? `${pageId}/dl:${item.identity}` : `${parentId}/n:${counter}`;
  };

  function convert(item, parentId, offset = { x: 0, y: 0 }) {
    const id = identify(item, parentId);
    const common = {
      x: round(item.frame.x), y: round(item.frame.y),
      width: round(item.frame.width), height: round(item.frame.height),
      id,
      selector: item.identity ? `displaylist:${item.identity}` : null,
      source: null
    };

    if (item.kind === "text") {
      const style = textNodeStyle(item.textStyle);
      return {
        kind: "text", ...common,
        name: (item.text || "Text").slice(0, 100),
        text: (item.text ?? "").slice(0, 4000),
        sourceText: (item.text ?? "").slice(0, 4000),
        wrapMode: "nowrap",
        lineCount: 1,
        layoutWidth: round(item.textSize?.width ?? item.frame.width),
        layoutX: 0,
        style
      };
    }

    if (item.kind === "image") {
      if (item.png) {
        return { kind: "image", ...common, name: "Image", dataUrl: `data:image/png;base64,${item.png}` };
      }
      // Some images are held as something with no pixels to read — a symbol
      // drawn by a layer, a renderer's own surface. That is a real gap and is
      // named as one rather than drawn as an empty box that looks intentional.
      warnings.push(`An image at ${common.x},${common.y} was captured without its pixels.`);
      return {
        kind: "element", ...common, name: "Image (pixels not captured)",
        style: { ...emptyStyle(), clipsContent: true }, children: []
      };
    }

    if (item.opaque) {
      const absolute = {
        x: round(offset.x + item.frame.x), y: round(offset.y + item.frame.y),
        width: item.frame.width, height: item.frame.height
      };
      if (coveredByHostingView(absolute)) {
        // The container itself, kept as an empty box so the layers inside it
        // keep the position they were captured at.
        return { kind: "element", ...common, name: "Container", style: emptyStyle(), children: [] };
      }
      warnings.push(`A platform view at ${common.x},${common.y} draws itself and was not captured.`);
      return {
        kind: "element", ...common, name: "Platform view (not captured)",
        style: emptyStyle(), children: []
      };
    }

    if (item.kind === "color") {
      return {
        kind: "element", ...common, name: "Fill",
        style: { ...emptyStyle(), backgroundColor: cssColor(item.fill?.color) },
        children: []
      };
    }

    if (item.kind === "shape") {
      // A paint whose colour could not be read: a gradient, whose stops the
      // display list does not carry, or one it will not describe at all —
      // `LinearGradient` arrives as an opaque `_Paint` and is not even named a
      // gradient, which is why this turns on the fill being unreadable rather
      // than on it being called one.
      //
      // Only where the shape is big enough to be a background. A small shape
      // with an unreadable paint may be a clear overlay, and filling that with
      // what is behind it would flatten whatever it was laid over; a shape
      // covering a sixth of the screen is the background of something.
      const unreadable = item.fill?.kind === "gradient" || item.fill?.kind === "unknown";
      const covers = item.frame.width * item.frame.height >= 0.15 * viewportArea;
      const sampled = unreadable && covers
        ? sampler?.fillFor({
          x: offset.x + item.frame.x, y: offset.y + item.frame.y,
          width: item.frame.width, height: item.frame.height
        }) ?? null
        : null;
      if (unreadable && covers) {
        warnings.push(sampled
          ? `A fill at ${common.x},${common.y} was read off the picture of the screen: the display list does not describe it.`
          : `A fill at ${common.x},${common.y} could not be drawn — the display list does not describe it, and there was no picture of the screen to read it from.`);
      }
      const svg = svgMarkup(item, sampled, id.replace(/[^A-Za-z0-9_-]/g, "-"));
      if (svg) return { kind: "svg", ...common, name: "Shape", svg };
      warnings.push(`A path at ${common.x},${common.y} could not be transcribed and was dropped.`);
      return null;
    }

    const children = item.children ?? [];
    const material = foldMaterial(children, { ...item.frame, x: 0, y: 0 });
    const folded = material ? null : foldBackgroundShape(children, item.frame);
    const inner = { x: offset.x + item.frame.x, y: offset.y + item.frame.y };
    const converted = (material?.remaining ?? folded?.remaining ?? children)
      .map((child) => convert(child, id, inner))
      .filter(Boolean);

    const style = { ...emptyStyle() };
    if (folded) {
      style.backgroundColor = cssColor(folded.fill);
      style.borderRadius = folded.radius;
    }
    if (material) {
      style.backgroundColor = cssColor(material.backdrop.fill?.color);
      if (material.backdrop.backdropBlur > 0) style.backdropBlur = round(material.backdrop.backdropBlur);
      if (material.backdrop.backdropSaturation > 0) style.backdropSaturation = material.backdrop.backdropSaturation;
    }
    if (item.shadow) style.boxShadow = cssBoxShadow(item.shadow);
    if (typeof item.opacity === "number") style.opacity = round(item.opacity);
    if (item.blur > 0) style.blur = round(item.blur);
    if (item.effect === "clip") style.clipsContent = true;

    return {
      kind: "element", ...common,
      name: material ? "Material" : folded ? "Box" : "Group",
      style,
      children: converted
    };
  }

  const grouped = groupBackgroundSiblings(capture.items, {
    x: 0, y: 0, width: capture.viewport.width, height: capture.viewport.height
  });
  // Where a hosting view sits in the window. A UIKit container that SwiftUI
  // hosts content inside reaches the display list as an opaque placeholder,
  // and its content arrives separately as one of these — so a placeholder with
  // a hosting view inside it is not a gap, it is the same thing twice, and
  // reporting it as missing sent back eight warnings about content that had in
  // fact been captured.
  const hostingRoots = grouped
    .filter((item) => item.effect === "hosting-view")
    .map((item) => item.frame);
  const coveredByHostingView = (frame) => hostingRoots.some((root) =>
    root.x >= frame.x - 0.51
    && root.y >= frame.y - 0.51
    && root.x + root.width <= frame.x + frame.width + 0.51
    && root.y + root.height <= frame.y + frame.height + 0.51
    && root.width * root.height > 1
  );
  const roots = grouped.map((item) => convert(item, pageId, { x: 0, y: 0 })).filter(Boolean);
  const tree = {
    kind: "element",
    x: 0, y: 0,
    width: round(capture.viewport.width), height: round(capture.viewport.height),
    id: `${pageId}/root`,
    selector: null,
    source: null,
    name: "Screen",
    style: emptyStyle(),
    children: roots
  };

  return {
    width: round(capture.viewport.width),
    height: round(capture.viewport.height),
    tree,
    warnings
  };
}

module.exports = {
  buildLayerTree,
  groupBackgroundSiblings,
  fontFamilies,
  foldBackgroundShape,
  foldMaterial,
  isPlainRect,
  svgMarkup,
  textNodeStyle,
  captureSchema,
  cornerRadiusOfRoundedRect,
  cssBoxShadow,
  cssColor,
  emptyStyle,
  svgPathData
};
