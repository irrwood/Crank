const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildLayerTree,
  cornerRadiusOfRoundedRect,
  cssBoxShadow,
  cssColor,
  fontFamilies,
  groupBackgroundSiblings,
  isPlainRect,
  svgPathData
} = require("./swift-display-list-tree.cjs");

/**
 * The paths below are recordings, not fabrications: each was rendered by
 * SwiftUI at a known corner radius and read back out of the live display list.
 * A hand-written approximation of a bezier corner would pass a test of this
 * code while telling us nothing about whether it reads what SwiftUI draws.
 */
const CARD_PATH = "350 34.5 m 350 50.656 l 350 55.9381 350 58.5791 349.101 61.4221 c 347.971 64.5261 345.526 66.9713 342.422 68.1011 c 339.579 69 336.938 69 331.656 69 c 18.344 69 l 13.0619 69 10.4209 69 7.57793 68.1011 c 4.47389 66.9713 2.02872 64.5261 0.898937 61.4221 c 0 58.5791 0 55.9381 0 50.656 c 0 18.344 l 0 13.0619 0 10.4209 0.898937 7.57793 c 2.02872 4.47389 4.47389 2.02872 7.57793 0.898937 c 10.4209 0 13.0619 0 18.344 0 c 331.656 0 l 336.938 0 339.579 0 342.422 0.898937 c 345.526 2.02872 347.971 4.47389 349.101 7.57793 c 350 10.4209 350 13.0619 350 18.344 c h";
const CARD_FRAME = {"height": 69, "width": 350, "x": 0, "y": 0};
const CONTINUOUS_4 = "200 30 m 200 53.8853 l 200 55.646 200 56.5264 199.7 57.474 c 199.324 58.5087 198.509 59.3238 197.474 59.7004 c 196.526 60 195.646 60 193.885 60 c 6.11466 60 l 4.35396 60 3.47363 60 2.52598 59.7004 c 1.4913 59.3238 0.67624 58.5087 0.299646 57.474 c 0 56.5264 0 55.646 0 53.8853 c 0 6.11466 l 0 4.35396 0 3.47363 0.299646 2.52598 c 0.67624 1.4913 1.4913 0.67624 2.52598 0.299646 c 3.47363 0 4.35396 0 6.11466 0 c 193.885 0 l 195.646 0 196.526 0 197.474 0.299646 c 198.509 0.67624 199.324 1.4913 199.7 2.52598 c 200 3.47363 200 4.35396 200 6.11466 c h";
const CONTINUOUS_4_FRAME = {"height": 60, "width": 200, "x": 10, "y": 10};
const CIRCULAR_24 = "200 30 m 200 36 l 200 49.2548 189.255 60 176 60 c 24 60 l 10.7452 60 8.11625e-16 49.2548 0 36 c 0 24 l 1.62325e-15 10.7452 10.7452 9.03489e-15 24 1.06581e-14 c 176 0 l 189.255 8.11625e-16 200 10.7452 200 24 c h";
const CIRCULAR_24_FRAME = {"height": 60, "width": 200, "x": 10, "y": 274};
const CAPSULE = "200 30 m 200 30 l 200 31.2 200 35.4 197.753 41.0552 c 194.928 48.8153 188.815 54.9282 181.055 57.7527 c 173.948 60 167.345 60 154.14 60 c 45.8599 60 l 32.6547 60 26.0522 60 18.9448 57.7527 c 11.1847 54.9282 5.0718 48.8153 2.24734 41.0552 c 0 35.4 0 31.2 0 30 c 0 30 l 0 28.8 0 24.6 2.24734 18.9448 c 5.0718 11.1847 11.1847 5.0718 18.9448 2.24734 c 26.0522 0 32.6547 0 45.8599 0 c 154.14 0 l 167.345 0 173.948 0 181.055 2.24734 c 188.815 5.0718 194.928 11.1847 197.753 18.9448 c 200 24.6 200 28.8 200 30 c h";
const CAPSULE_FRAME = {"height": 60, "width": 200, "x": 10, "y": 340};

test("a continuous corner is read at the radius it was drawn with", () => {
  assert.equal(cornerRadiusOfRoundedRect(CARD_PATH, CARD_FRAME), 12);
  assert.equal(cornerRadiusOfRoundedRect(CONTINUOUS_4, CONTINUOUS_4_FRAME), 4);
});

test("a circular corner is read at the radius it was drawn with", () => {
  assert.equal(cornerRadiusOfRoundedRect(CIRCULAR_24, CIRCULAR_24_FRAME), 24);
});

test("a capsule is as round as its shorter side allows", () => {
  assert.equal(cornerRadiusOfRoundedRect(CAPSULE, CAPSULE_FRAME), CAPSULE_FRAME.height / 2);
});

test("a path that is not a rounded rectangle has no radius to report", () => {
  assert.equal(cornerRadiusOfRoundedRect("0 0 m 10 0 l 5 9 l h", { width: 10, height: 9 }), null);
  assert.equal(cornerRadiusOfRoundedRect("", { width: 10, height: 10 }), null);
});

test("a rectangle traced by straight edges is recognised as one", () => {
  assert.equal(isPlainRect("0 0 m 20 0 l 20 10 l 0 10 l h", { width: 20, height: 10 }), true);
  assert.equal(isPlainRect(CARD_PATH, CARD_FRAME), false);
});

test("SwiftUI's operand-first path becomes SVG's operator-first one", () => {
  assert.equal(svgPathData("0 0 m 10 0 l h"), "M0 0 L10 0 Z");
  assert.equal(svgPathData("0 0 m 1 2 3 4 5 6 c h"), "M0 0 C1 2 3 4 5 6 Z");
});

test("a path with a verb we cannot transcribe is refused rather than half drawn", () => {
  assert.equal(svgPathData("0 0 m 10 0 x"), null);
  assert.equal(svgPathData("0 0 m 1 2 c"), null);
});

test("linear light is converted to sRGB, not passed through", () => {
  // 0.2159 linear is mid grey; passing it through would give a colour far too
  // dark, which is what made a captured card read as almost black.
  assert.equal(cssColor({ r: 0.2159, g: 0.2159, b: 0.2159, a: 1 }), "rgba(55, 55, 55, 1)");
  assert.equal(cssColor(null), "rgba(0, 0, 0, 0)");
});

test("a shadow radius becomes a CSS blur length, which covers both sides", () => {
  assert.equal(
    cssBoxShadow({ radius: 4, dx: 0, dy: 2, color: { r: 0, g: 0, b: 0, a: 0.33 } }),
    "rgba(0, 0, 0, 0.33) 0px 2px 8px 0px"
  );
});

test("the system font's internal name is translated to one a font server knows", () => {
  assert.deepEqual(fontFamilies(".SFNS-Bold"), ["SF Pro Text", "SF Pro", "system-ui"]);
  assert.deepEqual(fontFamilies("Menlo-Regular"), ["Menlo", "system-ui"]);
  assert.deepEqual(fontFamilies(undefined), ["system-ui"]);
});

const capture = (items) => ({ ok: true, viewport: { width: 200, height: 100 }, items });

test("a background shape and the content over it become one box with children", () => {
  // The shape is given the frame it was actually recorded at: a path only
  // belongs to a box whose edges it traces, and the fold has to refuse one that
  // does not.
  const frame = { ...CIRCULAR_24_FRAME, x: 0, y: 0 };
  const { tree } = buildLayerTree(capture([{
    frame: { x: 10, y: 10, width: frame.width, height: frame.height },
    kind: "effect",
    identity: "7",
    children: [
      {
        frame,
        kind: "shape",
        path: CIRCULAR_24,
        fill: { kind: "color", color: { r: 1, g: 1, b: 1, a: 1 } }
      },
      {
        frame: { x: 8, y: 8, width: 40, height: 16 },
        kind: "text",
        text: "Saved",
        textStyle: { fontSize: 13, weight: 700 }
      }
    ]
  }]));
  const box = tree.children[0];
  assert.equal(box.kind, "element");
  assert.equal(box.name, "Box");
  assert.equal(box.style.backgroundColor, "rgba(255, 255, 255, 1)");
  assert.equal(box.children.length, 1);
  assert.equal(box.children[0].kind, "text");
  assert.equal(box.children[0].text, "Saved");
});

/**
 * A `.ultraThinMaterial` as SwiftUI actually draws one, read out of a live
 * display list: the screen behind it blurred and tinted, a near-white laid over
 * that in a blend mode, and a grey tint at five per cent.
 */
const box = (extra) => ({ frame: { x: 0, y: 0, width: 119.5, height: 56 }, ...extra });
const MATERIAL = box({
  kind: "effect",
  effect: "identity",
  children: [
    box({
      kind: "backdrop",
      backdropBlur: 15,
      backdropSaturation: 1.8,
      fill: { kind: "color", color: { r: 0.9646, g: 0.9648, b: 0.9646, a: 0.36 } }
    }),
    box({
      kind: "effect",
      effect: "blendMode",
      children: [box({ kind: "color", fill: { kind: "color", color: { r: 0.975, g: 0.975, b: 0.975, a: 1 } } })]
    }),
    box({
      kind: "effect",
      effect: "opacity",
      opacity: 0.05,
      children: [box({ kind: "chameleonColor", fill: { kind: "color", color: { r: 0.75, g: 0.75, b: 0.75, a: 1 } } })]
    })
  ]
});

test("a material becomes one frosted box, not three stacked fills", () => {
  const { tree } = buildLayerTree(capture([MATERIAL]));
  const material = tree.children[0];
  assert.equal(material.name, "Material");
  assert.equal(material.style.backgroundColor, "rgba(246, 246, 246, 0.36)");
  assert.equal(material.style.backdropBlur, 15);
  assert.equal(material.style.backdropSaturation, 1.8);
  // The opaque near-white is part of how SwiftUI composes the material, not a
  // layer of the design. Drawn as one it covered the blur completely.
  assert.deepEqual(material.children, []);
});

test("a material inside a screen does not turn the screen into one", () => {
  // The backdrop is three levels down. Folding on that alone made the whole
  // screen a frosted pane and dropped every coloured layer on it.
  const { tree } = buildLayerTree(capture([{
    frame: { x: 0, y: 0, width: 200, height: 100 },
    kind: "effect",
    children: [
      { ...MATERIAL, frame: { x: 40, y: 20, width: 119.5, height: 56 } },
      box({ kind: "color", frame: { x: 0, y: 90, width: 200, height: 10 }, fill: { kind: "color", color: { r: 1, g: 0, b: 0, a: 1 } } })
    ]
  }]));
  const screen = tree.children[0];
  assert.equal(screen.name, "Group");
  assert.equal(screen.style.backdropBlur, 0);
  const material = screen.children.find((child) => child.name === "Material");
  assert.equal(material.width, 119.5);
  // The stripe on the screen is not part of any material's recipe.
  assert.ok(screen.children.some((child) => child.style.backgroundColor === "rgba(255, 0, 0, 1)"));
});

test("what sits on a material is kept", () => {
  const withLabel = {
    ...MATERIAL,
    children: [
      ...MATERIAL.children,
      box({ kind: "text", text: "Material card", textStyle: { fontSize: 13 }, frame: { x: 20, y: 20, width: 80, height: 16 } })
    ]
  };
  const material = buildLayerTree(capture([withLabel])).tree.children[0];
  assert.equal(material.children.length, 1);
  assert.equal(material.children[0].text, "Material card");
});

test("a blur laid over content is carried, not quietly dropped", () => {
  const { tree } = buildLayerTree(capture([{
    frame: { x: 10, y: 10, width: 70, height: 16 },
    kind: "effect",
    effect: "filter",
    filter: "blur",
    blur: 8,
    children: [{ frame: { x: 0, y: 0, width: 70, height: 16 }, kind: "text", text: "blurred", textStyle: { fontSize: 13 } }]
  }]));
  assert.equal(tree.children[0].style.blur, 8);
});

/** A picture of a 200x100 screen, shaded top to bottom, at 2x. */
const shadedScreen = () => {
  const { PNG } = require("pngjs");
  const png = new PNG({ width: 400, height: 200 });
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const index = (png.width * y + x) << 2;
      png.data[index] = 40;
      png.data[index + 1] = 40;
      png.data[index + 2] = Math.round(100 + (155 * y) / (png.height - 1));
      png.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(png).toString("base64");
};

const gradientScreen = {
  frame: { x: 0, y: 0, width: 200, height: 100 },
  kind: "shape",
  path: "0 0 m 200 0 l 200 100 l 0 100 l h",
  fill: { kind: "gradient" }
};

test("a gradient the display list will not describe is read off the screen instead", () => {
  const { tree, warnings } = buildLayerTree({ ...capture([gradientScreen]), screenshot: shadedScreen() });
  const shape = tree.children[0];
  assert.equal(shape.kind, "svg");
  assert.match(shape.svg, /<linearGradient[^>]*x1="0" y1="0" x2="0" y2="1"/);
  assert.match(shape.svg, /stop-color="rgb\(40, 40, 1\d\d\)"/);
  assert.match(shape.svg, /stop-color="rgb\(40, 40, 25[0-5]\)"/);
  assert.match(shape.svg, /fill="url\(#crank-fill-/);
  // Substituted, and said so — the colours are the app's own pixels, not the
  // stops, which nothing in the display list carries.
  assert.match(warnings.join(" "), /read off the picture/);
});

test("with no picture to read, a gradient is left undrawn and named", () => {
  const { tree, warnings } = buildLayerTree(capture([gradientScreen]));
  assert.match(tree.children[0].svg, /fill="none"/);
  assert.match(warnings.join(" "), /no picture of the screen/);
});

test("a gradient background stays a vector, because it has no one colour to fold", () => {
  const { tree, warnings } = buildLayerTree(capture([{
    frame: { x: 0, y: 0, width: 100, height: 40 },
    kind: "effect",
    children: [{
      frame: { x: 0, y: 0, width: 100, height: 40 },
      kind: "shape",
      path: "0 0 m 100 0 l 100 40 l 0 40 l h",
      fill: { kind: "gradient" }
    }]
  }]));
  const group = tree.children[0];
  assert.equal(group.name, "Group");
  assert.equal(group.children[0].kind, "svg");
  assert.match(warnings.join(" "), /could not be drawn/);
});

test("an item SwiftUI numbered keeps that number as its identity", () => {
  const { tree } = buildLayerTree(capture([{
    frame: { x: 0, y: 0, width: 10, height: 10 },
    kind: "color",
    identity: "42",
    fill: { kind: "color", color: { r: 0, g: 0, b: 0, a: 1 } }
  }]), { pageId: "home" });
  assert.equal(tree.children[0].id, "home/dl:42");
  assert.equal(tree.children[0].selector, "displaylist:42");
});

test("an image with no pixels is named as a gap rather than drawn as an empty box", () => {
  const { tree, warnings } = buildLayerTree(capture([{
    frame: { x: 0, y: 0, width: 20, height: 20 },
    kind: "image",
    imageSize: { width: 20, height: 20 }
  }]));
  assert.match(tree.children[0].name, /not captured/);
  assert.equal(warnings.length, 1);
});

test("a platform view that draws itself is bounded to its own box", () => {
  const { tree, warnings } = buildLayerTree(capture([{
    frame: { x: 5, y: 5, width: 30, height: 30 },
    kind: "platformView",
    opaque: true
  }]));
  assert.equal(tree.children[0].width, 30);
  assert.match(warnings.join(" "), /Platform view|platform view/);
});

test("a capture that is not one is refused rather than half read", () => {
  assert.throws(() => buildLayerTree({ ok: true, viewport: { width: 0, height: 10 }, items: [] }));
  assert.throws(() => buildLayerTree({ ok: false }));
});

const rect = (x, y, width, height) => ({ x, y, width, height });
const background = (frame) => ({
  frame,
  kind: "shape",
  path: `0 0 m ${frame.width} 0 l ${frame.width} ${frame.height} l 0 ${frame.height} l h`,
  fill: { kind: "color", color: { r: 1, g: 1, b: 1, a: 1 } }
});
const label = (frame, text) => ({ frame, kind: "text", text, textStyle: { fontSize: 13, weight: 400 } });

test("a flat background and the siblings drawn inside it become one group", () => {
  const grouped = groupBackgroundSiblings([
    background(rect(10, 10, 100, 50)),
    label(rect(20, 20, 40, 12), "Two unread"),
    label(rect(20, 36, 40, 12), "Since yesterday")
  ], rect(0, 0, 400, 400));

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].kind, "effect");
  assert.equal(grouped[0].children.length, 3);
  // Children are measured against the background they now sit in.
  assert.deepEqual(grouped[0].children[1].frame, rect(10, 10, 40, 12));
  assert.deepEqual(grouped[0].children[2].frame, rect(10, 26, 40, 12));
});

test("the run stops at the first sibling drawn outside the background", () => {
  const outside = label(rect(300, 300, 40, 12), "Elsewhere");
  const grouped = groupBackgroundSiblings([
    background(rect(10, 10, 100, 50)),
    label(rect(20, 20, 40, 12), "Inside"),
    outside,
    label(rect(20, 36, 40, 12), "Also inside, but after the break")
  ], rect(0, 0, 400, 400));

  assert.equal(grouped.length, 3);
  assert.equal(grouped[0].children.length, 2);
  assert.equal(grouped[1].text, "Elsewhere");
});

test("a background with nothing inside it stays what it was", () => {
  const grouped = groupBackgroundSiblings([
    background(rect(10, 10, 100, 50)),
    label(rect(300, 300, 40, 12), "Elsewhere")
  ], rect(0, 0, 400, 400));
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].kind, "shape");
});

test("a backdrop covering the screen does not swallow the screen", () => {
  const grouped = groupBackgroundSiblings([
    background(rect(0, 0, 400, 400)),
    label(rect(20, 20, 40, 12), "On top")
  ], rect(0, 0, 400, 400));
  assert.equal(grouped.length, 2);
  assert.equal(grouped[0].kind, "shape");
});

test("a gradient is not a background to nest things under", () => {
  const gradient = {
    frame: rect(10, 10, 100, 50),
    kind: "shape",
    path: "0 0 m 100 0 l 100 50 l 0 50 l h",
    fill: { kind: "gradient" }
  };
  const grouped = groupBackgroundSiblings([gradient, label(rect(20, 20, 40, 12), "Inside")], rect(0, 0, 400, 400));
  assert.equal(grouped.length, 2);
});

test("grouping reaches inside a group SwiftUI had already made", () => {
  const grouped = groupBackgroundSiblings([{
    frame: rect(0, 0, 200, 100),
    kind: "effect",
    children: [background(rect(10, 10, 100, 50)), label(rect(20, 20, 40, 12), "Inside")]
  }], rect(0, 0, 400, 400));
  assert.equal(grouped[0].children.length, 1);
  assert.equal(grouped[0].children[0].kind, "effect");
});

test("an image the capture reached the pixels of arrives as a picture", () => {
  const png = "iVBORw0KGgo=";
  const { tree, warnings } = buildLayerTree(capture([{
    frame: { x: 4, y: 6, width: 24, height: 24 },
    kind: "image",
    imageSize: { width: 48, height: 48 },
    png
  }]));
  assert.equal(tree.children[0].kind, "image");
  assert.equal(tree.children[0].dataUrl, `data:image/png;base64,${png}`);
  assert.equal(warnings.length, 0);
});
