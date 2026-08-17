const BRIDGE_URL = "http://localhost:38457";
const NAMESPACE = "ui_sync";
const PROJECT_KEY = "project_id";
const SCREEN_KEY = "screen_id";
const CONTENT_ROOT_KEY = "content_root";
const DOM_ID_KEY = "dom_id";
const DOM_SELECTOR_KEY = "dom_selector";
const DOM_KIND_KEY = "dom_kind";
const DOM_SYNTHETIC_WRAP_KEY = "synthetic_wrap";
const CONNECTION_STORAGE_KEY = "ui-sync-device-connection-v2";
const ENGINE_VERSION = "2026-08-14-system-templates-v4";
const SYMBOL_MAP_FRAME_NAME = "UI Sync · SF Symbol Map";
// System templates are user-selected Figma instances, never hard-coded document nodes.
let activePairingCode = null;
let lastSystemTemplateDiagnostic = "not-run";

const COLORS = {
  background: { r: 0.949, g: 0.949, b: 0.969 },
  surface: { r: 1, g: 1, b: 1 },
  text: { r: 0.11, g: 0.11, b: 0.12 },
  secondaryText: { r: 0.43, g: 0.43, b: 0.46 },
  separator: { r: 0.79, g: 0.79, b: 0.81 },
  accent: { r: 0, g: 0.478, b: 1 },
  accentSoft: { r: 0.9, g: 0.95, b: 1 }
};

const TOKEN_COLORS = {
  flowPaper: { r: 0.96, g: 0.97, b: 0.99 },
  flowSand: { r: 0.34, g: 0.42, b: 0.56 },
  flowInk: { r: 0.09, g: 0.13, b: 0.19 },
  flowAccent: { r: 0.03, g: 0.44, b: 0.86 },
  flowAccentSoft: { r: 0.67, g: 0.8, b: 0.96 },
  flowNight: { r: 0.96, g: 0.97, b: 0.99 },
  flowNightSoft: { r: 0.9, g: 0.93, b: 0.97 },
  flowMint: { r: 0.12, g: 0.66, b: 0.42 },
  flowMuted: { r: 0.42, g: 0.49, b: 0.58 },
  flowPanel: { r: 1, g: 1, b: 1 },
  flowBorder: { r: 0.76, g: 0.82, b: 0.9 },
  flowOrange: { r: 0.9, g: 0.47, b: 0.1 },
  white: { r: 1, g: 1, b: 1 },
  black: { r: 0, g: 0, b: 0 },
  red: { r: 1, g: 0.23, b: 0.19 },
  clear: { r: 1, g: 1, b: 1 },
  primary: COLORS.text,
  secondary: COLORS.secondaryText,
  systemBackground: COLORS.surface,
  secondarySystemBackground: COLORS.background,
  separator: COLORS.separator,
  accentColor: COLORS.accent
};

function colorForToken(token, fallback = COLORS.text) {
  return TOKEN_COLORS[token] || fallback;
}

figma.showUI(__html__, { width: 360, height: 460, themeColors: true, title: "UI Sync Bridge" });

function normalizedName(value) {
  return String(value || "").normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function isFrame(node) {
  return node && node.type === "FRAME" && !node.removed;
}

function belongsToAnotherMapping(node, projectId, screenId) {
  const mappedProject = node.getSharedPluginData(NAMESPACE, PROJECT_KEY);
  const mappedScreen = node.getSharedPluginData(NAMESPACE, SCREEN_KEY);
  return Boolean(mappedProject && mappedScreen && (mappedProject !== projectId || mappedScreen !== screenId));
}

function markFrame(frame, projectId, screenId) {
  frame.setSharedPluginData(NAMESPACE, PROJECT_KEY, projectId);
  frame.setSharedPluginData(NAMESPACE, SCREEN_KEY, screenId);
  frame.setSharedPluginData(NAMESPACE, "identity_version", "1");
}

/** @param {RGB} color @param {number} opacity @returns {SolidPaint[]} */
function solid(color, opacity = 1) {
  return [{ type: "SOLID", color, opacity }];
}

/** @param {string} name @param {"VERTICAL" | "HORIZONTAL"} direction */
function createLayout(name, direction = "VERTICAL") {
  const frame = figma.createFrame();
  frame.name = name;
  frame.layoutMode = direction;
  frame.primaryAxisSizingMode = "AUTO";
  frame.counterAxisSizingMode = "AUTO";
  frame.fills = [];
  frame.clipsContent = false;
  return frame;
}

function append(parent, child, horizontal = "FILL") {
  parent.appendChild(child);
  if (horizontal === "FILL") {
    if (parent.layoutMode === "VERTICAL") parent.counterAxisSizingMode = "FIXED";
    if (parent.layoutMode === "HORIZONTAL") parent.primaryAxisSizingMode = "FIXED";
    child.layoutSizingHorizontal = "FILL";
  }
  return child;
}

function preferredFonts(available) {
  const names = available.map((font) => font.fontName);
  const regular = names.find((font) => /^SF Pro( Text| Display)?$/.test(font.family) && font.style === "Regular");
  if (!regular) throw new Error("SF Pro is unavailable in Figma. Enable Figma Font Helper, then run UI Sync Bridge again.");
  const findWeight = (styles) => names.find((font) => font.family === regular.family && styles.includes(font.style)) || regular;
  const monospaced = names.find((font) => /^SF Mono$/.test(font.family) && font.style === "Regular") || regular;
  const cjkFamilies = ["PingFang SC", "Hiragino Sans GB", "Chiron Hei HK", "Noto Sans CJK SC", "Noto Sans SC"];
  const cjkRegular = cjkFamilies.flatMap((family) => names.filter((font) => font.family === family))
    .find((font) => ["Regular", "Text", "Normal", "Roman"].includes(font.style))
    || cjkFamilies.flatMap((family) => names.filter((font) => font.family === family))[0]
    || null;
  const findCjkWeight = (styles) => cjkRegular
    ? names.find((font) => font.family === cjkRegular.family && styles.includes(font.style)) || cjkRegular
    : null;
  return {
    regular,
    medium: findWeight(["Medium", "Semibold", "Regular"]),
    semibold: findWeight(["Semibold", "Medium", "Bold", "Regular"]),
    bold: findWeight(["Bold", "Semibold", "Medium", "Regular"]),
    heavy: findWeight(["Heavy", "Black", "Bold", "Semibold"]),
    black: findWeight(["Black", "Heavy", "Bold", "Semibold"]),
    monospaced,
    cjkRegular,
    cjkMedium: findCjkWeight(["Medium", "Semibold", "Regular", "Text"]),
    cjkSemibold: findCjkWeight(["Semibold", "Medium", "Bold", "Regular"]),
    cjkBold: findCjkWeight(["Bold", "Semibold", "Medium", "Regular"]),
    cjkHeavy: findCjkWeight(["Heavy", "Black", "Bold", "Semibold"]),
    cjkBlack: findCjkWeight(["Black", "Heavy", "Bold", "Semibold"]),
    available: names,
    loaded: new Set()
  };
}

async function loadProductFonts() {
  const fonts = preferredFonts(await figma.listAvailableFontsAsync());
  const baseFonts = [
    fonts.regular, fonts.medium, fonts.semibold, fonts.bold, fonts.heavy, fonts.black, fonts.monospaced,
    fonts.cjkRegular, fonts.cjkMedium, fonts.cjkSemibold, fonts.cjkBold, fonts.cjkHeavy, fonts.cjkBlack
  ].filter(Boolean);
  const unique = new Map(baseFonts.map((font) => [`${font.family}:${font.style}`, font]));
  await Promise.all([...unique.values()].map(async (font) => {
    await figma.loadFontAsync(font);
    fonts.loaded.add(`${font.family}:${font.style}`);
  }));
  return fonts;
}

function cssFamilyCandidates(value) {
  const input = Array.isArray(value) ? value : String(value || "").split(",");
  return input.map((family) => String(family).trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
}

function styleWeight(style) {
  const normalized = normalizedName(style);
  if (normalized.includes("thin")) return 100;
  if (normalized.includes("extralight") || normalized.includes("ultralight")) return 200;
  if (normalized.includes("light")) return 300;
  if (normalized.includes("medium")) return 500;
  if (normalized.includes("semibold") || normalized.includes("demibold")) return 600;
  if (normalized.includes("extrabold") || normalized.includes("ultrabold")) return 800;
  if (normalized.includes("black") || normalized.includes("heavy")) return 900;
  if (normalized.includes("bold")) return 700;
  return 400;
}

function isItalicStyle(style) {
  const normalized = normalizedName(style);
  return normalized.includes("italic") || normalized.includes("oblique");
}

async function ensureFontLoaded(fonts, font) {
  const key = `${font.family}:${font.style}`;
  if (!fonts.loaded.has(key)) {
    await figma.loadFontAsync(font);
    fonts.loaded.add(key);
  }
  return font;
}

async function resolveMeasuredFont(fonts, measuredStyle, value) {
  const systemFamilies = new Set([
    "systemui", "uisansserif", "sansserif", "apple-system", "blinkmacsystemfont",
    "sfpro", "sfprotext", "sfprodisplay"
  ]);
  const requested = measuredStyle?.resolvedFontFamily
    ? [measuredStyle.resolvedFontFamily]
    : cssFamilyCandidates(measuredStyle?.fontFamilies);
  if (requested.length === 0) return fontForText(fonts, value, weightName(measuredStyle?.fontWeight));
  const desiredWeight = Number(measuredStyle?.fontWeight) || 400;
  const wantsItalic = measuredStyle?.fontStyle === "italic" || measuredStyle?.fontStyle === "oblique";
  for (const family of requested) {
    if (systemFamilies.has(normalizedName(family))) {
      return fontForText(fonts, value, weightName(desiredWeight));
    }
    const matches = fonts.available.filter((font) => normalizedName(font.family) === normalizedName(family));
    if (matches.length === 0) continue;
    matches.sort((left, right) => {
      const leftItalicPenalty = isItalicStyle(left.style) === wantsItalic ? 0 : 1000;
      const rightItalicPenalty = isItalicStyle(right.style) === wantsItalic ? 0 : 1000;
      return leftItalicPenalty + Math.abs(styleWeight(left.style) - desiredWeight)
        - rightItalicPenalty - Math.abs(styleWeight(right.style) - desiredWeight);
    });
    return ensureFontLoaded(fonts, matches[0]);
  }
  throw new Error(`The webpage uses ${requested.join(", ")}, but that font is unavailable in Figma. Install or enable the font, then sync again.`);
}

function weightName(value) {
  const weight = typeof value === "number" ? value : {
    regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900
  }[value] || 400;
  if (weight >= 850) return "black";
  if (weight >= 750) return "heavy";
  if (weight >= 650) return "bold";
  if (weight >= 550) return "semibold";
  if (weight >= 450) return "medium";
  return "regular";
}

function fontForText(fonts, value, weight) {
  weight = weightName(weight);
  if (!/[\u2e80-\u2eff\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u.test(String(value || ""))) {
    return fonts[weight] || fonts.regular;
  }
  const suffix = weight.slice(0, 1).toUpperCase() + weight.slice(1);
  const selected = fonts[`cjk${suffix}`] || fonts.cjkRegular;
  if (!selected) throw new Error("This screen contains CJK text, but Figma has no compatible CJK font. Install PingFang, Chiron Hei HK, or Noto Sans CJK, then sync again.");
  return selected;
}

function fontSize(style) {
  return {
    largeTitle: 34, title: 28, title2: 22, title3: 20, headline: 17,
    subheadline: 15, body: 17, callout: 16, footnote: 13, caption: 12, caption2: 11
  }[style] || 17;
}

function parseInlineMarkdown(value) {
  const source = String(value || "");
  const codeRanges = [];
  let characters = "";
  let cursor = 0;
  for (const match of source.matchAll(/`([^`\n]+)`/g)) {
    characters += source.slice(cursor, match.index);
    const start = characters.length;
    characters += match[1];
    codeRanges.push({ start, end: characters.length });
    cursor = match.index + match[0].length;
  }
  characters += source.slice(cursor);
  return { characters, codeRanges };
}

function createTextNode(value, fonts, options = {}) {
  const text = figma.createText();
  const weight = options.weight || "regular";
  const content = parseInlineMarkdown(value);
  text.name = options.name || "Text";
  text.fontName = fontForText(fonts, content.characters, weight);
  text.fontSize = options.size || 17;
  text.characters = content.characters;
  for (const range of content.codeRanges) {
    text.setRangeFontName(range.start, range.end, fonts.monospaced || fonts.regular);
  }
  text.fills = solid(options.color || COLORS.text, options.opacity ?? 1);
  if (options.tracking !== undefined) text.letterSpacing = { unit: "PIXELS", value: options.tracking };
  if (options.lineSpacing !== undefined) {
    text.lineHeight = { unit: "PIXELS", value: (options.size || 17) * 1.2 + options.lineSpacing };
  }
  if (options.alignment) {
    text.textAlignHorizontal = options.alignment === "leading" ? "LEFT" : options.alignment === "trailing" ? "RIGHT" : "CENTER";
  }
  if (options.width) {
    text.textAutoResize = "HEIGHT";
    text.resize(options.width, Math.max(1, (options.size || 17) * 1.25));
  } else {
    text.textAutoResize = "WIDTH_AND_HEIGHT";
  }
  return text;
}

function fixFrameSize(node, width, height) {
  node.resize(width || node.width, height || node.height);
  if (node.type === "FRAME" && node.layoutMode !== "NONE") {
    if (width) {
      if (node.layoutMode === "HORIZONTAL") node.primaryAxisSizingMode = "FIXED";
      else node.counterAxisSizingMode = "FIXED";
    }
    if (height) {
      if (node.layoutMode === "VERTICAL") node.primaryAxisSizingMode = "FIXED";
      else node.counterAxisSizingMode = "FIXED";
    }
  }
}

function constrainNodeWidth(node, width) {
  if (!(width > 0) || !("resize" in node)) return;
  if (node.type === "TEXT") {
    node.textAutoResize = "HEIGHT";
    node.resize(width, Math.max(1, node.height));
    return;
  }
  fixFrameSize(node, width, null);
  if (!("children" in node) || node.layoutMode === "HORIZONTAL") return;
  const innerWidth = Math.max(1, width - (node.paddingLeft || 0) - (node.paddingRight || 0));
  for (const child of node.children) {
    if (child.width > innerWidth) constrainNodeWidth(child, innerWidth);
  }
}

function applyNodeStyle(node, ir) {
  if (ir.padding && node.type === "FRAME") {
    // SwiftUI permits negative padding, while Figma Auto Layout does not.
    // Runtime-captured geometry preserves the real overlap; static fallback
    // keeps the source value as plugin data and uses a safe zero inset.
    node.paddingTop = Math.max(0, ir.padding.top);
    node.paddingRight = Math.max(0, ir.padding.right);
    node.paddingBottom = Math.max(0, ir.padding.bottom);
    node.paddingLeft = Math.max(0, ir.padding.left);
  }
  if (ir.backgroundColorToken && "fills" in node) {
    node.fills = solid(colorForToken(ir.backgroundColorToken, COLORS.surface), ir.backgroundColorToken === "clear" ? 0 : (ir.backgroundOpacity ?? 1));
  }
  if (ir.borderColorToken && "strokes" in node) {
    node.strokes = solid(colorForToken(ir.borderColorToken, COLORS.separator), ir.borderOpacity ?? 1);
    node.strokeWeight = ir.borderWidth || 1;
  }
  if (ir.cornerRadius !== undefined && "cornerRadius" in node) node.cornerRadius = ir.cornerRadius;
  if ((ir.width || ir.height) && "resize" in node) fixFrameSize(node, ir.width, ir.height);
  if (ir.runtimeFrame && "resize" in node && ir.runtimeFrame.width > 0 && ir.runtimeFrame.height > 0) {
    if (node.type === "TEXT") node.textAutoResize = "NONE";
    fixFrameSize(node, ir.runtimeFrame.width, ir.runtimeFrame.height);
  }
  if (ir.backgroundShape === "capsule" && "cornerRadius" in node) node.cornerRadius = Math.min(node.width, node.height) / 2;
  if (ir.backgroundShape === "circle" && "cornerRadius" in node) node.cornerRadius = Math.min(node.width, node.height) / 2;
  if (ir.opacity !== undefined && "opacity" in node) node.opacity = ir.opacity;
  if (ir.blurRadius && "effects" in node) {
    node.effects = [{ type: "LAYER_BLUR", radius: ir.blurRadius, visible: true }];
  }
  if (ir.shadowRadius && "effects" in node) {
    const shadowColor = colorForToken(ir.shadowColorToken, { r: 0, g: 0, b: 0 });
    node.effects = [...(node.effects || []), {
      type: "DROP_SHADOW",
      color: { ...shadowColor, a: ir.shadowOpacity ?? 0.16 },
      offset: { x: ir.shadowX || 0, y: ir.shadowY || 0 },
      radius: ir.shadowRadius,
      spread: 0,
      visible: true,
      blendMode: "NORMAL"
    }];
  }
  if (ir.material && "effects" in node && "fills" in node) {
    const prominent = ir.material === "glassProminent";
    const blurRadius = {
      ultraThin: 10, thin: 16, regular: 24, thick: 32, ultraThick: 40,
      glass: 24, glassProminent: 28
    }[ir.material] || 24;
    node.fills = solid(prominent ? COLORS.accentSoft : COLORS.surface, prominent ? 0.72 : 0.48);
    if ("strokes" in node) {
      node.strokes = solid(COLORS.surface, 0.72);
      node.strokeWeight = 1;
    }
    node.effects = [
      { type: "BACKGROUND_BLUR", blurType: "NORMAL", radius: blurRadius, visible: true },
      {
        type: "DROP_SHADOW",
        color: { r: 0, g: 0, b: 0, a: prominent ? 0.18 : 0.1 },
        offset: { x: 0, y: prominent ? 8 : 4 },
        radius: prominent ? 20 : 12,
        spread: 0,
        visible: true,
        blendMode: "NORMAL"
      }
    ];
    node.setSharedPluginData(NAMESPACE, "swiftui_material", ir.material);
    node.setSharedPluginData(NAMESPACE, "apple_kit_preferred", prominent ? "Button · Glass Prominent" : "Button · Glass");
  }
}

function hasRuntimeGeometry(ir) {
  return ir?.runtimeStatus === "captured" && ir.runtimeFrame?.width > 0 && ir.runtimeFrame?.height > 0;
}

function applyRuntimeChildGeometry(parent, child, parentIr, childIr) {
  if (!hasRuntimeGeometry(parentIr) || !hasRuntimeGeometry(childIr)) return false;
  if (parent.layoutMode !== "NONE") child.layoutPositioning = "ABSOLUTE";
  child.layoutSizingHorizontal = "FIXED";
  child.layoutSizingVertical = "FIXED";
  child.layoutGrow = 0;
  child.x = childIr.runtimeFrame.x - parentIr.runtimeFrame.x;
  child.y = childIr.runtimeFrame.y - parentIr.runtimeFrame.y;
  if (child.type === "TEXT") child.textAutoResize = "NONE";
  if ("resize" in child) fixFrameSize(child, childIr.runtimeFrame.width, childIr.runtimeFrame.height);
  return true;
}

function appendRuntimeInstanceClones(parent, child, parentIr, childIr) {
  if (!hasRuntimeGeometry(parentIr) || !Array.isArray(childIr.runtimeInstances) || childIr.runtimeInstances.length < 2) return [];
  const clones = [];
  for (const instance of childIr.runtimeInstances.slice(1)) {
    const clone = child.clone();
    parent.appendChild(clone);
    if (parent.layoutMode !== "NONE") clone.layoutPositioning = "ABSOLUTE";
    clone.layoutSizingHorizontal = "FIXED";
    clone.layoutSizingVertical = "FIXED";
    clone.layoutGrow = 0;
    clone.x = instance.x - parentIr.runtimeFrame.x;
    clone.y = instance.y - parentIr.runtimeFrame.y;
    if (clone.type === "TEXT") clone.textAutoResize = "NONE";
    if ("resize" in clone) fixFrameSize(clone, instance.width, instance.height);
    clone.setSharedPluginData(NAMESPACE, "runtime_instance_id", instance.instanceId);
    clone.setSharedPluginData(NAMESPACE, "runtime_frame", JSON.stringify(instance));
    clones.push(clone);
  }
  return clones;
}

function alignmentForStack(ir, direction) {
  const alignment = ir.alignment || (direction === "VERTICAL" ? "center" : "center");
  if (direction === "VERTICAL") {
    if (["leading", "topLeading", "bottomLeading"].includes(alignment)) return "MIN";
    if (["trailing", "topTrailing", "bottomTrailing"].includes(alignment)) return "MAX";
    return "CENTER";
  }
  if (["top", "topLeading", "topTrailing"].includes(alignment)) return "MIN";
  if (["bottom", "bottomLeading", "bottomTrailing"].includes(alignment)) return "MAX";
  return "CENTER";
}

function symbolFallback(name) {
  if (/checkmark/.test(name)) return "✓";
  if (/arrow\.clockwise|circlepath/.test(name)) return "↻";
  if (/gear/.test(name)) return "⚙";
  if (/trash/.test(name)) return "×";
  if (/list|line\.3|checklist/.test(name)) return "≡";
  if (/mic/.test(name)) return "●";
  if (/spark|wand/.test(name)) return "✦";
  if (/chevron\.left/.test(name)) return "‹";
  if (/chevron\.right/.test(name)) return "›";
  return "•";
}

function sfSymbolCharacter(name) {
  const figmaUtility = /** @type {any} */ (figma).util;
  if (!figmaUtility || typeof figmaUtility.getSfSymbolCharacter !== "function") return null;
  try { return figmaUtility.getSfSymbolCharacter(name); } catch { return null; }
}

function colorHex(color) {
  const channel = (value) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, "0");
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

function symbolSvg(name, color) {
  const paint = colorHex(color);
  const paths = {
    "mic.fill": `<path d="M12 14.5a4.5 4.5 0 0 0 4.5-4.5V5.5a4.5 4.5 0 1 0-9 0V10a4.5 4.5 0 0 0 4.5 4.5Z" fill="${paint}"/><path d="M5 10a7 7 0 0 0 14 0M12 17v4M8.5 21h7" fill="none" stroke="${paint}" stroke-width="1.8" stroke-linecap="round"/>`,
    "checkmark": `<path d="m5 12.5 4.5 4.5L19 7" fill="none" stroke="${paint}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
    "list.bullet": `<path d="M9 6h11M9 12h11M9 18h11" fill="none" stroke="${paint}" stroke-width="1.9" stroke-linecap="round"/><circle cx="4.5" cy="6" r="1.2" fill="${paint}"/><circle cx="4.5" cy="12" r="1.2" fill="${paint}"/><circle cx="4.5" cy="18" r="1.2" fill="${paint}"/>`,
    "sparkles": `<path d="M12 2c.7 4.3 2.7 6.3 7 7-4.3.7-6.3 2.7-7 7-.7-4.3-2.7-6.3-7-7 4.3-.7 6.3-2.7 7-7ZM19 15c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3Z" fill="${paint}"/>`,
    "wand.and.stars": `<path d="m5 19 10-10M4 20l-1-1 3-3 1 1-3 3ZM16 3c.3 1.8 1.2 2.7 3 3-1.8.3-2.7 1.2-3 3-.3-1.8-1.2-2.7-3-3 1.8-.3 2.7-1.2 3-3ZM19 11c.2 1.2.8 1.8 2 2-1.2.2-1.8.8-2 2-.2-1.2-.8-1.8-2-2 1.2-.2 1.8-.8 2-2Z" fill="${paint}" stroke="${paint}" stroke-width="1.5" stroke-linecap="round"/>`,
    "gearshape": `<path d="M9.7 2.8h4.6l.6 2.2c.5.2.9.4 1.3.7l2.2-.7 2.3 4-1.7 1.5a7 7 0 0 1 0 1.5l1.7 1.5-2.3 4-2.2-.7c-.4.3-.8.5-1.3.7l-.6 2.2H9.7l-.6-2.2c-.5-.2-.9-.4-1.3-.7l-2.2.7-2.3-4L5 12a7 7 0 0 1 0-1.5L3.3 9l2.3-4 2.2.7c.4-.3.8-.5 1.3-.7l.6-2.2Z" fill="none" stroke="${paint}" stroke-width="1.7" stroke-linejoin="round"/><circle cx="12" cy="11.25" r="3" fill="none" stroke="${paint}" stroke-width="1.7"/>`,
    "checklist": `<path d="m3.5 6 1.5 1.5 2.5-3M3.5 12l1.5 1.5 2.5-3M3.5 18l1.5 1.5 2.5-3M10 6h10M10 12h10M10 18h10" fill="none" stroke="${paint}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    "arrow.triangle.2.circlepath": `<path d="M18.5 8A7.5 7.5 0 0 0 6 5.5L4 7.5M5.5 16A7.5 7.5 0 0 0 18 18.5l2-2M4 3.8v3.7h3.7M20 20.2v-3.7h-3.7" fill="none" stroke="${paint}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    "checkmark.circle.fill": `<circle cx="12" cy="12" r="10" fill="${paint}"/><path d="m7.5 12 3 3 6-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "checkmark.square.fill": `<rect x="3" y="3" width="18" height="18" rx="4" fill="${paint}"/><path d="m7.5 12 3 3 6-6" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "square": `<rect x="3.5" y="3.5" width="17" height="17" rx="3.5" fill="none" stroke="${paint}" stroke-width="1.8"/>`,
    "chevron.left": `<path d="m15 5-7 7 7 7" fill="none" stroke="${paint}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "chevron.right": `<path d="m9 5 7 7-7 7" fill="none" stroke="${paint}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>`,
    "trash": `<path d="M5 7h14M9 7V4h6v3M7 7l1 13h8l1-13M10 10v7M14 10v7" fill="none" stroke="${paint}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  };
  const path = paths[name];
  return path ? `<svg width="24" height="24" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">${path}</svg>` : null;
}

function createSymbolNode(name, fonts, options = {}) {
  const character = sfSymbolCharacter(name);
  if (!character) {
    const svg = symbolSvg(name, options.color || COLORS.accent);
    if (svg) {
      const icon = figma.createNodeFromSvg(svg);
      icon.name = `SF Symbol · ${name}`;
      icon.resize(options.size || 17, options.size || 17);
      icon.opacity = options.opacity ?? 1;
      icon.setSharedPluginData(NAMESPACE, "sf_symbol_name", name);
      return icon;
    }
  }
  const symbol = createTextNode(character || symbolFallback(name), fonts, {
    size: options.size || 17,
    weight: options.weight || "semibold",
    color: options.color || COLORS.accent,
    opacity: options.opacity,
    name: `SF Symbol · ${name}`
  });
  symbol.textAutoResize = "WIDTH_AND_HEIGHT";
  symbol.setSharedPluginData(NAMESPACE, "sf_symbol_name", name);
  return symbol;
}

function componentPropertyKey(instance, name, type) {
  const expected = normalizedName(name);
  return Object.entries(instance.componentProperties || {}).find(([key, property]) =>
    normalizedName(key.split("#")[0]) === expected && (!type || property.type === type)
  )?.[0] || null;
}

function templateSymbolCharacter(template, name, page) {
  const value = template.getSharedPluginData(NAMESPACE, "sf_symbol_map");
  if (value) {
    try {
      const mapping = JSON.parse(value);
      if (typeof mapping?.[name] === "string" && mapping[name]) return mapping[name];
    } catch {
      // Shared plugin data is optional; ordinary document metadata below is the portable path.
    }
  }
  const mapFrame = page.children.find((node) => node.type === "FRAME" && node.name === SYMBOL_MAP_FRAME_NAME);
  if (!mapFrame || mapFrame.type !== "FRAME") return null;
  const prefix = `${name}=`;
  const entry = mapFrame.children.find((node) => node.name.startsWith(prefix));
  return entry?.name.slice(prefix.length) || null;
}

async function markedSystemTemplate(kind, page) {
  if (figma.currentPage.id !== page.id) await figma.setCurrentPageAsync(page);
  const candidates = /** @type {InstanceNode[]} */ (page.findAll((node) =>
    node.parent === page &&
    node.type === "INSTANCE" &&
    (
      node.getSharedPluginData(NAMESPACE, "system_template") === kind ||
      (kind === "TabView" && node.name === "Tab Bar - iPhone") ||
      (kind === "Button" && node.name === "Button - Liquid Glass - Text")
    )
  ));
  const compatible = candidates.filter((node) => kind === "Button"
    ? componentPropertyKey(node, "Size", "VARIANT") &&
      componentPropertyKey(node, "Style", "VARIANT") &&
      componentPropertyKey(node, "Is Enabled", "VARIANT") &&
      componentPropertyKey(node, "Destructive", "VARIANT")
    : componentPropertyKey(node, "Tabs", "VARIANT") &&
      componentPropertyKey(node, "Minimized", "VARIANT") &&
      componentPropertyKey(node, "Type", "VARIANT")
  );
  const selected = compatible.find((node) => node.getSharedPluginData(NAMESPACE, "system_template") === kind) || compatible[0] || null;
  lastSystemTemplateDiagnostic = `page=${page.id};candidates=${candidates.length};compatible=${compatible.length};selected=${selected?.id || "none"}`;
  return selected;
}

function firstButtonText(ir) {
  if (typeof ir?.text === "string" && ir.text.trim()) return ir.text.trim();
  for (const child of ir?.children || []) {
    const value = firstButtonText(child);
    if (value) return value;
  }
  return null;
}

function appleButtonSize(ir) {
  if (["mini", "small"].includes(ir.controlSize)) return "Small";
  if (ir.controlSize === "regular") return "Medium";
  if (["large", "extraLarge"].includes(ir.controlSize)) return "Large";
  const height = ir.runtimeFrame?.height || ir.height || 0;
  if (height > 0 && height <= 29) return "Small";
  if (height > 0 && height <= 36) return "Medium";
  return "Large";
}

async function createMarkedAppleButton(ir, context = {}, page = figma.currentPage) {
  if (!["glass", "glassProminent"].includes(ir.material)) return null;
  const label = firstButtonText(ir);
  if (!label) return null;
  const template = await markedSystemTemplate("Button", page);
  if (!template) return null;
  const instance = template.clone();
  if (instance.type !== "INSTANCE") {
    instance.remove();
    return null;
  }

  const sizeKey = componentPropertyKey(instance, "Size", "VARIANT");
  const styleKey = componentPropertyKey(instance, "Style", "VARIANT");
  const enabledKey = componentPropertyKey(instance, "Is Enabled", "VARIANT");
  const destructiveKey = componentPropertyKey(instance, "Destructive", "VARIANT");
  if (!sizeKey || !styleKey || !enabledKey || !destructiveKey) {
    instance.remove();
    return null;
  }
  instance.setProperties({
    [sizeKey]: appleButtonSize(ir),
    [styleKey]: ir.material === "glassProminent" ? "Glass Prominent" : "Glass",
    [enabledKey]: ir.isEnabled === false ? "False" : "True",
    [destructiveKey]: ir.destructive ? "True" : "False"
  });

  const labelInstance = /** @type {InstanceNode | undefined} */ (
    instance.findAll((node) => node.type === "INSTANCE" && node.name === "Text")[0]
  );
  const labelKey = labelInstance ? componentPropertyKey(labelInstance, "Label", "TEXT") : null;
  if (!labelInstance || !labelKey) {
    instance.remove();
    return null;
  }
  const mode = (ir.runtimeEnvironment?.colorScheme || context.colorScheme) === "dark" ? "Dark" : "Light";
  const modeKey = componentPropertyKey(labelInstance, "Mode", "VARIANT");
  labelInstance.setProperties({
    [labelKey]: label,
    ...(modeKey ? { [modeKey]: mode } : {})
  });
  for (const background of /** @type {InstanceNode[]} */ (
    instance.findAll((node) => node.type === "INSTANCE" && node.name === "BG")
  )) {
    const modeKey = componentPropertyKey(background, "Mode", "VARIANT");
    if (modeKey) background.setProperties({ [modeKey]: mode });
  }

  const templateDesignKit = template.getSharedPluginData(NAMESPACE, "template_design_kit") || "Apple UI Kit";
  instance.name = `Button · Apple ${templateDesignKit} Kit`;
  instance.setSharedPluginData(NAMESPACE, "system_template", "");
  instance.setSharedPluginData(NAMESPACE, "template_design_kit", "");
  instance.setSharedPluginData(NAMESPACE, "template_component", "");
  instance.setSharedPluginData(NAMESPACE, "system_component", "Button");
  instance.setSharedPluginData(NAMESPACE, "apple_design_kit", templateDesignKit);
  instance.setSharedPluginData(NAMESPACE, "apple_kit_status", "user-selected-template");
  instance.setSharedPluginData(NAMESPACE, "engine_version", ENGINE_VERSION);
  return instance;
}

async function createMarkedAppleTabBar(screen, spec, width, page) {
  if (spec.items.length < 2 || spec.items.length > 5) {
    lastSystemTemplateDiagnostic = `unsupported-tab-count=${spec.items.length}`;
    return null;
  }
  const template = await markedSystemTemplate("TabView", page);
  if (!template) return null;
  if (Math.abs(template.width - width) > 1) {
    lastSystemTemplateDiagnostic += `;width=${template.width};viewport=${width}`;
    return null;
  }

  const instance = template.clone();
  if (instance.type !== "INSTANCE") {
    lastSystemTemplateDiagnostic += `;clone-type=${instance.type}`;
    instance.remove();
    return null;
  }

  const tabsKey = componentPropertyKey(instance, "Tabs", "VARIANT");
  const minimizedKey = componentPropertyKey(instance, "Minimized", "VARIANT");
  const typeKey = componentPropertyKey(instance, "Type", "VARIANT");
  if (!tabsKey || !minimizedKey || !typeKey) {
    lastSystemTemplateDiagnostic += ";missing-outer-properties";
    instance.remove();
    return null;
  }
  instance.setProperties({
    [tabsKey]: String(spec.items.length),
    [minimizedKey]: "False",
    [typeKey]: "Default"
  });

  const tabInstances = /** @type {InstanceNode[]} */ (
    instance.findAll((node) => node.type === "INSTANCE" && node.name === "Tab")
  );
  if (tabInstances.length !== spec.items.length) {
    lastSystemTemplateDiagnostic += `;rendered-tabs=${tabInstances.length};expected-tabs=${spec.items.length}`;
    instance.remove();
    return null;
  }
  const mode = screen.uiTree?.runtimeEnvironment?.colorScheme === "dark" ? "Dark" : "Light";
  for (const [index, tabInstance] of tabInstances.entries()) {
    const labelKey = componentPropertyKey(tabInstance, "Label", "TEXT");
    const symbolKey = componentPropertyKey(tabInstance, "Symbol", "TEXT");
    const selectedKey = componentPropertyKey(tabInstance, "Selected", "VARIANT");
    const modeKey = componentPropertyKey(tabInstance, "Mode", "VARIANT");
    const symbol = sfSymbolCharacter(spec.items[index].systemImage) || templateSymbolCharacter(template, spec.items[index].systemImage, page);
    if (!labelKey || !symbolKey || !selectedKey || !symbol) {
      lastSystemTemplateDiagnostic += `;tab=${index};label=${Boolean(labelKey)};symbol-property=${Boolean(symbolKey)};selected=${Boolean(selectedKey)};sf-symbol=${Boolean(symbol)}`;
      instance.remove();
      return null;
    }
    tabInstance.setProperties({
      [labelKey]: spec.items[index].title,
      [symbolKey]: symbol,
      [selectedKey]: index === spec.selectedIndex ? "True" : "False",
      ...(modeKey ? { [modeKey]: mode } : {})
    });
  }
  const backgrounds = /** @type {InstanceNode[]} */ (
    instance.findAll((node) => node.type === "INSTANCE" && node.name === "BG")
  );
  for (const background of backgrounds) {
    const modeKey = componentPropertyKey(background, "Mode", "VARIANT");
    if (modeKey) background.setProperties({ [modeKey]: mode });
  }

  const templateDesignKit = template.getSharedPluginData(NAMESPACE, "template_design_kit") || "Apple UI Kit";
  instance.name = `Tab Bar · Apple ${templateDesignKit} Kit`;
  instance.setSharedPluginData(NAMESPACE, "system_template", "");
  instance.setSharedPluginData(NAMESPACE, "template_design_kit", "");
  instance.setSharedPluginData(NAMESPACE, "template_component", "");
  instance.setSharedPluginData(NAMESPACE, "system_component", "TabView");
  instance.setSharedPluginData(NAMESPACE, "apple_design_kit", templateDesignKit);
  instance.setSharedPluginData(NAMESPACE, "source_design_kit", spec.designKit || "");
  instance.setSharedPluginData(NAMESPACE, "apple_kit_status", "user-selected-template");
  instance.setSharedPluginData(NAMESPACE, "engine_version", ENGINE_VERSION);
  instance.setSharedPluginData(NAMESPACE, "template_diagnostic", `${lastSystemTemplateDiagnostic};matched=true`);
  return instance;
}

async function createSystemTabBar(screen, fonts, width, page = figma.currentPage) {
  const spec = screen.systemTabBar;
  if (!spec?.items?.length) return null;
  const markedTemplate = await createMarkedAppleTabBar(screen, spec, width, page);
  if (markedTemplate) return markedTemplate;
  const designKit = spec.designKit || "iOS (unversioned)";
  const liquidGlass = spec.appearance === "liquid-glass";
  const chrome = figma.createFrame();
  chrome.name = `Tab Bar · Apple ${designKit}`;
  chrome.layoutMode = "NONE";
  chrome.resize(width, 83);
  chrome.fills = [];
  chrome.clipsContent = false;
  chrome.setSharedPluginData(NAMESPACE, "system_component", "TabView");
  chrome.setSharedPluginData(NAMESPACE, "apple_design_kit", designKit);
  chrome.setSharedPluginData(NAMESPACE, "apple_kit_preferred", `${designKit} / Tab Bar - iPhone`);
  chrome.setSharedPluginData(NAMESPACE, "engine_version", ENGINE_VERSION);
  chrome.setSharedPluginData(NAMESPACE, "template_diagnostic", lastSystemTemplateDiagnostic);

  const bar = createLayout(liquidGlass ? "Tab Bar · Liquid Glass" : "Tab Bar · Classic", "HORIZONTAL");
  const barWidth = liquidGlass ? Math.max(1, width - 24) : width;
  const barHeight = liquidGlass ? 64 : 83;
  bar.resize(barWidth, barHeight);
  bar.primaryAxisSizingMode = "FIXED";
  bar.counterAxisSizingMode = "FIXED";
  bar.primaryAxisAlignItems = "SPACE_BETWEEN";
  bar.counterAxisAlignItems = "CENTER";
  bar.paddingTop = liquidGlass ? 7 : 9;
  bar.paddingRight = liquidGlass ? 18 : 42;
  bar.paddingBottom = liquidGlass ? 7 : 21;
  bar.paddingLeft = liquidGlass ? 18 : 42;
  bar.fills = solid(COLORS.surface, liquidGlass ? 0.68 : 0.82);
  bar.strokes = solid(liquidGlass ? COLORS.surface : COLORS.separator, liquidGlass ? 0.58 : 0.35);
  bar.strokeWeight = liquidGlass ? 1 : 0.5;
  if (liquidGlass) bar.cornerRadius = 32;
  /** @type {Effect[]} */
  const barEffects = [{ type: "BACKGROUND_BLUR", blurType: "NORMAL", radius: liquidGlass ? 32 : 24, visible: true }];
  if (liquidGlass) barEffects.push({
    type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.14 },
    offset: { x: 0, y: 4 }, radius: 14, spread: 0, visible: true, blendMode: "NORMAL"
  });
  bar.effects = barEffects;
  chrome.appendChild(bar);
  bar.x = liquidGlass ? 12 : 0;
  bar.y = liquidGlass ? 8 : 0;

  for (const [index, tab] of spec.items.entries()) {
    const selected = index === spec.selectedIndex;
    const item = createLayout(tab.title, "VERTICAL");
    item.itemSpacing = 3;
    item.counterAxisAlignItems = "CENTER";
    item.primaryAxisSizingMode = "AUTO";
    item.counterAxisSizingMode = "AUTO";
    item.layoutGrow = 1;
    item.appendChild(createSymbolNode(tab.systemImage, fonts, {
      size: 22,
      color: selected ? COLORS.accent : COLORS.text,
      weight: selected ? "semibold" : "regular"
    }));
    item.appendChild(createTextNode(tab.title, fonts, {
      size: 10,
      weight: "medium",
      color: selected ? COLORS.accent : COLORS.text
    }));
    item.setSharedPluginData(NAMESPACE, "tab_title", tab.title);
    item.setSharedPluginData(NAMESPACE, "sf_symbol_name", tab.systemImage);
    bar.appendChild(item);
  }

  const teamLibrary = /** @type {any} */ (figma).teamLibrary;
  if (teamLibrary && typeof teamLibrary.getAvailableComponentsAsync === "function") {
    try {
      const available = await teamLibrary.getAvailableComponentsAsync();
      const versionPattern = new RegExp(designKit.replace(/\s+/g, "\\s*"), "i");
      const appleTabBar = available.find((component) => {
        const metadata = `${component.name || ""} ${component.description || ""} ${component.descriptionMarkdown || ""}`;
        return /(?:^|\b)Tab Bar\s*-\s*iPhone(?:\b|$)/i.test(component.name || "") && versionPattern.test(metadata);
      });
      if (appleTabBar) {
        const component = await figma.importComponentByKeyAsync(appleTabBar.key);
        const instance = component.createInstance();
        instance.name = `Apple ${designKit} Kit · Tab Bar - iPhone`;
        instance.resize(width, 83);
        // The official component supplies the material/chrome. Its authored
        // placeholder labels and glyphs are hidden and replaced by the exact
        // TabView labels and SF Symbol names from SwiftUI below.
        for (const descendant of instance.findAll((node) =>
          node.type === "TEXT" || /(?:icon|symbol|glyph)/i.test(node.name)
        )) {
          descendant.visible = false;
        }
        const wrapper = figma.createFrame();
        wrapper.name = `Tab Bar · Apple ${designKit} Kit + SwiftUI content`;
        wrapper.layoutMode = "NONE";
        wrapper.resize(width, 83);
        wrapper.fills = [];
        wrapper.clipsContent = true;
        wrapper.appendChild(instance);
        instance.x = 0;
        instance.y = 0;
        bar.fills = [];
        bar.strokes = [];
        bar.effects = [];
        wrapper.appendChild(chrome);
        chrome.x = 0;
        chrome.y = 0;
        wrapper.setSharedPluginData(NAMESPACE, "apple_kit_component_key", appleTabBar.key);
        wrapper.setSharedPluginData(NAMESPACE, "apple_design_kit", designKit);
        return wrapper;
      }
    } catch {
      // The target file may not have Apple's Community library enabled. The
      // editable semantic bar above is the deliberate local fallback.
    }
  }
  chrome.setSharedPluginData(NAMESPACE, "apple_kit_status", "matching-library-not-enabled");
  return chrome;
}

function shouldFillChild(parentDirection, childIr) {
  if (childIr.fillWidth) return true;
  if (parentDirection === "HORIZONTAL") return false;
  return ["vstack", "hstack", "scroll", "list", "section", "group", "tabview", "field", "label", "toggle"].includes(childIr.type);
}

function requiresProposedWidth(ir) {
  if (!ir) return false;
  if (ir.fillWidth || ir.type === "spacer") return true;
  if (["scroll", "list", "section", "tabview"].includes(ir.type)) return true;
  return (ir.children || []).some(requiresProposedWidth);
}

function wrapLeaf(node, ir, name, context = {}) {
  const needsWrapper = Boolean(ir.padding || ir.backgroundColorToken || ir.borderColorToken || ir.width || ir.height || ir.fillWidth || ir.fillHeight);
  if (!needsWrapper) {
    applyNodeStyle(node, ir);
    return node;
  }
  const wrapper = createLayout(name, "HORIZONTAL");
  wrapper.counterAxisAlignItems = "CENTER";
  wrapper.primaryAxisAlignItems = ir.alignment === "trailing" ? "MAX" : ir.alignment === "leading" ? "MIN" : "CENTER";
  wrapper.appendChild(node);
  applyNodeStyle(wrapper, ir);
  if (ir.fillWidth && context.width) fixFrameSize(wrapper, context.width, null);
  return wrapper;
}

function markSwiftNode(node, ir, suffix = "") {
  if (!ir?.syncId) return node;
  if (!suffix && node.getSharedPluginData(NAMESPACE, DOM_ID_KEY)) return node;
  node.setSharedPluginData(NAMESPACE, DOM_ID_KEY, `${ir.syncId}${suffix}`);
  node.setSharedPluginData(NAMESPACE, DOM_SELECTOR_KEY, ir.sourceFile ? `${ir.sourceFile}#${ir.sourceName || "View"}` : "");
  node.setSharedPluginData(NAMESPACE, DOM_KIND_KEY, node.type === "TEXT" ? "text" : "element");
  if (ir.runtimeFrame) node.setSharedPluginData(NAMESPACE, "runtime_frame", JSON.stringify(ir.runtimeFrame));
  if (ir.runtimeStatus) node.setSharedPluginData(NAMESPACE, "runtime_status", ir.runtimeStatus);
  if (ir.runtimeEnvironment) node.setSharedPluginData(NAMESPACE, "runtime_environment", JSON.stringify(ir.runtimeEnvironment));
  if (ir.sourceRange) node.setSharedPluginData(NAMESPACE, "source_range", JSON.stringify(ir.sourceRange));
  if (ir.padding && Object.values(ir.padding).some((value) => value < 0)) {
    node.setSharedPluginData(NAMESPACE, "swift_negative_padding", JSON.stringify(ir.padding));
  }
  if (ir.visualMode) node.setSharedPluginData(NAMESPACE, "visual_mode", ir.visualMode);
  if (ir.visualConfidence) node.setSharedPluginData(NAMESPACE, "visual_confidence", ir.visualConfidence);
  return node;
}

async function renderIrNodeInner(ir, fonts, context = {}) {
  if (ir.visualMode === "snapshot-fallback" && ir.fallbackAssetId && context.pairingCode) {
    const response = await fetch(`${BRIDGE_URL}/v1/jobs/${context.pairingCode}/assets/${encodeURIComponent(ir.fallbackAssetId)}.png`);
    if (!response.ok) throw new Error(`Could not load the ${ir.name || ir.type} visual fallback from UI Sync.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const image = figma.createImage(bytes);
    const fallback = figma.createRectangle();
    fallback.name = `${ir.name || "Native content"} · Visual fallback`;
    fallback.resize(Math.max(1, ir.runtimeFrame?.width || ir.width || 1), Math.max(1, ir.runtimeFrame?.height || ir.height || 1));
    fallback.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
    fallback.setSharedPluginData(NAMESPACE, "visual_fallback", "1");
    return fallback;
  }
  if (ir.type === "text") {
    const text = createTextNode(ir.text, fonts, {
      size: ir.fontSize || fontSize(ir.fontStyle),
      weight: ir.fontWeight || (ir.fontStyle === "headline" ? "semibold" : "regular"),
      color: colorForToken(ir.colorToken, COLORS.text),
      opacity: ir.colorOpacity,
      tracking: ir.tracking,
      lineSpacing: ir.lineSpacing,
      alignment: ir.textAlignment
    });
    markSwiftNode(text, ir, "/text");
    return wrapLeaf(text, ir, "Text container", context);
  }
  if (ir.type === "divider") {
    const divider = figma.createRectangle();
    divider.name = "Divider";
    divider.resize(200, 1);
    divider.fills = solid(COLORS.separator, 0.7);
    return divider;
  }
  if (ir.type === "spacer") {
    const spacer = figma.createFrame();
    spacer.name = "Spacer";
    spacer.resize(1, ir.minLength ?? 0.5);
    spacer.fills = [];
    spacer.setPluginData("ui_sync_role", "spacer");
    return spacer;
  }
  if (ir.type === "symbol") {
    const symbol = createSymbolNode(ir.symbol || "questionmark", fonts, {
      size: ir.fontSize || 17,
      weight: ir.fontWeight,
      color: colorForToken(ir.colorToken, COLORS.accent),
      opacity: ir.colorOpacity
    });
    return wrapLeaf(symbol, ir, "Symbol container", context);
  }
  if (ir.type === "shape") {
    const shape = ir.name === "Circle" ? figma.createEllipse() : figma.createRectangle();
    shape.name = ir.name || "Shape";
    const fillsOverlay = context.overlay && !ir.width && !ir.height && ["LinearGradient", "Rectangle"].includes(ir.name);
    shape.resize(ir.width || (fillsOverlay ? context.width : ir.name === "Circle" ? 180 : 240), ir.height || (fillsOverlay ? context.height : ir.name === "Circle" ? 180 : 120));
    shape.fills = ir.name === "LinearGradient"
      ? [{
          type: "GRADIENT_LINEAR",
          gradientTransform: [[1, 0, 0], [0, 1, 0]],
          gradientStops: [
            { position: 0, color: { ...COLORS.background, a: 1 } },
            { position: 1, color: { ...COLORS.accentSoft, a: 1 } }
          ]
        }]
      : ir.borderColorToken && !ir.colorToken ? [] : solid(colorForToken(ir.colorToken, COLORS.accentSoft), ir.colorToken === "clear" ? 0 : (ir.colorOpacity ?? 1));
    if (ir.borderColorToken) {
      shape.strokes = solid(colorForToken(ir.borderColorToken, COLORS.separator), ir.borderOpacity ?? 1);
      shape.strokeWeight = ir.borderWidth || 1;
    }
    if (ir.name === "Capsule" && "cornerRadius" in shape) shape.cornerRadius = Math.min(shape.width, shape.height) / 2;
    if (ir.name === "RoundedRectangle" && "cornerRadius" in shape) shape.cornerRadius = ir.cornerRadius || 12;
    applyNodeStyle(shape, ir);
    if (!ir.symbol && !ir.children?.length) return shape;
    const composite = figma.createFrame();
    composite.name = `${ir.name || "Shape"} with symbol`;
    composite.layoutMode = "NONE";
    composite.resize(shape.width, shape.height);
    composite.fills = [];
    composite.appendChild(shape);
    shape.x = 0;
    shape.y = 0;
    const overlays = [];
    if (ir.children?.length) {
      for (const childIr of ir.children) overlays.push(await renderIrNode(childIr, fonts, { width: composite.width, height: composite.height, overlay: true, pairingCode: context.pairingCode }));
    } else if (ir.symbol) {
      overlays.push(createSymbolNode(ir.symbol, fonts, { size: ir.fontSize || 30, weight: ir.fontWeight, color: colorForToken(ir.colorToken, COLORS.text) }));
    }
    for (const overlayNode of overlays) {
      composite.appendChild(overlayNode);
      overlayNode.x = (composite.width - overlayNode.width) / 2;
      overlayNode.y = (composite.height - overlayNode.height) / 2;
    }
    composite.effects = shape.effects;
    shape.effects = [];
    composite.opacity = shape.opacity;
    shape.opacity = 1;
    return composite;
  }
  if (ir.type === "progress") {
    const progress = figma.createEllipse();
    progress.name = "Progress";
    progress.resize(24, 24);
    progress.fills = [];
    progress.strokes = solid(COLORS.accent);
    progress.strokeWeight = 3;
    progress.arcData = { startingAngle: 0, endingAngle: Math.PI * 1.5, innerRadius: 0.72 };
    return progress;
  }
  if (ir.type === "label") {
    const row = createLayout("Label", "HORIZONTAL");
    row.itemSpacing = 12;
    row.counterAxisAlignItems = "CENTER";
    if (ir.symbol) {
      row.appendChild(createSymbolNode(ir.symbol, fonts, { size: ir.fontSize || 17, color: colorForToken(ir.colorToken, COLORS.accent), opacity: ir.colorOpacity }));
    }
    const labelText = createTextNode(ir.text || "Label", fonts, { size: ir.fontSize || 17, weight: ir.fontWeight, color: colorForToken(ir.colorToken, COLORS.text), opacity: ir.colorOpacity, tracking: ir.tracking });
    markSwiftNode(labelText, ir, "/text");
    row.appendChild(labelText);
    applyNodeStyle(row, ir);
    return row;
  }
  if (ir.type === "button") {
    const systemButton = await createMarkedAppleButton(ir, context);
    if (systemButton) return systemButton;
    const button = createLayout("Button", "HORIZONTAL");
    button.counterAxisAlignItems = "CENTER";
    button.primaryAxisAlignItems = "CENTER";
    if (ir.children?.length) {
      for (const childIr of ir.children) {
        const child = await renderIrNode(childIr, fonts, context);
        button.appendChild(child);
        applyRuntimeChildGeometry(button, child, ir, childIr);
        appendRuntimeInstanceClones(button, child, ir, childIr);
      }
    } else {
      const buttonText = createTextNode(ir.text || "Button", fonts, {
        size: ir.fontSize || 15,
        weight: ir.fontWeight || "semibold",
        color: colorForToken(ir.colorToken, COLORS.accent),
        tracking: ir.tracking
      });
      markSwiftNode(buttonText, ir, "/text");
      button.appendChild(buttonText);
    }
    applyNodeStyle(button, ir);
    return button;
  }
  if (ir.type === "field") {
    const field = createLayout(ir.name || "Text field", "HORIZONTAL");
    field.paddingTop = 12;
    field.paddingRight = 14;
    field.paddingBottom = 12;
    field.paddingLeft = 14;
    field.cornerRadius = ir.cornerRadius || 12;
    field.fills = solid(colorForToken(ir.backgroundColorToken, COLORS.surface));
    const fieldText = createTextNode(ir.text || "Text field", fonts, {
      size: ir.fontSize || 15,
      weight: ir.fontWeight || "regular",
      color: colorForToken(ir.colorToken, COLORS.secondaryText)
    });
    markSwiftNode(fieldText, ir, "/text");
    field.appendChild(fieldText);
    field.resize(ir.width || context.width || 320, ir.height || 48);
    field.primaryAxisSizingMode = "FIXED";
    applyNodeStyle(field, ir);
    return field;
  }
  if (ir.type === "toggle") {
    const row = createLayout("Toggle", "HORIZONTAL");
    row.paddingTop = 11;
    row.paddingRight = 14;
    row.paddingBottom = 11;
    row.paddingLeft = 14;
    row.counterAxisAlignItems = "CENTER";
    row.primaryAxisAlignItems = "SPACE_BETWEEN";
    row.fills = solid(COLORS.surface);
    row.resize(361, row.height);
    row.primaryAxisSizingMode = "FIXED";
    const label = createTextNode(ir.text || "Toggle", fonts);
    markSwiftNode(label, ir, "/text");
    row.appendChild(label);
    const control = figma.createFrame();
    control.name = "Toggle control";
    control.resize(51, 31);
    control.cornerRadius = 16;
    control.fills = solid(COLORS.separator);
    const knob = figma.createEllipse();
    knob.resize(27, 27);
    knob.x = 2;
    knob.y = 2;
    knob.fills = solid(COLORS.surface);
    control.appendChild(knob);
    row.appendChild(control);
    applyNodeStyle(row, ir);
    return row;
  }

  if (ir.type === "zstack") {
    const overlay = figma.createFrame();
    overlay.name = "ZStack";
    overlay.layoutMode = "NONE";
    overlay.clipsContent = false;
    overlay.fills = [];
    const renderedChildren = [];
    for (const childIr of ir.children || []) {
      const child = await renderIrNode(childIr, fonts, { width: ir.width || context.width, height: ir.height || context.height, overlay: true, pairingCode: context.pairingCode, colorScheme: ir.runtimeEnvironment?.colorScheme || context.colorScheme });
      renderedChildren.push({ child, childIr });
    }
    const usesProposedWidth = ir.fillWidth || context.isScreenRoot || renderedChildren.some(({ childIr }) => requiresProposedWidth(childIr));
    const overlayWidth = ir.width || (usesProposedWidth ? context.width : null) || Math.max(1, ...renderedChildren.map(({ child }) => child.width));
    const overlayHeight = ir.height || (ir.fillHeight || context.isScreenRoot ? context.height : null) || Math.max(1, ...renderedChildren.map(({ child }) => child.height));
    overlay.resize(overlayWidth, overlayHeight);
    for (const { child, childIr } of renderedChildren) {
      overlay.appendChild(child);
      if (applyRuntimeChildGeometry(overlay, child, ir, childIr)) {
        appendRuntimeInstanceClones(overlay, child, ir, childIr);
        continue;
      }
      if (requiresProposedWidth(childIr) && "resize" in child) fixFrameSize(child, overlayWidth, null);
      if (childIr.fillHeight && "resize" in child) fixFrameSize(child, null, overlayHeight);
      const alignment = childIr.alignment || ir.alignment || "center";
      child.x = (["leading", "topLeading", "bottomLeading"].includes(alignment) ? 0 : ["trailing", "topTrailing", "bottomTrailing"].includes(alignment) ? overlayWidth - child.width : (overlayWidth - child.width) / 2) + (childIr.offsetX || 0);
      child.y = (["top", "topLeading", "topTrailing"].includes(alignment) ? 0 : ["bottom", "bottomLeading", "bottomTrailing"].includes(alignment) ? overlayHeight - child.height : (overlayHeight - child.height) / 2) + (childIr.offsetY || 0);
    }
    applyNodeStyle(overlay, ir);
    return overlay;
  }

  if (ir.type === "tabview") {
    const tabs = createLayout("Tab View", "VERTICAL");
    const width = ir.width || context.width || 393;
    const height = ir.height || context.height || 852;
    tabs.resize(width, height);
    tabs.primaryAxisSizingMode = "FIXED";
    tabs.counterAxisSizingMode = "FIXED";
    const selected = ir.children?.[0];
    if (selected) {
      const contentHeight = Math.max(1, height - 83);
      const safeContent = createLayout("Safe area content", "VERTICAL");
      fixFrameSize(safeContent, width, contentHeight);
      safeContent.paddingTop = 59;
      safeContent.fills = [];
      const content = await renderIrNode(selected, fonts, { width, height: Math.max(1, contentHeight - 59), isScreenRoot: true, pairingCode: context.pairingCode });
      append(safeContent, content);
      content.layoutSizingVertical = "FILL";
      tabs.appendChild(safeContent);
    }
    const tabBar = createLayout("Tab Bar", "HORIZONTAL");
    tabBar.resize(width, 83);
    tabBar.primaryAxisSizingMode = "FIXED";
    tabBar.counterAxisSizingMode = "FIXED";
    tabBar.primaryAxisAlignItems = "SPACE_BETWEEN";
    tabBar.counterAxisAlignItems = "MIN";
    tabBar.paddingTop = 9;
    tabBar.paddingRight = 64;
    tabBar.paddingBottom = 21;
    tabBar.paddingLeft = 64;
    tabBar.fills = solid(colorForToken(ir.backgroundColorToken, COLORS.surface), 0.96);
    for (const tab of ir.children || []) {
      const item = createLayout(tab.tabTitle || tab.name || "Tab", "VERTICAL");
      item.itemSpacing = 3;
      item.counterAxisAlignItems = "CENTER";
      const selectedTab = tab === selected;
      item.appendChild(createSymbolNode(tab.tabSymbol || "circle", fonts, { size: 19, color: selectedTab ? COLORS.accent : COLORS.secondaryText }));
      item.appendChild(createTextNode(tab.tabTitle || String(tab.name || "Tab").replace(/View$/, ""), fonts, { size: 10, weight: "medium", color: selectedTab ? COLORS.accent : COLORS.secondaryText }));
      tabBar.appendChild(item);
    }
    tabs.appendChild(tabBar);
    applyNodeStyle(tabs, ir);
    return tabs;
  }

  const direction = ir.type === "hstack" || (ir.type === "scroll" && ir.direction === "horizontal") ? "HORIZONTAL" : "VERTICAL";
  const container = createLayout(ir.type === "custom" ? ir.name || "Custom view" : ir.type, direction);
  container.itemSpacing = ir.spacing ?? (["list", "section"].includes(ir.type) ? 0 : 12);
  container.counterAxisAlignItems = alignmentForStack(ir, direction);
  if (["list", "section"].includes(ir.type)) {
    container.fills = solid(COLORS.background);
    container.paddingTop = 12;
    container.paddingRight = 16;
    container.paddingBottom = 12;
    container.paddingLeft = 16;
  }
  if (ir.type === "custom" && (!ir.children || ir.children.length === 0)) {
    container.resize(1, 1);
    container.primaryAxisSizingMode = "FIXED";
    container.counterAxisSizingMode = "FIXED";
  }
  if (ir.title && ir.type !== "navigation") {
    container.appendChild(createTextNode(ir.title, fonts, { size: 13, weight: "semibold", color: COLORS.secondaryText, name: "Section title" }));
  }
  const proposedWidth = ir.width || context.width || 361;
  const childWidth = Math.max(1, proposedWidth - (ir.padding?.left || 0) - (ir.padding?.right || 0));
  for (const childIr of ir.children || []) {
    const child = await renderIrNode(childIr, fonts, { width: childWidth, pairingCode: context.pairingCode, colorScheme: ir.runtimeEnvironment?.colorScheme || context.colorScheme });
    append(container, child, shouldFillChild(direction, childIr) ? "FILL" : "HUG");
    applyRuntimeChildGeometry(container, child, ir, childIr);
    appendRuntimeInstanceClones(container, child, ir, childIr);
    if (childIr.type === "spacer") child.layoutGrow = 1;
  }
  applyNodeStyle(container, ir);
  const runtimeGeometry = hasRuntimeGeometry(ir);
  if (!runtimeGeometry && (ir.fillWidth || context.isScreenRoot || (direction === "HORIZONTAL" && (ir.children || []).some((child) => child.type === "spacer"))) && context.width) {
    fixFrameSize(container, context.width, null);
  }
  if (!runtimeGeometry && (ir.fillHeight || context.isScreenRoot) && context.height) fixFrameSize(container, null, context.height);
  if (runtimeGeometry) return container;
  if (direction === "VERTICAL") {
    for (const child of container.children) {
      if (child.width > childWidth) constrainNodeWidth(child, childWidth);
    }
  } else if (container.primaryAxisSizingMode === "FIXED") {
    const children = [...container.children];
    const available = Math.max(1, container.width - container.paddingLeft - container.paddingRight - Math.max(0, children.length - 1) * container.itemSpacing);
    let overflow = children.reduce((sum, child) => sum + child.width, 0) - available;
    if (overflow > 0) {
      for (const child of children) {
        if (child.name === "Spacer" || child.width <= 44) continue;
        const reduction = Math.min(overflow, child.width - 44);
        constrainNodeWidth(child, child.width - reduction);
        overflow -= reduction;
        if (overflow <= 0) break;
      }
    }
  }
  return container;
}

async function renderIrNode(ir, fonts, context = {}) {
  return markSwiftNode(await renderIrNodeInner(ir, fonts, context), ir);
}

async function renderSnapshotContent(frame, screen, pairingCode, managed) {
  const response = await fetch(`${BRIDGE_URL}/v1/jobs/${pairingCode}/assets/${encodeURIComponent(screen.id)}.png`);
  if (!response.ok) throw new Error(`Could not load the ${screen.name} snapshot from UI Sync.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const image = figma.createImage(bytes);
  const snapshot = figma.createRectangle();
  snapshot.name = "UI Sync · Rendered snapshot";
  snapshot.resize(screen.width, screen.height);
  snapshot.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
  snapshot.setSharedPluginData(NAMESPACE, CONTENT_ROOT_KEY, "1");
  if (managed) managed.remove();
  frame.layoutMode = "NONE";
  frame.resize(screen.width, screen.height);
  frame.appendChild(snapshot);
  snapshot.x = 0;
  snapshot.y = 0;
  return "rendered";
}

/** @param {string} value @returns {SolidPaint[]} */
function cssPaint(value) {
  const match = String(value || "").match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i);
  if (!match) return [];
  const opacity = match[4] === undefined ? 1 : Number(match[4]);
  if (opacity <= 0) return [];
  return [{
    type: "SOLID",
    color: { r: Number(match[1]) / 255, g: Number(match[2]) / 255, b: Number(match[3]) / 255 },
    opacity
  }];
}

function domFont(fonts, weight) {
  if (weight >= 800) return fonts.heavy;
  if (weight >= 700) return fonts.bold;
  if (weight >= 600) return fonts.semibold;
  if (weight >= 500) return fonts.medium;
  return fonts.regular;
}

function positionDomNode(node, ir) {
  node.x = ir.x;
  node.y = ir.y;
  node.name = ir.name;
  node.setSharedPluginData(NAMESPACE, DOM_ID_KEY, ir.id);
  node.setSharedPluginData(NAMESPACE, DOM_SELECTOR_KEY, ir.selector || "");
  node.setSharedPluginData(NAMESPACE, DOM_KIND_KEY, ir.kind);
  return node;
}

function applyMeasuredTextSizing(text, measurement, { preserveBounds = false } = {}) {
  const lineCount = measurement.lineCount || (String(text.characters || "").includes("\n") ? 2 : 1);
  const singleLine = measurement.wrapMode === "nowrap" || lineCount === 1;
  if (preserveBounds) {
    text.textAutoResize = "NONE";
    text.resize(Math.max(1, measurement.width), Math.max(1, measurement.height));
  } else if (singleLine) {
    text.textAutoResize = "WIDTH_AND_HEIGHT";
  } else {
    text.textAutoResize = "HEIGHT";
    text.resize(Math.max(1, measurement.layoutWidth || measurement.width), Math.max(1, measurement.height));
  }
  return { lineCount, singleLine };
}

function insertMeasuredLineBreaks(value, offsets) {
  let result = String(value || "");
  for (const offset of [...(offsets || [])].sort((left, right) => right - left)) {
    if (offset > 0 && offset < result.length && result[offset - 1] !== "\n" && result[offset] !== "\n") {
      result = `${result.slice(0, offset)}\n${result.slice(offset)}`;
    }
  }
  return result;
}

function measuredTextContainer(ir, text) {
  const container = figma.createFrame();
  container.name = `${ir.name} · Browser bounds`;
  container.layoutMode = "NONE";
  container.resize(Math.max(1, ir.layoutWidth || ir.width), Math.max(1, ir.height));
  container.fills = [];
  container.clipsContent = false;
  positionDomNode(container, { ...ir, x: ir.layoutX ?? ir.x });
  container.setSharedPluginData(NAMESPACE, "text_container", "1");
  // Only when the breaks were actually applied. Where the capture could not
  // render the page's font, its line breaks describe a fallback and Figma —
  // which very likely does have the font — lays the run out itself.
  if (ir.wrapMode === "wrap" && ir.lineBreakOffsets?.length && !ir.style.unavailableFonts?.length) {
    container.setSharedPluginData(NAMESPACE, DOM_SYNTHETIC_WRAP_KEY, "1");
  }
  container.appendChild(text);
  const { singleLine } = applyMeasuredTextSizing(text, ir);
  const alignment = ir.style.textAlign;
  text.x = alignment === "right"
    ? Math.max(0, container.width - text.width)
    : alignment === "center"
      ? Math.max(0, (container.width - text.width) / 2)
      : 0;
  text.y = singleLine ? (container.height - text.height) / 2 : 0;
  return container;
}

async function renderDomNode(ir, fonts) {
  if (ir.kind === "text") {
    const text = figma.createText();
    text.fontName = await resolveMeasuredFont(fonts, ir.style, ir.text);
    text.name = `${ir.name} · Content`;
    // The width a wrapping block gets is CSS, so it survives a font
    // substitution; where the lines fall does not. Handing Figma the fallback's
    // break positions would bake a wrong wrap into a font it can set correctly.
    text.characters = ir.wrapMode === "wrap" && !ir.style.unavailableFonts?.length
      ? insertMeasuredLineBreaks(ir.text, ir.lineBreakOffsets)
      : ir.text;
    text.fontSize = ir.style.fontSize;
    text.lineHeight = { unit: "PIXELS", value: ir.style.lineHeight };
    text.letterSpacing = { unit: "PIXELS", value: ir.style.letterSpacing };
    text.textAlignHorizontal = ir.style.textAlign === "justify" ? "JUSTIFIED" : ir.style.textAlign.toUpperCase();
    text.fills = cssPaint(ir.style.color);
    return measuredTextContainer(ir, text);
  }
  if (ir.kind === "svg") {
    const vector = figma.createNodeFromSvg(ir.svg);
    vector.resize(ir.width, ir.height);
    return positionDomNode(vector, ir);
  }
  if (ir.kind === "image") {
    const encoded = ir.dataUrl.slice(ir.dataUrl.indexOf(",") + 1);
    const image = figma.createImage(figma.base64Decode(encoded));
    const rectangle = figma.createRectangle();
    rectangle.resize(ir.width, ir.height);
    rectangle.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
    return positionDomNode(rectangle, ir);
  }

  const container = figma.createFrame();
  container.layoutMode = "NONE";
  container.resize(ir.width, ir.height);
  container.fills = cssPaint(ir.style.backgroundColor);
  container.cornerRadius = Math.min(ir.style.borderRadius, Math.min(ir.width, ir.height) / 2);
  container.opacity = ir.style.opacity;
  container.clipsContent = ir.style.clipsContent;
  const borders = [
    [ir.style.borderTopWidth, ir.style.borderTopColor],
    [ir.style.borderRightWidth, ir.style.borderRightColor],
    [ir.style.borderBottomWidth, ir.style.borderBottomColor],
    [ir.style.borderLeftWidth, ir.style.borderLeftColor]
  ];
  const border = borders.find(([width]) => width > 0);
  if (border) {
    container.strokes = cssPaint(border[1]);
    container.strokeTopWeight = ir.style.borderTopWidth;
    container.strokeRightWeight = ir.style.borderRightWidth;
    container.strokeBottomWeight = ir.style.borderBottomWidth;
    container.strokeLeftWeight = ir.style.borderLeftWidth;
    container.strokeAlign = "INSIDE";
  }
  for (const childIr of ir.children) {
    const child = await renderDomNode(childIr, fonts);
    container.appendChild(child);
    child.x = childIr.kind === "text" ? childIr.layoutX ?? childIr.x : childIr.x;
    child.y = childIr.y;
  }
  return positionDomNode(container, ir);
}

async function renderEditableDomContent(frame, screen, getFonts, managed) {
  const fonts = await getFonts();
  const root = await renderDomNode(screen.domTree, fonts);
  root.name = "UI Sync · Editable DOM";
  root.setSharedPluginData(NAMESPACE, CONTENT_ROOT_KEY, "1");
  if (managed) managed.remove();
  frame.layoutMode = "NONE";
  frame.resize(screen.width, screen.height);
  frame.appendChild(root);
  root.x = 0;
  root.y = 0;
  return "rendered";
}

function runtimeTextRuns(ir, result = []) {
  const children = ir.children || [];
  const childHasText = children.some((child) => typeof child.text === "string" && child.text.length > 0);
  const isTextual = ["text", "label", "button", "field", "toggle"].includes(ir.type);
  if (isTextual && ir.runtimeTextCaptured === true && !childHasText && typeof ir.text === "string" && ir.text.length > 0 && ir.runtimeFrame) result.push(ir);
  for (const child of children) runtimeTextRuns(child, result);
  return result;
}

function createRuntimeTextLayer(ir, frame, fonts, suffix = "") {
  const size = ir.fontSize || fontSize(ir.fontStyle);
  const weight = ir.fontWeight || (ir.fontStyle === "headline" ? "semibold" : "regular");
  const text = createTextNode(ir.text, fonts, {
    size,
    weight,
    color: colorForToken(ir.colorToken, COLORS.text),
    opacity: (ir.opacity ?? 1) * (ir.colorOpacity ?? 1),
    tracking: ir.tracking,
    lineSpacing: ir.lineSpacing,
    alignment: ir.textAlignment,
    name: ir.name || "Editable Text"
  });
  applyMeasuredTextSizing(text, {
    width: frame.width,
    height: frame.height,
    lineCount: ir.text.includes("\n") ? ir.text.split("\n").length : 1,
    wrapMode: ir.text.includes("\n") ? "explicit" : "nowrap"
  }, { preserveBounds: true });
  text.textAlignVertical = ir.text.includes("\n") ? "TOP" : "CENTER";
  text.x = frame.x;
  text.y = frame.y;
  markSwiftNode(text, ir, suffix);
  text.setSharedPluginData(NAMESPACE, "rendered_text", "1");
  return text;
}

function createPdfTextLayer(run, fonts, index, pageWidth = null) {
  const text = createTextNode(run.text, fonts, {
    size: run.fontSize,
    weight: run.fontWeight,
    color: run.color,
    name: `Editable PDF Text ${index + 1}`
  });
  // Poppler reports the visual glyph bounds from the embedded PDF font. The
  // locally available editable font can be wider (notably PingFang), which
  // makes a correct one-line SwiftUI label wrap inside that exact PDF box.
  // Preserve the PDF's visual width by tightening tracking before freezing the
  // editable text box instead of widening the layout and moving nearby nodes.
  const characterCount = [...String(text.characters || "")].length;
  const naturalWidth = Number(text.width || 0);
  if (characterCount > 1 && naturalWidth > run.width + 0.5) {
    const fittedTracking = (run.width - naturalWidth) / (characterCount - 1);
    if (fittedTracking >= -run.fontSize * 0.4) {
      text.letterSpacing = { unit: "PIXELS", value: fittedTracking };
      text.setSharedPluginData(NAMESPACE, "pdf_width_calibration", String(fittedTracking));
    }
  }
  // Figma decides wrapping from the uncalibrated font advances in some CJK
  // fonts. Give the layout box the natural editable-font width while keeping
  // the calibrated glyphs centered on the original PDF bounds.
  const layoutWidth = naturalWidth > run.width + 0.5 ? naturalWidth + 1 : run.width;
  const runCenter = run.x + run.width / 2;
  const centeredOnPage = Number(pageWidth) > 0 && Math.abs(runCenter - pageWidth / 2) <= Math.max(4, run.fontSize);
  applyMeasuredTextSizing(text, { width: layoutWidth, height: run.height, lineCount: 1, wrapMode: "nowrap" }, { preserveBounds: true });
  text.textAlignVertical = "CENTER";
  text.textAlignHorizontal = centeredOnPage ? "CENTER" : "LEFT";
  text.x = centeredOnPage ? runCenter - layoutWidth / 2 : run.x;
  text.y = run.y;
  text.setSharedPluginData(NAMESPACE, "pdf_visual_bounds", JSON.stringify({ x: run.x, y: run.y, width: run.width, height: run.height }));
  text.setSharedPluginData(NAMESPACE, "pdf_text", "1");
  return text;
}

function createSvgVectorWithNativeShadows(screen) {
  const vector = figma.createNodeFromSvg(screen.vectorSvg);
  const plans = screen.vectorNativeShadows || [];
  if (plans.length === 0) return vector;

  const descendants = [vector, ...vector.findAll(() => true)];
  const targets = new Map();
  for (const plan of plans) {
    const target = descendants.find((node) => node.name === plan.marker);
    if (!target || !("effects" in target)) {
      vector.remove();
      return figma.createNodeFromSvg(screen.vectorFallbackSvg || screen.vectorSvg);
    }
    if (!targets.has(target)) targets.set(target, []);
    targets.get(target).push({
      type: "DROP_SHADOW",
      color: plan.color,
      offset: plan.offset,
      radius: plan.radius,
      spread: plan.spread,
      visible: true,
      blendMode: "NORMAL"
    });
  }

  for (const [target, effects] of targets) {
    target.effects = [...(target.effects || []), ...effects];
    target.setSharedPluginData(NAMESPACE, "native_svg_shadow", "1");
  }
  vector.setSharedPluginData(NAMESPACE, "native_svg_shadow_count", String(plans.length));
  return vector;
}

function boundsRelativeToVector(node, vector) {
  const bounds = node.absoluteBoundingBox;
  const vectorBounds = vector.absoluteBoundingBox;
  if (bounds && vectorBounds) {
    return {
      x: bounds.x - vectorBounds.x,
      y: bounds.y - vectorBounds.y,
      width: bounds.width,
      height: bounds.height
    };
  }
  let x = Number(node.x || 0);
  let y = Number(node.y || 0);
  let parent = node.parent;
  while (parent && parent !== vector) {
    x += Number(parent.x || 0);
    y += Number(parent.y || 0);
    parent = parent.parent;
  }
  return { x, y, width: Number(node.width || 0), height: Number(node.height || 0) };
}

function semanticEffectTargetScore(bounds, frame, descendantCount) {
  const frameRight = frame.x + frame.width;
  const frameBottom = frame.y + frame.height;
  const boundsRight = bounds.x + bounds.width;
  const boundsBottom = bounds.y + bounds.height;
  const edgeDistance = (
    Math.abs(bounds.x - frame.x)
    + Math.abs(bounds.y - frame.y)
    + Math.abs(boundsRight - frameRight)
    + Math.abs(boundsBottom - frameBottom)
  ) / Math.max(1, frame.width + frame.height);
  const sizeDistance = Math.abs(bounds.width - frame.width) / Math.max(1, frame.width)
    + Math.abs(bounds.height - frame.height) / Math.max(1, frame.height);
  const centerDistance = Math.abs(bounds.x + bounds.width / 2 - frame.x - frame.width / 2) / Math.max(1, frame.width)
    + Math.abs(bounds.y + bounds.height / 2 - frame.y - frame.height / 2) / Math.max(1, frame.height);
  return edgeDistance + sizeDistance * 0.35 + centerDistance * 0.15 + Math.min(0.08, descendantCount * 0.004);
}

function findSemanticEffectTarget(vector, effect, sourceNodes, suppressedNodes = new Set()) {
  const frame = effect.frame;
  let best = null;
  for (const node of sourceNodes) {
    if (suppressedNodes.has(node) || node.removed === true || node.isMask === true || node.visible === false || !("effects" in node)) continue;
    const bounds = boundsRelativeToVector(node, vector);
    if (bounds.width <= 0 || bounds.height <= 0) continue;
    const descendantCount = "findAll" in node ? node.findAll(() => true).length : 0;
    const score = semanticEffectTargetScore(bounds, frame, descendantCount);
    if (!best || score < best.score) best = { node, score };
  }
  const maximumScore = effect.type === "LAYER_BLUR" ? 0.2 : 0.65;
  return best && best.score <= maximumScore ? best.node : null;
}

function isFullPageHairlineBlur(effect, vector) {
  if (effect.type !== "LAYER_BLUR" || effect.radius < 4) return false;
  const thinSide = Math.min(effect.frame.width, effect.frame.height);
  const longSide = Math.max(effect.frame.width, effect.frame.height);
  const pageLongSide = Math.max(Number(vector.width || 0), Number(vector.height || 0));
  return thinSide <= 1.5 && pageLongSide > 0 && longSide >= pageLongSide * 0.75;
}

function applySemanticVectorEffects(vector, screen) {
  const effects = [...(screen.vectorEffects || [])]
    .sort((left, right) => left.frame.width * left.frame.height - right.frame.width * right.frame.height);
  if (effects.length === 0) return true;
  // Freeze the imported SVG tree before applying anything. Native effect nodes created
  // during this pass must never become candidates for a later, larger effect.
  const sourceNodes = vector.findAll(() => true);
  const suppressedNodes = new Set();
  let appliedEffectCount = 0;
  for (const effect of effects) {
    const target = findSemanticEffectTarget(vector, effect, sourceNodes, suppressedNodes);
    if (!target) return false;
    // SwiftUI can use a blurred 1pt full-height gradient as imperceptible
    // ambient lighting. Its clean-PDF geometry is a literal hairline and
    // Figma's native Layer Blur exaggerates it into a visible vertical band.
    // The original PDF already contributes the surrounding ambient color, so
    // omit this degenerate reconstruction instead of introducing an artifact.
    if (isFullPageHairlineBlur(effect, vector)) {
      suppressedNodes.add(target);
      target.remove();
      continue;
    }
    target.name = `${effect.type === "DROP_SHADOW" ? "Native Shadow" : "Native Blur"} · ${effect.syncId}`;
    /** @type {Effect} */
    const nativeEffect = effect.type === "DROP_SHADOW"
      ? {
        type: "DROP_SHADOW",
        color: { ...colorForToken(effect.colorToken, { r: 0, g: 0, b: 0 }), a: effect.opacity ?? 0.33 },
        offset: effect.offset || { x: 0, y: 0 },
        radius: effect.radius,
        spread: 0,
        visible: true,
        blendMode: "NORMAL"
      }
      : {
        type: "LAYER_BLUR",
        blurType: "NORMAL",
        radius: effect.radius,
        visible: true
      };
    target.effects = [...(target.effects || []), nativeEffect];
    target.setSharedPluginData(NAMESPACE, "native_swift_effect", effect.id);
    appliedEffectCount += 1;
  }
  vector.setSharedPluginData(NAMESPACE, "native_swift_effect_count", String(appliedEffectCount));
  return true;
}

async function renderHybridSwiftContent(frame, screen, fonts, managed) {
  const viewport = vectorViewport(screen);
  if (!viewport) throw new Error(`Could not read the ${screen.name} PDF page size.`);
  frame.layoutMode = "NONE";
  frame.resize(viewport.width, viewport.height);
  frame.fills = [];

  const root = figma.createFrame();
  root.name = screen.vectorTextMode === "pdf-glyphs"
    ? "UI Sync · Rendered SwiftUI PDF"
    : screen.vectorTextMode === "editable-pdf"
      ? "UI Sync · SwiftUI PDF + Editable Text"
      : screen.vectorTextMode === "editable-runtime"
        ? "UI Sync · SwiftUI PDF + Captured Runtime Text"
        : "UI Sync · Rendered Vector + Editable Text";
  root.layoutMode = "NONE";
  root.resize(viewport.width, viewport.height);
  root.fills = [];
  root.clipsContent = true;
  root.setSharedPluginData(NAMESPACE, CONTENT_ROOT_KEY, "1");
  root.setSharedPluginData(NAMESPACE, "swift_runtime_layout", "3");
  frame.setSharedPluginData(NAMESPACE, "swift_runtime_layout", "3");

  let vector = createSvgVectorWithNativeShadows(screen);
  vector.name = "Rendered Vector · SwiftUI";
  vector.resize(viewport.width, viewport.height);
  vector.setSharedPluginData(NAMESPACE, "rendered_vector", "1");
  root.appendChild(vector);
  vector.x = 0;
  vector.y = 0;
  if (!applySemanticVectorEffects(vector, screen) && screen.vectorFallbackSvg) {
    vector.remove();
    vector = figma.createNodeFromSvg(screen.vectorFallbackSvg);
    vector.name = "Rendered Vector · SwiftUI · Visual fallback";
    vector.resize(viewport.width, viewport.height);
    vector.setSharedPluginData(NAMESPACE, "rendered_vector", "1");
    vector.setSharedPluginData(NAMESPACE, "native_swift_effect_fallback", "1");
    root.appendChild(vector);
    vector.x = 0;
    vector.y = 0;
  }

  if (screen.vectorTextMode !== "pdf-glyphs") {
    const textGroup = figma.createFrame();
    textGroup.name = "Editable Text";
    textGroup.layoutMode = "NONE";
    textGroup.resize(viewport.width, viewport.height);
    textGroup.fills = [];
    textGroup.clipsContent = false;
    root.appendChild(textGroup);
    textGroup.x = 0;
    textGroup.y = 0;

    if (screen.vectorTextMode === "editable-pdf") {
      for (const [index, run] of (screen.vectorTextRuns || []).entries()) {
        textGroup.appendChild(createPdfTextLayer(run, fonts, index, viewport.width));
      }
    } else {
      for (const ir of runtimeTextRuns(screen.uiTree)) {
        const instances = ir.runtimeInstances?.length ? ir.runtimeInstances : [{ ...ir.runtimeFrame, instanceId: "single" }];
        for (const instance of instances) {
          const text = createRuntimeTextLayer(ir, instance, fonts, instance.instanceId === "single" ? "/text" : `/text/${instance.instanceId}`);
          textGroup.appendChild(text);
        }
      }
    }
  }

  const systemTabBar = await createSystemTabBar(
    screen,
    fonts,
    viewport.width,
    frame.parent?.type === "PAGE" ? frame.parent : figma.currentPage
  );
  if (systemTabBar) {
    root.appendChild(systemTabBar);
    systemTabBar.x = 0;
    systemTabBar.y = viewport.height - systemTabBar.height;
  }

  if (managed) managed.remove();
  frame.appendChild(root);
  root.x = 0;
  root.y = 0;
  return "rendered";
}

function vectorViewport(screen) {
  const runtimeViewport = screen.uiTree.runtimeEnvironment?.viewport;
  if (runtimeViewport?.width > 0 && runtimeViewport?.height > 0) return runtimeViewport;
  const svgTag = String(screen.vectorSvg || "").match(/<svg\b[^>]*>/i)?.[0] || "";
  const width = Number(svgTag.match(/\bwidth=["']([\d.]+)(?:pt)?["']/i)?.[1]);
  const height = Number(svgTag.match(/\bheight=["']([\d.]+)(?:pt)?["']/i)?.[1]);
  if (width > 0 && height > 0) return { x: 0, y: 0, width, height };
  const viewBox = svgTag.match(/\bviewBox=["']\s*([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)[, ]+([\d.e+-]+)\s*["']/i)?.slice(1).map(Number);
  if (viewBox && viewBox.every(Number.isFinite) && viewBox[2] > 0 && viewBox[3] > 0) {
    return { x: viewBox[0], y: viewBox[1], width: viewBox[2], height: viewBox[3] };
  }
  return null;
}

async function renderRuntimeSwiftContent(frame, screen, fonts, managed) {
  const environment = screen.uiTree.runtimeEnvironment;
  const viewport = environment.viewport;
  const dark = environment.colorScheme === "dark";
  const background = dark ? { r: 0.11, g: 0.11, b: 0.12 } : COLORS.surface;
  frame.layoutMode = "NONE";
  frame.resize(viewport.width, viewport.height);
  frame.fills = solid(background);

  const root = figma.createFrame();
  root.name = "UI Sync · Runtime Visual IR";
  root.layoutMode = "NONE";
  root.resize(viewport.width, viewport.height);
  root.fills = solid(background);
  root.clipsContent = true;
  root.setSharedPluginData(NAMESPACE, CONTENT_ROOT_KEY, "1");
  root.setSharedPluginData(NAMESPACE, "swift_runtime_layout", "2");
  frame.setSharedPluginData(NAMESPACE, "swift_runtime_layout", "2");

  if (screen.visualReferenceAssetId) {
    const response = await fetch(`${BRIDGE_URL}/v1/jobs/${screen.pairingCode}/assets/${encodeURIComponent(screen.visualReferenceAssetId)}.png`);
    if (!response.ok) throw new Error(`Could not load the ${screen.name} visual reference from UI Sync.`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const image = figma.createImage(bytes);
    const reference = figma.createRectangle();
    reference.name = "Visual Reference · Simulator";
    reference.resize(viewport.width, viewport.height);
    reference.fills = [{ type: "IMAGE", imageHash: image.hash, scaleMode: "FILL" }];
    reference.locked = true;
    reference.visible = false;
    reference.setSharedPluginData(NAMESPACE, "visual_reference", "1");
    root.appendChild(reference);
    reference.x = 0;
    reference.y = 0;
  }

  const content = await renderIrNode(screen.uiTree, fonts, {
    width: viewport.width,
    height: viewport.height,
    isScreenRoot: true,
    pairingCode: screen.pairingCode
  });
  content.name = content.name.startsWith("Editable Content") ? content.name : `Editable Content · ${content.name}`;
  root.appendChild(content);
  content.x = screen.uiTree.runtimeFrame.x - viewport.x;
  content.y = screen.uiTree.runtimeFrame.y - viewport.y;
  if (content.type === "TEXT") content.textAutoResize = "NONE";
  if ("resize" in content) fixFrameSize(content, screen.uiTree.runtimeFrame.width, screen.uiTree.runtimeFrame.height);

  const systemTabBar = await createSystemTabBar(
    screen,
    fonts,
    viewport.width,
    frame.parent?.type === "PAGE" ? frame.parent : figma.currentPage
  );
  if (systemTabBar) {
    root.appendChild(systemTabBar);
    systemTabBar.x = 0;
    systemTabBar.y = viewport.height - systemTabBar.height;
  }

  if (managed) managed.remove();
  frame.appendChild(root);
  root.x = 0;
  root.y = 0;
  return "rendered";
}

async function renderScreenContent(frame, screen, getFonts, pairingCode) {
  const semanticTree = screen.semanticAutoLayout ? stripRuntimeGeometry(screen.uiTree) : screen.uiTree;
  const renderScreen = semanticTree === screen.uiTree ? screen : { ...screen, uiTree: semanticTree };
  const managed = frame.children.find((child) => child.getSharedPluginData(NAMESPACE, CONTENT_ROOT_KEY) === "1");
  if (!managed && frame.children.length > 0) return "preserved";
  if (screen.renderMode === "snapshot") {
    return renderSnapshotContent(frame, screen, pairingCode, managed);
  }
  if (screen.renderMode === "editable-dom") {
    return renderEditableDomContent(frame, screen, getFonts, managed);
  }

  const fonts = await getFonts();
  if (renderScreen.vectorSvg && vectorViewport(renderScreen)) {
    return renderHybridSwiftContent(frame, renderScreen, fonts, managed);
  }
  if (!renderScreen.semanticAutoLayout && renderScreen.uiTree.runtimeEnvironment && hasRuntimeGeometry(renderScreen.uiTree)) {
    return renderRuntimeSwiftContent(frame, { ...renderScreen, pairingCode }, fonts, managed);
  }
  frame.layoutMode = "VERTICAL";
  frame.primaryAxisSizingMode = "FIXED";
  frame.counterAxisSizingMode = "FIXED";
  const root = createLayout("UI Sync · Generated content", "VERTICAL");
  root.setSharedPluginData(NAMESPACE, CONTENT_ROOT_KEY, "1");
  root.fills = solid(COLORS.background);
  try {
    if (renderScreen.uiTree.type === "navigation") {
      if (renderScreen.uiTree.title) {
        const navigation = createLayout("Navigation Bar", "VERTICAL");
        navigation.paddingTop = 52;
        navigation.paddingRight = 20;
        navigation.paddingBottom = 12;
        navigation.paddingLeft = 20;
        navigation.fills = solid(COLORS.background);
        const navigationTitle = createTextNode(renderScreen.uiTree.title, fonts, { size: 34, weight: "bold", name: "Large title" });
        markSwiftNode(navigationTitle, renderScreen.uiTree, "/title");
        navigation.appendChild(navigationTitle);
        append(root, navigation);
      } else {
        root.paddingTop = 47;
      }
      for (const childIr of renderScreen.uiTree.children || []) append(root, await renderIrNode(childIr, fonts, { width: frame.width, height: frame.height - 47 }));
    } else {
      const isFullBleed = ["zstack", "tabview"].includes(renderScreen.uiTree.type);
      if (isFullBleed) {
        const screenContent = await renderIrNode(renderScreen.uiTree, fonts, { width: frame.width, height: frame.height, isScreenRoot: true });
        append(root, screenContent);
        screenContent.layoutSizingVertical = "FILL";
      } else {
        const safeArea = createLayout("iPhone safe area", "VERTICAL");
        fixFrameSize(safeArea, frame.width, frame.height);
        safeArea.paddingTop = 59;
        safeArea.paddingBottom = 34;
        safeArea.fills = [];
        const screenContent = await renderIrNode(renderScreen.uiTree, fonts, {
          width: frame.width,
          height: frame.height - 93,
          isScreenRoot: true
        });
        append(safeArea, screenContent);
        screenContent.layoutSizingVertical = "FILL";
        append(root, safeArea);
        safeArea.layoutSizingVertical = "FILL";
      }
    }
    if (managed) managed.remove();
    frame.appendChild(root);
    root.layoutSizingHorizontal = "FILL";
    root.layoutSizingVertical = "FILL";
  } catch (error) {
    root.remove();
    throw error;
  }
  return "rendered";
}

function stripRuntimeGeometry(ir) {
  if (!ir || typeof ir !== "object") return ir;
  const {
    runtimeFrame: _runtimeFrame,
    runtimeInstances: _runtimeInstances,
    runtimeStatus: _runtimeStatus,
    runtimeEnvironment: _runtimeEnvironment,
    children,
    ...semantic
  } = ir;
  return {
    ...semantic,
    ...(Array.isArray(children) ? { children: children.map(stripRuntimeGeometry) } : {})
  };
}

function createScreenFrame(screen, projectId, x) {
  const frame = figma.createFrame();
  frame.name = screen.name;
  frame.x = x;
  frame.y = 0;
  const isDesktopCapture = screen.renderMode === "snapshot" || screen.renderMode === "editable-dom";
  const runtimeViewport = screen.renderMode === "structured" ? screen.uiTree.runtimeEnvironment?.viewport : null;
  frame.resize(runtimeViewport?.width || (isDesktopCapture ? screen.width : 393), runtimeViewport?.height || (isDesktopCapture ? screen.height : 852));
  frame.layoutMode = "VERTICAL";
  frame.primaryAxisSizingMode = "FIXED";
  frame.counterAxisSizingMode = "FIXED";
  frame.clipsContent = true;
  frame.fills = [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }];
  markFrame(frame, projectId, screen.id);
  return frame;
}

async function findMappedFrames(projectId) {
  await figma.loadAllPagesAsync();
  const frames = figma.root.findAll((node) => node.type === "FRAME");
  const byScreen = new Map();
  for (const frame of frames) {
    if (frame.getSharedPluginData(NAMESPACE, PROJECT_KEY) !== projectId) continue;
    const screenId = frame.getSharedPluginData(NAMESPACE, SCREEN_KEY);
    if (screenId && !byScreen.has(screenId)) byScreen.set(screenId, frame);
  }
  return byScreen;
}

async function buildMappings(job) {
  const taggedFrames = await findMappedFrames(job.projectId);
  const results = [];
  const created = [];
  const rightEdge = figma.currentPage.children.reduce((maximum, node) => Math.max(maximum, node.x + node.width), 0);
  const startX = rightEdge > 0 ? rightEdge + 160 : 0;
  let nextX = startX;
  let fontPromise = null;
  const getFonts = () => {
    if (!fontPromise) fontPromise = loadProductFonts();
    return fontPromise;
  };

  for (const screen of job.screens) {
    let frame = null;
    if (screen.currentNodeId) {
      const current = await figma.getNodeByIdAsync(screen.currentNodeId);
      if (isFrame(current) && !belongsToAnotherMapping(current, job.projectId, screen.id)) frame = current;
    }
    if (!frame) frame = taggedFrames.get(screen.id) || null;

    let disposition = "reused";
    if (!frame) {
      frame = createScreenFrame(screen, job.projectId, nextX);
      nextX += frame.width + 120;
      created.push(frame);
      disposition = "created";
    } else {
      markFrame(frame, job.projectId, screen.id);
    }

    const contentDisposition = await renderScreenContent(frame, screen, getFonts, job.pairingCode);

    results.push({
      screenId: screen.id,
      nodeId: frame.id,
      frameName: frame.name,
      disposition,
      contentDisposition
    });
  }

  if (created.length > 0) {
    figma.currentPage.selection = created;
    figma.viewport.scrollAndZoomIntoView(created);
  }
  return results;
}

function paintToCss(paints) {
  const paint = Array.isArray(paints) ? paints.find((candidate) => candidate?.type === "SOLID" && candidate.visible !== false) : null;
  if (!paint) return null;
  const red = Math.round(paint.color.r * 255);
  const green = Math.round(paint.color.g * 255);
  const blue = Math.round(paint.color.b * 255);
  const opacity = paint.opacity ?? 1;
  return opacity < 1 ? `rgba(${red}, ${green}, ${blue}, ${opacity})` : `rgb(${red}, ${green}, ${blue})`;
}

function snapshotMappedDomNode(node) {
  const id = node.getSharedPluginData(NAMESPACE, DOM_ID_KEY);
  if (!id) return null;
  const selector = node.getSharedPluginData(NAMESPACE, DOM_SELECTOR_KEY) || null;
  const kind = node.getSharedPluginData(NAMESPACE, DOM_KIND_KEY) || "element";
  const textNode = kind === "text" && node.type === "FRAME" && node.getSharedPluginData(NAMESPACE, "text_container") === "1"
    ? node.children.find((child) => child.type === "TEXT") || null
    : node.type === "TEXT"
      ? node
      : null;
  const text = textNode
    ? node.getSharedPluginData(NAMESPACE, DOM_SYNTHETIC_WRAP_KEY) === "1"
      ? textNode.characters.replace(/\n/g, "")
      : textNode.characters
    : null;
  return {
    id,
    selector,
    kind,
    width: node.width,
    height: node.height,
    backgroundColor: "fills" in node ? paintToCss(node.fills) : null,
    radius: "cornerRadius" in node && typeof node.cornerRadius === "number" ? node.cornerRadius : null,
    fontSize: textNode && typeof textNode.fontSize === "number" ? textNode.fontSize : null,
    fontWeight: textNode && textNode.fontWeight !== figma.mixed
      ? (() => {
          const weight = Number(textNode.fontWeight) || 400;
          return weight >= 850 ? 900 : weight >= 750 ? 800 : weight >= 650 ? 700 : weight >= 550 ? 600 : weight >= 450 ? 500 : 400;
        })()
      : null,
    text
  };
}

async function snapshotPullJob(job) {
  const taggedFrames = await findMappedFrames(job.projectId);
  const screens = [];
  for (const screen of job.screens) {
    let frame = null;
    if (screen.currentNodeId) {
      const current = await figma.getNodeByIdAsync(screen.currentNodeId);
      if (isFrame(current) && !belongsToAnotherMapping(current, job.projectId, screen.id)) frame = current;
    }
    if (!frame) frame = taggedFrames.get(screen.id) || null;
    if (!frame) throw new Error(`No mapped Figma frame was found for ${screen.name}. Push it once before pulling.`);
    const nodes = [frame, ...frame.findAll((node) => Boolean(node.getSharedPluginData(NAMESPACE, DOM_ID_KEY)))]
      .map(snapshotMappedDomNode)
      .filter(Boolean);
    screens.push({ screenId: screen.id, nodes });
  }
  return screens;
}

async function runJob(payload, pairingCode, connectionToken) {
  if (normalizedName(payload.figmaFileName) !== normalizedName(figma.root.name)) {
    throw new Error(`Open “${payload.figmaFileName}” in Figma first. This file is “${figma.root.name}”.`);
  }

  figma.ui.postMessage({
    type: "progress",
    message: payload.operation === "pull" ? `Reading ${payload.screens.length} editable pages…` : `Restoring ${payload.screens.length} page identities…`
  });
  const mappings = payload.operation === "pull" ? null : await buildMappings({ ...payload, pairingCode });
  const screens = await snapshotPullJob(payload);
  const completion = await fetch(`${BRIDGE_URL}/v1/jobs/${pairingCode}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload.operation === "pull"
      ? { operation: "pull", fileName: figma.root.name, screens }
      : { operation: "push", fileName: figma.root.name, mappings, screens })
  });
  const result = await completion.json();
  if (!completion.ok) throw new Error(result.error || "UI Sync could not save the mappings");

  if (connectionToken && figma.clientStorage) {
    await figma.clientStorage.setAsync(CONNECTION_STORAGE_KEY, { token: connectionToken });
  }

  figma.ui.postMessage({
    type: "complete",
    createdCount: result.createdCount,
    reusedCount: result.reusedCount,
    renderedCount: result.renderedCount,
    operation: payload.operation
  });
}

async function connect(pairingCode) {
  figma.ui.postMessage({ type: "progress", message: "Pairing with UI Sync…" });
  const response = await fetch(`${BRIDGE_URL}/v1/jobs/${pairingCode}`);
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "UI Sync is not available");
  await runJob(payload, pairingCode, payload.connectionToken);
}

async function resumeConnection() {
  if (!figma.clientStorage || activePairingCode) return;
  const connection = await figma.clientStorage.getAsync(CONNECTION_STORAGE_KEY);
  if (!connection?.token) {
    figma.ui.postMessage({ type: "pairing-required" });
    return;
  }
  figma.ui.postMessage({ type: "connected", fileName: figma.root.name });
  const response = await fetch(`${BRIDGE_URL}/v1/connections/${connection.token}/job?fileName=${encodeURIComponent(figma.root.name)}`);
  if (response.status === 204) return;
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "UI Sync is not available");
  activePairingCode = payload.pairingCode;
  try {
    await runJob(payload, payload.pairingCode, null);
  } finally {
    activePairingCode = null;
  }
}

async function forgetConnection() {
  if (!figma.clientStorage) return;
  const connection = await figma.clientStorage.getAsync(CONNECTION_STORAGE_KEY);
  if (connection?.token) {
    try { await fetch(`${BRIDGE_URL}/v1/connections/${connection.token}/disconnect`, { method: "POST" }); } catch {}
  }
  await figma.clientStorage.deleteAsync(CONNECTION_STORAGE_KEY);
  figma.ui.postMessage({ type: "pairing-required" });
}

figma.ui.onmessage = async (message) => {
  if (message?.type === "close") {
    figma.closePlugin();
    return;
  }
  if (message?.type === "resume") {
    try {
      await resumeConnection();
    } catch (error) {
      figma.ui.postMessage({ type: "offline", message: error instanceof Error ? error.message : "UI Sync desktop is not available" });
    }
    return;
  }
  if (message?.type === "forget") {
    await forgetConnection();
    return;
  }
  if (message?.type !== "connect") return;
  const pairingCode = String(message.pairingCode || "").replace(/\D/g, "").slice(0, 6);
  if (pairingCode.length !== 6) {
    figma.ui.postMessage({ type: "error", message: "Enter the six-digit code from UI Sync." });
    return;
  }
  try {
    await connect(pairingCode);
  } catch (error) {
    figma.ui.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "Automatic mapping failed"
    });
  }
};
