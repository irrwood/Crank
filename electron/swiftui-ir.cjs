const { z } = require("zod");

const paddingSchema = z.object({
  top: z.number().min(-4000).max(4000),
  right: z.number().min(-4000).max(4000),
  bottom: z.number().min(-4000).max(4000),
  left: z.number().min(-4000).max(4000)
}).strict();

const sourceRangeSchema = z.object({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  startOffset: z.number().int().nonnegative(),
  endOffset: z.number().int().positive()
}).strict();

const runtimeFrameSchema = z.object({
  x: z.number().finite().min(-10000).max(10000),
  y: z.number().finite().min(-10000).max(10000),
  width: z.number().finite().min(0).max(10000),
  height: z.number().finite().min(0).max(10000)
}).strict();

const runtimeEnvironmentSchema = z.object({
  viewport: runtimeFrameSchema,
  displayScale: z.number().finite().min(0.5).max(8),
  colorScheme: z.enum(["light", "dark"]),
  dynamicTypeSize: z.string().min(1).max(80),
  layoutDirection: z.enum(["leftToRight", "rightToLeft"])
}).strict();

const uiNodeSchema = z.lazy(() => z.object({
  syncId: z.string().regex(/^swift\/[a-f0-9]{16}(?:\/\d+)*$/).optional(),
  sourceFile: z.string().min(1).max(500).optional(),
  sourceName: z.string().min(1).max(160).optional(),
  sourceExpression: z.string().max(1000).optional(),
  sourceRange: sourceRangeSchema.optional(),
  runtimeFrame: runtimeFrameSchema.optional(),
  runtimeInstances: z.array(runtimeFrameSchema.extend({ instanceId: z.string().min(1).max(120) })).max(500).optional(),
  runtimeStatus: z.literal("captured").optional(),
  runtimeTextCaptured: z.boolean().optional(),
  runtimeAssetCaptured: z.boolean().optional(),
  runtimeEnvironment: runtimeEnvironmentSchema.optional(),
  visualMode: z.enum(["editable", "snapshot-fallback"]).optional(),
  visualConfidence: z.enum(["high", "medium", "low"]).optional(),
  fallbackAssetId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/).optional(),
  type: z.enum([
    "navigation", "vstack", "hstack", "zstack", "scroll", "list", "section",
    "text", "label", "symbol", "button", "toggle", "field", "divider", "spacer", "shape", "progress", "custom", "group", "tabview"
  ]),
  name: z.string().max(160).optional(),
  assetName: z.string().max(500).optional(),
  text: z.string().max(500).optional(),
  textKey: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,119}$/).optional(),
  symbol: z.string().max(120).optional(),
  title: z.string().max(240).optional(),
  direction: z.enum(["vertical", "horizontal"]).optional(),
  alignment: z.enum(["leading", "center", "trailing", "top", "bottom", "topLeading", "topTrailing", "bottomLeading", "bottomTrailing"]).optional(),
  spacing: z.number().min(0).max(240).optional(),
  fontStyle: z.enum(["largeTitle", "title", "title2", "title3", "headline", "subheadline", "body", "callout", "footnote", "caption", "caption2"]).optional(),
  fontWeight: z.enum(["regular", "medium", "semibold", "bold", "heavy", "black"]).optional(),
  fontSize: z.number().min(6).max(120).optional(),
  colorToken: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
  backgroundColorToken: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
  borderColorToken: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
  backgroundShape: z.enum(["rectangle", "roundedRectangle", "capsule", "circle"]).optional(),
  padding: paddingSchema.optional(),
  cornerRadius: z.number().min(0).max(120).optional(),
  borderWidth: z.number().min(0).max(24).optional(),
  opacity: z.number().min(0).max(1).optional(),
  colorOpacity: z.number().min(0).max(1).optional(),
  backgroundOpacity: z.number().min(0).max(1).optional(),
  borderOpacity: z.number().min(0).max(1).optional(),
  tracking: z.number().min(-20).max(80).optional(),
  lineSpacing: z.number().min(0).max(120).optional(),
  textAlignment: z.enum(["leading", "center", "trailing"]).optional(),
  width: z.number().min(1).max(4000).optional(),
  height: z.number().min(1).max(4000).optional(),
  minLength: z.number().min(0).max(4000).optional(),
  offsetX: z.number().min(-4000).max(4000).optional(),
  offsetY: z.number().min(-4000).max(4000).optional(),
  blurRadius: z.number().min(0).max(240).optional(),
  shadowRadius: z.number().min(0).max(240).optional(),
  shadowColorToken: z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/).optional(),
  shadowOpacity: z.number().min(0).max(1).optional(),
  shadowX: z.number().min(-4000).max(4000).optional(),
  shadowY: z.number().min(-4000).max(4000).optional(),
  material: z.enum(["ultraThin", "thin", "regular", "thick", "ultraThick", "glass", "glassProminent"]).optional(),
  controlSize: z.enum(["mini", "small", "regular", "large", "extraLarge"]).optional(),
  isEnabled: z.boolean().optional(),
  destructive: z.boolean().optional(),
  fillWidth: z.boolean().optional(),
  fillHeight: z.boolean().optional(),
  tabTitle: z.string().max(120).optional(),
  tabSymbol: z.string().max(120).optional(),
  children: z.array(uiNodeSchema).max(200).optional()
}).strict());

const recognizedViews = new Set([
  "NavigationStack", "VStack", "LazyVStack", "HStack", "LazyHStack", "ZStack",
  "ScrollView", "List", "Form", "Section", "Text", "Label", "Image", "Button",
  "Toggle", "TextField", "SecureField", "Divider", "Spacer", "Group", "TabView", "ForEach", "Circle", "Rectangle",
  "RoundedRectangle", "Capsule", "LinearGradient", "RadialGradient", "ProgressView"
]);

function matchingIndex(source, start, open, close) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === open) depth += 1;
    if (character === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function stringsIn(value) {
  return [...value.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) =>
    match[1].replace(/\\"/g, '"').replace(/\\n/g, "\n").replace(/\\\\/g, "\\")
  );
}

function numericArgument(value) {
  const match = value.match(/(?:^|,|:)\s*(-?\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function namedNumber(value, name) {
  const match = value.match(new RegExp(`\\b${name}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return match ? Number(match[1]) : null;
}

function dimensionNumber(value, name) {
  const direct = namedNumber(value, name);
  if (direct !== null) return direct;
  const ternary = value.match(new RegExp(`\\b${name}\\s*:[^,)]*\\?\\s*(-?\\d+(?:\\.\\d+)?)\\s*:\\s*(-?\\d+(?:\\.\\d+)?)`));
  return ternary ? Number(ternary[2]) : null;
}

function lastNumericValue(value) {
  const values = [...String(value || "").matchAll(/-?\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  return values.length ? values.at(-1) : null;
}

function opacityIn(value) {
  const matches = [...String(value || "").matchAll(/\.opacity\s*\(([^)]*)\)/g)];
  if (!matches.length) return undefined;
  const opacity = lastNumericValue(matches.at(-1)[1]);
  return opacity === null ? undefined : Math.max(0, Math.min(1, opacity));
}

function humanizeIdentifier(value) {
  const identifier = value.match(/([A-Za-z_][A-Za-z0-9_]*)\s*\)?\s*$/)?.[1];
  if (!identifier) return "Preview content";
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function textValue(value, fallback = "Preview content", textDefaults = new Map()) {
  const strings = stringsIn(value);
  if (strings[0]) {
    if (/^%0?\d*d$/.test(strings[0]) && /\bString\s*\(\s*format\s*:/.test(value)) return "01";
    return strings[0].replace(/\\\([^)]*\.([A-Za-z_][A-Za-z0-9_]*)\)/g, (_, name) => humanizeIdentifier(name));
  }
  const directIdentifier = value.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
  if (directIdentifier && textDefaults.has(directIdentifier)) return textDefaults.get(directIdentifier);
  const viewModelProperty = value.match(/\bviewModel\.([A-Za-z_][A-Za-z0-9_]*)/)?.[1];
  if (viewModelProperty && textDefaults.has(viewModelProperty)) return textDefaults.get(viewModelProperty);
  if (viewModelProperty) return humanizeIdentifier(viewModelProperty);
  return value.trim() ? humanizeIdentifier(value) : fallback;
}

function dynamicTextKeyIn(value) {
  return value.match(/\bviewModel\.([A-Za-z_][A-Za-z0-9_]*)/)?.[1]
    || value.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)$/)?.[1];
}

const ignoredColorNames = new Set([
  "continuous", "infinity", "leading", "trailing", "center", "top", "bottom",
  "horizontal", "vertical", "visible", "plain", "medium", "large", "regular",
  "semibold", "bold", "heavy", "rounded", "monospaced", "opacity", "stroke",
  "strokeBorder", "fill", "foregroundStyle", "foregroundColor", "background", "overlay", "font", "frame", "tabBar"
]);

function colorTokenIn(value) {
  const explicit = [...value.matchAll(/Color\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const shorthand = [...value.matchAll(/(?:^|[\s(:,?])\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((match) => match[1]);
  const candidates = [...explicit, ...shorthand].filter((token) => !ignoredColorNames.has(token));
  return value.includes("?") ? candidates.at(-1) : candidates[0];
}

function emptyPadding() {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

function mergePadding(current, argumentsText) {
  const next = current ? { ...current } : emptyPadding();
  const amount = numericArgument(argumentsText) ?? 16;
  if (!argumentsText.trim() || /^\s*-?\d/.test(argumentsText)) {
    return { top: amount, right: amount, bottom: amount, left: amount };
  }
  if (/\.horizontal\b/.test(argumentsText)) {
    next.left = amount;
    next.right = amount;
  } else if (/\.vertical\b/.test(argumentsText)) {
    next.top = amount;
    next.bottom = amount;
  } else if (/\.top\b/.test(argumentsText)) next.top = amount;
  else if (/\.bottom\b/.test(argumentsText)) next.bottom = amount;
  else if (/\.leading\b/.test(argumentsText)) next.left = amount;
  else if (/\.trailing\b/.test(argumentsText)) next.right = amount;
  else return { top: amount, right: amount, bottom: amount, left: amount };
  return next;
}

function alignmentIn(value) {
  return value.match(/\.(topLeading|topTrailing|bottomLeading|bottomTrailing|leading|center|trailing|top|bottom)\b/)?.[1];
}

function backgroundShapeIn(value) {
  if (/\bCapsule\s*\(/.test(value)) return "capsule";
  if (/\bCircle\s*\(/.test(value)) return "circle";
  if (/\bRoundedRectangle\s*\(/.test(value)) return "roundedRectangle";
  return "rectangle";
}

function commonFromModifiers(modifiers) {
  return {
    ...(modifiers.padding ? { padding: modifiers.padding } : {}),
    ...(modifiers.cornerRadius !== undefined ? { cornerRadius: modifiers.cornerRadius } : {}),
    ...(modifiers.fontStyle ? { fontStyle: modifiers.fontStyle } : {}),
    ...(modifiers.fontWeight ? { fontWeight: modifiers.fontWeight } : {}),
    ...(modifiers.fontSize ? { fontSize: modifiers.fontSize } : {}),
    ...(modifiers.colorToken ? { colorToken: modifiers.colorToken } : {}),
    ...(modifiers.backgroundColorToken ? { backgroundColorToken: modifiers.backgroundColorToken } : {}),
    ...(modifiers.borderColorToken ? { borderColorToken: modifiers.borderColorToken } : {}),
    ...(modifiers.backgroundShape ? { backgroundShape: modifiers.backgroundShape } : {}),
    ...(modifiers.borderWidth !== undefined ? { borderWidth: modifiers.borderWidth } : {}),
    ...(modifiers.opacity !== undefined ? { opacity: modifiers.opacity } : {}),
    ...(modifiers.colorOpacity !== undefined ? { colorOpacity: modifiers.colorOpacity } : {}),
    ...(modifiers.backgroundOpacity !== undefined ? { backgroundOpacity: modifiers.backgroundOpacity } : {}),
    ...(modifiers.borderOpacity !== undefined ? { borderOpacity: modifiers.borderOpacity } : {}),
    ...(modifiers.tracking !== undefined ? { tracking: modifiers.tracking } : {}),
    ...(modifiers.lineSpacing !== undefined ? { lineSpacing: modifiers.lineSpacing } : {}),
    ...(modifiers.textAlignment ? { textAlignment: modifiers.textAlignment } : {}),
    ...(modifiers.alignment ? { alignment: modifiers.alignment } : {}),
    ...(modifiers.width ? { width: modifiers.width } : {}),
    ...(modifiers.height ? { height: modifiers.height } : {}),
    ...(modifiers.minLength !== undefined ? { minLength: modifiers.minLength } : {}),
    ...(modifiers.offsetX !== undefined ? { offsetX: modifiers.offsetX } : {}),
    ...(modifiers.offsetY !== undefined ? { offsetY: modifiers.offsetY } : {}),
    ...(modifiers.blurRadius !== undefined ? { blurRadius: modifiers.blurRadius } : {}),
    ...(modifiers.shadowRadius !== undefined ? { shadowRadius: modifiers.shadowRadius } : {}),
    ...(modifiers.shadowColorToken ? { shadowColorToken: modifiers.shadowColorToken } : {}),
    ...(modifiers.shadowOpacity !== undefined ? { shadowOpacity: modifiers.shadowOpacity } : {}),
    ...(modifiers.shadowX !== undefined ? { shadowX: modifiers.shadowX } : {}),
    ...(modifiers.shadowY !== undefined ? { shadowY: modifiers.shadowY } : {}),
    ...(modifiers.material ? { material: modifiers.material } : {}),
    ...(modifiers.controlSize ? { controlSize: modifiers.controlSize } : {}),
    ...(modifiers.isEnabled !== undefined ? { isEnabled: modifiers.isEnabled } : {}),
    ...(modifiers.fillWidth ? { fillWidth: true } : {}),
    ...(modifiers.fillHeight ? { fillHeight: true } : {}),
    ...(modifiers.overlaySymbol ? { symbol: modifiers.overlaySymbol } : {}),
    ...(modifiers.tabTitle ? { tabTitle: modifiers.tabTitle } : {}),
    ...(modifiers.tabSymbol ? { tabSymbol: modifiers.tabSymbol } : {})
  };
}

function parseModifiers(source, start, depth = 0, helpers = new Map(), resolving = new Set(), textDefaults = new Map()) {
  const modifiers = {};
  let cursor = start;
  while (cursor < source.length) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== ".") break;
    const nameMatch = source.slice(cursor + 1).match(/^([A-Za-z_][A-Za-z0-9_]*)/);
    if (!nameMatch) break;
    const name = nameMatch[1];
    cursor += name.length + 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    let argumentsText = "";
    if (source[cursor] === "(") {
      const end = matchingIndex(source, cursor, "(", ")");
      if (end < 0) break;
      argumentsText = source.slice(cursor + 1, end);
      cursor = end + 1;
    }
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    let closureText = "";
    if (source[cursor] === "{") {
      const end = matchingIndex(source, cursor, "{", "}");
      if (end < 0) break;
      closureText = source.slice(cursor + 1, end);
      cursor = end + 1;
    }

    if (name === "navigationTitle") modifiers.title = stringsIn(argumentsText)[0];
    if (name === "padding") modifiers.padding = mergePadding(modifiers.padding, argumentsText);
    if (name === "cornerRadius") modifiers.cornerRadius = numericArgument(argumentsText) ?? 0;
    if (name === "frame") {
      const width = dimensionNumber(argumentsText, "width");
      const height = dimensionNumber(argumentsText, "height");
      if (width) modifiers.width = width;
      if (height) modifiers.height = height;
      if (/\bmaxWidth\s*:\s*\.infinity\b/.test(argumentsText)) modifiers.fillWidth = true;
      if (/\bmaxHeight\s*:\s*\.infinity\b/.test(argumentsText)) modifiers.fillHeight = true;
      const alignment = alignmentIn(argumentsText);
      if (alignment) modifiers.alignment = alignment;
    }
    if (name === "font") {
      const style = argumentsText.match(/\.(largeTitle|title2|title3|title|headline|subheadline|body|callout|footnote|caption2|caption)\b/)?.[1];
      if (style) modifiers.fontStyle = style;
      const size = argumentsText.match(/\bsize\s*:\s*(\d+(?:\.\d+)?)/)?.[1];
      if (size) modifiers.fontSize = Number(size);
      const systemWeight = argumentsText.match(/\bweight\s*:\s*\.(regular|medium|semibold|bold|heavy|black)\b/)?.[1];
      if (systemWeight) modifiers.fontWeight = systemWeight;
    }
    if (name === "fontWeight" || name === "bold") {
      const weight = name === "bold" ? "bold" : argumentsText.match(/\.(regular|medium|semibold|bold|heavy|black)\b/)?.[1];
      if (weight) modifiers.fontWeight = weight;
    }
    if (["foregroundStyle", "foregroundColor", "tint", "fill"].includes(name)) {
      const token = colorTokenIn(argumentsText);
      if (token) modifiers.colorToken = token;
      const colorOpacity = opacityIn(argumentsText);
      if (colorOpacity !== undefined) modifiers.colorOpacity = colorOpacity;
    }
    if (name === "background") {
      const visualSource = `${argumentsText} ${closureText}`;
      const material = visualSource.match(/\.(ultraThin|thin|regular|thick|ultraThick)Material\b/)?.[1];
      if (material) modifiers.material = material;
      const token = colorTokenIn(visualSource);
      if (token) modifiers.backgroundColorToken = token;
      const backgroundOpacity = opacityIn(visualSource);
      if (backgroundOpacity !== undefined) modifiers.backgroundOpacity = backgroundOpacity;
      modifiers.backgroundShape = backgroundShapeIn(visualSource);
      const radius = visualSource.match(/RoundedRectangle\s*\(\s*cornerRadius\s*:\s*(\d+(?:\.\d+)?)/)?.[1];
      if (radius) modifiers.cornerRadius = Number(radius);
    }
    if (name === "glassEffect") modifiers.material = "glass";
    if (name === "buttonStyle") {
      if (/\.glassProminent\b/.test(argumentsText)) modifiers.material = "glassProminent";
      else if (/\.glass\b/.test(argumentsText)) modifiers.material = "glass";
    }
    if (name === "controlSize") {
      const controlSize = argumentsText.match(/\.(mini|small|regular|large|extraLarge)\b/)?.[1];
      if (controlSize) modifiers.controlSize = controlSize;
    }
    if (name === "disabled") {
      if (/^\s*true\s*$/.test(argumentsText)) modifiers.isEnabled = false;
      if (/^\s*false\s*$/.test(argumentsText)) modifiers.isEnabled = true;
    }
    if (name === "toolbarBackground") {
      const token = colorTokenIn(argumentsText);
      if (token) modifiers.backgroundColorToken = token;
      const backgroundOpacity = opacityIn(argumentsText);
      if (backgroundOpacity !== undefined) modifiers.backgroundOpacity = backgroundOpacity;
    }
    if (["overlay", "border", "stroke"].includes(name)) {
      const visualSource = `${argumentsText} ${closureText}`;
      const isBorderVisual = name !== "overlay" || /\.stroke(?:Border)?\s*\(/.test(visualSource);
      if (isBorderVisual) {
        const token = colorTokenIn(visualSource);
        if (token) modifiers.borderColorToken = token;
        const borderOpacity = opacityIn(visualSource);
        if (borderOpacity !== undefined) modifiers.borderOpacity = borderOpacity;
        modifiers.borderWidth = namedNumber(visualSource, "lineWidth") ?? (name === "border" ? numericArgument(visualSource) : null) ?? 1;
      }
      const overlaySymbol = visualSource.match(/Image\s*\(\s*systemName\s*:\s*"([A-Za-z0-9._-]+)"\s*\)/)?.[1];
      if (overlaySymbol) modifiers.overlaySymbol = overlaySymbol;
      if (name === "overlay" && /\b(?:VStack|HStack|ZStack|Text|Label|Image|ProgressView)\s*[({]/.test(visualSource)) {
        const overlayChildren = parseSequence(visualSource, depth + 1, helpers, resolving, textDefaults);
        if (overlayChildren.length) modifiers.overlayChildren = [...(modifiers.overlayChildren || []), ...overlayChildren];
      }
    }
    if (name === "opacity") {
      const opacity = lastNumericValue(argumentsText) ?? undefined;
      if (opacity !== undefined) modifiers.opacity = Math.max(0, Math.min(1, opacity));
    }
    if (name === "tracking") modifiers.tracking = numericArgument(argumentsText) ?? 0;
    if (name === "lineSpacing") modifiers.lineSpacing = numericArgument(argumentsText) ?? 0;
    if (name === "multilineTextAlignment") {
      const alignment = argumentsText.match(/\.(leading|center|trailing)\b/)?.[1];
      if (alignment) modifiers.textAlignment = alignment;
    }
    if (name === "offset") {
      const x = namedNumber(argumentsText, "x");
      const y = namedNumber(argumentsText, "y");
      if (x !== null) modifiers.offsetX = x;
      if (y !== null) modifiers.offsetY = y;
      if (x === null && y === null) modifiers.offsetX = numericArgument(argumentsText) ?? 0;
    }
    if (name === "blur") modifiers.blurRadius = namedNumber(argumentsText, "radius") ?? numericArgument(argumentsText) ?? 0;
    if (name === "shadow") {
      modifiers.shadowRadius = dimensionNumber(argumentsText, "radius") ?? 0;
      const shadowColorToken = colorTokenIn(argumentsText);
      if (shadowColorToken) modifiers.shadowColorToken = shadowColorToken;
      const shadowOpacity = opacityIn(argumentsText);
      if (shadowOpacity !== undefined) modifiers.shadowOpacity = shadowOpacity;
      modifiers.shadowX = namedNumber(argumentsText, "x") ?? 0;
      modifiers.shadowY = namedNumber(argumentsText, "y") ?? 0;
    }
    if (name === "flowPanel") {
      modifiers.backgroundColorToken = "flowPanel";
      modifiers.backgroundShape = "roundedRectangle";
      modifiers.cornerRadius = 22;
      modifiers.borderColorToken = "flowBorder";
      modifiers.borderWidth = 1;
      modifiers.backgroundOpacity = 0.78;
      modifiers.borderOpacity = 0.75;
    }
    if (name === "tabItem") {
      const label = closureText.match(/Label\s*\(([^)]*)\)/)?.[1] ?? closureText;
      const values = stringsIn(label);
      if (values[0]) modifiers.tabTitle = values[0];
      if (values[1]) modifiers.tabSymbol = values[1];
    }
  }
  return { modifiers, end: cursor };
}

function nodeFromView(name, argumentsText, children, modifiers, labeledChildren = {}, textDefaults = new Map()) {
  const strings = stringsIn(argumentsText);
  const common = commonFromModifiers(modifiers);
  const stackOptions = {
    ...(alignmentIn(argumentsText) ? { alignment: alignmentIn(argumentsText) } : {}),
    ...(namedNumber(argumentsText, "spacing") !== null ? { spacing: namedNumber(argumentsText, "spacing") } : {})
  };
  if (name === "NavigationStack") return { type: "navigation", ...(modifiers.title ? { title: modifiers.title } : {}), children, ...common };
  if (["VStack", "LazyVStack"].includes(name)) return { type: "vstack", children, ...stackOptions, ...common };
  if (["HStack", "LazyHStack"].includes(name)) return { type: "hstack", children, ...stackOptions, ...common };
  if (name === "ZStack") return { type: "zstack", children, ...stackOptions, ...common };
  if (name === "ScrollView") return { type: "scroll", direction: argumentsText.includes(".horizontal") ? "horizontal" : "vertical", children, ...common };
  if (["List", "Form"].includes(name)) return { type: "list", ...(modifiers.title ? { title: modifiers.title } : {}), children, ...common };
  if (name === "Section") return { type: "section", ...(strings[0] ? { title: strings[0] } : {}), children, ...common };
  if (name === "Text") {
    const textKey = strings.length ? undefined : dynamicTextKeyIn(argumentsText);
    return { type: "text", text: textValue(argumentsText, "Preview content", textDefaults), ...(textKey ? { textKey } : {}), ...common };
  }
  if (name === "Label") return { type: "label", text: textValue(argumentsText, "Label", textDefaults), ...(strings[1] ? { symbol: strings[1] } : {}), ...common };
  if (name === "Image") return { type: "symbol", symbol: strings[0] ?? "image", ...common };
  if (name === "Button") {
    const labelChildren = labeledChildren.label?.length ? labeledChildren.label : children;
    return {
      type: "button",
      text: strings[0] ?? (labelChildren.length ? undefined : "Button"),
      children: labelChildren,
      ...(/\brole\s*:\s*\.destructive\b/.test(argumentsText) ? { destructive: true } : {}),
      ...common
    };
  }
  if (name === "Toggle") return { type: "toggle", text: textValue(argumentsText, "Toggle"), ...common };
  if (["TextField", "SecureField"].includes(name)) return { type: "field", name, text: strings[0] ?? (name === "SecureField" ? "••••••••" : "Text field"), ...common };
  if (name === "Divider") return { type: "divider" };
  if (name === "Spacer") return { type: "spacer", ...(namedNumber(argumentsText, "minLength") !== null ? { minLength: namedNumber(argumentsText, "minLength") } : {}) };
  if (name === "TabView") return { type: "tabview", name, children, ...common };
  if (["Group", "ForEach"].includes(name)) return { type: "group", name, children, ...common };
  if (name === "ProgressView") return { type: "progress", name: "Progress" };
  if (["Circle", "Rectangle", "RoundedRectangle", "Capsule", "LinearGradient", "RadialGradient"].includes(name)) {
    return {
      type: "shape",
      name,
      ...(name === "RoundedRectangle" ? { cornerRadius: numericArgument(argumentsText) ?? 12 } : {}),
      ...common,
      ...(modifiers.overlayChildren?.length ? { children: modifiers.overlayChildren } : {})
    };
  }
  return { type: "custom", name, children, ...common };
}

function controlBlockStart(source, start) {
  let parentheses = 0;
  let brackets = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "(") parentheses += 1;
    else if (character === ")") parentheses -= 1;
    else if (character === "[") brackets += 1;
    else if (character === "]") brackets -= 1;
    else if (character === "{" && parentheses === 0 && brackets === 0) return index;
  }
  return -1;
}

function defaultConditionValue(condition) {
  const value = condition.trim();
  if (/^(?:if\s+)?(?:let|case)\b/.test(value)) return /\bcurrentTask\b/.test(value);
  if (/colorScheme\s*==\s*\.dark\b/.test(value)) return false;
  if (/transcriptPlaceholderHint\.isEmpty\b/.test(value)) return !/^\s*!/.test(value);
  if (/\.isEmpty\b/.test(value)) return !/^\s*!/.test(value);
  if (/hasTranscript\b/.test(value)) return /^\s*!/.test(value);
  if (/\b(?:isRecording|isParsing|isLoading|isPresented|isShowing|isExpanded|isCompleted)\b/.test(value)) return false;
  if (/stage\s*==\s*\.focus\b/.test(value)) return false;
  return false;
}

function parseSequence(source, depth = 0, helpers = new Map(), resolving = new Set(), textDefaults = new Map()) {
  if (depth > 24) return [];
  const nodes = [];
  let cursor = 0;
  while (cursor < source.length && nodes.length < 200) {
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (/^if\b/.test(source.slice(cursor))) {
      const conditionStart = cursor + 2;
      const open = controlBlockStart(source, conditionStart);
      if (open < 0) break;
      const close = matchingIndex(source, open, "{", "}");
      if (close < 0) break;
      const condition = source.slice(conditionStart, open);
      const truthySource = source.slice(open + 1, close);
      let end = close + 1;
      while (/\s/.test(source[end] ?? "")) end += 1;
      let falsySource = "";
      if (/^else\b/.test(source.slice(end))) {
        end += 4;
        while (/\s/.test(source[end] ?? "")) end += 1;
        if (source[end] === "{") {
          const elseClose = matchingIndex(source, end, "{", "}");
          if (elseClose < 0) break;
          falsySource = source.slice(end + 1, elseClose);
          end = elseClose + 1;
        }
      }
      const selected = defaultConditionValue(condition) ? truthySource : falsySource;
      if (selected) nodes.push(...parseSequence(selected, depth + 1, helpers, resolving, textDefaults));
      cursor = end;
      continue;
    }
    const match = source.slice(cursor).match(/\b([A-Za-z_][A-Za-z0-9_]*)\s*/);
    if (!match) break;
    cursor += match.index + match[0].length;
    const name = match[1];
    const viewStart = cursor - match[0].length;
    let argumentsText = "";
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] === "(") {
      const end = matchingIndex(source, cursor, "(", ")");
      if (end < 0) break;
      argumentsText = source.slice(cursor + 1, end);
      cursor = end + 1;
    }
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    let children = [];
    if (source[cursor] === "{") {
      const end = matchingIndex(source, cursor, "{", "}");
      if (end < 0) break;
      children = parseSequence(source.slice(cursor + 1, end), depth + 1, helpers, resolving, textDefaults);
      cursor = end + 1;
    }
    const labeledChildren = {};
    while (cursor < source.length) {
      const trailing = source.slice(cursor).match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{/);
      if (!trailing) break;
      const label = trailing[1];
      const open = cursor + trailing[0].lastIndexOf("{");
      const close = matchingIndex(source, open, "{", "}");
      if (close < 0) break;
      labeledChildren[label] = parseSequence(source.slice(open + 1, close), depth + 1, helpers, resolving, textDefaults);
      cursor = close + 1;
    }
    const { modifiers, end } = parseModifiers(source, cursor, depth, helpers, resolving, textDefaults);
    cursor = Math.max(end, cursor, viewStart + 1);
    if (helpers.has(name) && !resolving.has(name)) {
      const nextResolving = new Set(resolving);
      nextResolving.add(name);
      const helperNodes = parseSequence(helpers.get(name), depth + 1, helpers, nextResolving, textDefaults);
      const helperRoot = helperNodes.length === 1 ? helperNodes[0] : { type: "vstack", children: helperNodes };
      nodes.push({ ...helperRoot, ...commonFromModifiers(modifiers) });
      continue;
    }
    const isCustomView = /^[A-Z]/.test(name) && (argumentsText || children.length > 0 || /(View|Screen|Page|Panel|Card|Spinner|Backdrop)$/.test(name));
    if (recognizedViews.has(name) || isCustomView) nodes.push(nodeFromView(name, argumentsText, children, modifiers, labeledChildren, textDefaults));
    else if (children.length > 0) nodes.push(...children);
  }
  return nodes;
}

function extractHelperBlocks(source) {
  const helpers = new Map();
  const expressions = [
    /\b(?:private\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*some\s+View\s*\{/g,
    /\b(?:private\s+)?func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)\s*->\s*some\s+View\s*\{/g
  ];
  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) {
      const name = match[1];
      if (!name || name === "body" || match.index === undefined) continue;
      const open = match.index + match[0].lastIndexOf("{");
      const close = matchingIndex(source, open, "{", "}");
      if (close > open) helpers.set(name, source.slice(open + 1, close));
    }
  }
  return helpers;
}

function extractComputedStringDefaults(source) {
  const defaults = new Map();
  const expression = /\b(?:private\s+)?var\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*String\s*\{/g;
  for (const match of source.matchAll(expression)) {
    const name = match[1];
    if (!name || match.index === undefined) continue;
    const open = match.index + match[0].lastIndexOf("{");
    const close = matchingIndex(source, open, "{", "}");
    if (close < 0) continue;
    const returns = [...source.slice(open + 1, close).matchAll(/\breturn\s+"((?:\\.|[^"\\])*)"/g)];
    const fallback = returns.at(-1)?.[1];
    if (fallback !== undefined) defaults.set(name, fallback.replace(/\\"/g, '"').replace(/\\n/g, "\n"));
  }
  return defaults;
}

function bubbleNavigationTitle(node) {
  if (node.title) return node.title;
  for (const child of node.children ?? []) {
    const title = bubbleNavigationTitle(child);
    if (title) return title;
  }
  return undefined;
}

function buildSwiftUiIr(source) {
  const bodyMatch = source.match(/\bvar\s+body\s*:\s*some\s+View\s*\{/);
  if (!bodyMatch || bodyMatch.index === undefined) return { type: "group", children: [] };
  const open = bodyMatch.index + bodyMatch[0].lastIndexOf("{");
  const close = matchingIndex(source, open, "{", "}");
  if (close < 0) return { type: "group", children: [] };
  const nodes = parseSequence(
    source.slice(open + 1, close),
    0,
    extractHelperBlocks(source),
    new Set(),
    extractComputedStringDefaults(source)
  );
  const root = nodes.length === 1 ? nodes[0] : { type: "vstack", children: nodes };
  if (root.type === "navigation" && !root.title) root.title = bubbleNavigationTitle(root);
  return uiNodeSchema.parse(root);
}

module.exports = { buildSwiftUiIr, uiNodeSchema };
