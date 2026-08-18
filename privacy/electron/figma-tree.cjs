/**
 * Serialises a rendered page into the node tree the Figma plugin builds from:
 * geometry, fills, strokes, corner radius, clipping and text styling, split
 * into element / text / svg / image nodes.
 *
 * Lifted out of the main process unchanged so page discovery and the original
 * capture path share one implementation rather than drifting apart. It is
 * injected into the page with toString(), so it must stay self-contained.
 */
function serializeRenderedApplication() {
  if (!document.body) throw new Error("The application root is not available");

  const rounded = (value) => Math.round(value * 100) / 100;
  const pixels = (value) => {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  const visible = (style, rect) => style.display !== "none"
    && style.visibility !== "hidden"
    && Number.parseFloat(style.opacity || "1") > 0
    && rect.width >= 0.5
    && rect.height >= 0.5;
  const bounds = (rect, parentRect) => ({
    x: rounded(rect.left - parentRect.left),
    y: rounded(rect.top - parentRect.top),
    width: rounded(rect.width),
    height: rounded(rect.height)
  });
  const safeName = (element) => {
    const label = element.getAttribute("aria-label") || element.getAttribute("title");
    if (label) return label.slice(0, 100);
    const className = typeof element.className === "string" ? element.className.split(/\s+/)[0] : "";
    return `${element.tagName.toLowerCase()}${className ? ` · ${className}` : ""}`.slice(0, 100);
  };
  /**
   * The picture, at the size the page draws it — not the size it was shipped at.
   *
   * A portfolio's hero photo was kept 5,625px wide to fill a 183px box: 6.7MB,
   * twice over, in a scan whose entire layer tree is 4MB. Across that one scan,
   * 156 of 214 images were stored more than twice as large as they were drawn,
   * and that was 66MB of 105MB. Nothing can show those pixels, and every one of
   * them has to be decoded before a page can be drawn.
   *
   * Four times the box it occupies: enough for a retina screen and for zooming
   * in twice beyond that, and never more than the image actually has.
   */
  const IMAGE_HEADROOM = 4;

  const imageData = (element) => {
    try {
      const natural = Math.max(1, element.naturalWidth || element.width);
      const drawn = element.getBoundingClientRect().width || element.width || natural;
      const width = Math.min(natural, Math.max(64, Math.round(drawn * IMAGE_HEADROOM)));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = Math.max(1, Math.round((element.naturalHeight || element.height || 1) * (width / natural)));
      canvas.getContext("2d")?.drawImage(element, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL("image/png");
      // Whichever is smaller. WebP wins on photographs by a wide margin and PNG
      // on flat icons and logos, and a real page has both.
      const webp = canvas.toDataURL("image/webp", 0.85);
      return webp.startsWith("data:image/webp") && webp.length < png.length ? webp : png;
    } catch {
      return null;
    }
  };
  /**
   * The icon behind a CSS mask.
   *
   * A whole family of icon sets — UnoCSS and Iconify's "pure CSS icons",
   * Tailwind's mask idiom — draw an icon as an empty element whose background
   * colour is cut to shape by `mask-image`. Read as an element it is a filled
   * rectangle, and that is exactly how a real application's toolbar arrived in
   * Figma: a row of solid blue and grey squares where its icons had been. The
   * shape is right there in the mask, as an SVG.
   *
   * The mask carries no colour of its own — only where the paint falls — so
   * whatever the shape declares is replaced with the colour the element paints
   * with, which is the one on screen.
   */
  function maskedShape(element, style, rect) {
    const declared = [style.maskImage, style.webkitMaskImage]
      .find((value) => value && value !== "none");
    if (!declared) return null;
    const source = String(declared).match(/url\((['"]?)(data:image\/svg\+xml[^)]*?)\1\)/i)?.[2];
    if (!source) return null;

    let markup;
    try {
      const [header, ...body] = source.split(",");
      const payload = body.join(",");
      markup = /;base64/i.test(header) ? atob(payload) : decodeURIComponent(payload);
    } catch {
      return null;
    }
    if (!/^\s*<svg[\s>]/i.test(markup)) return null;

    const paint = style.backgroundColor && style.backgroundColor !== "rgba(0, 0, 0, 0)"
      ? style.backgroundColor
      : style.color;
    // The element is the size the icon is drawn at; the mask's own viewBox is
    // what it is drawn from.
    return markup
      .replace(/\bcurrentColor\b/g, paint)
      .replace(/\bfill=(['"])(?!none)[^'"]*\1/gi, `fill="${paint}"`)
      .replace(/\bstroke=(['"])(?!none)[^'"]*\1/gi, `stroke="${paint}"`)
      .replace(/<svg\b([^>]*)>/i, (match, attributes) => {
        const cleaned = attributes
          .replace(/\s(width|height)=(['"])[^'"]*\2/gi, "")
          .replace(/\sfill=(['"])[^'"]*\1/gi, "");
        return `<svg${cleaned} width="${rounded(rect.width)}" height="${rounded(rect.height)}" fill="${paint}">`;
      });
  }

  const nodeStyle = (style, rect) => ({
    backgroundColor: style.backgroundColor,
    borderTopColor: style.borderTopColor,
    borderRightColor: style.borderRightColor,
    borderBottomColor: style.borderBottomColor,
    borderLeftColor: style.borderLeftColor,
    borderTopWidth: pixels(style.borderTopWidth),
    borderRightWidth: pixels(style.borderRightWidth),
    borderBottomWidth: pixels(style.borderBottomWidth),
    borderLeftWidth: pixels(style.borderLeftWidth),
    // A pill is written "border-radius: 9999px" and a circle "50%", and both
    // compute to a number far larger than the box they round. The browser
    // already draws no more than half the shorter side — 9999 is only a way of
    // writing "as round as it goes" — so the drawn radius is what travels.
    // The raw number is not merely useless downstream, it is refused: a real
    // app's pill buttons failed a whole export for being "greater than 5000".
    borderRadius: Math.min(
      Math.max(
        pixels(style.borderTopLeftRadius),
        pixels(style.borderTopRightRadius),
        pixels(style.borderBottomRightRadius),
        pixels(style.borderBottomLeftRadius)
      ),
      Math.max(0, Math.min(rect?.width ?? 0, rect?.height ?? 0) / 2)
    ),
    opacity: Number.parseFloat(style.opacity || "1"),
    // Shadows are everywhere in a real interface and were dropped entirely, so
    // every card arrived flat. Carried as the browser's own normalised form —
    // colour first, then offsets — for the plugin to turn into effects.
    boxShadow: style.boxShadow && style.boxShadow !== "none" ? String(style.boxShadow).slice(0, 400) : null,
    clipsContent: ["hidden", "clip", "scroll", "auto"].includes(style.overflow)
      || ["hidden", "clip"].includes(style.overflowX)
      || ["hidden", "clip"].includes(style.overflowY)
  });
  const textStyle = (style) => {
    const direction = style.direction === "rtl" ? "rtl" : "ltr";
    const logicalAlign = style.textAlign === "start"
      ? direction === "rtl" ? "right" : "left"
      : style.textAlign === "end"
        ? direction === "rtl" ? "left" : "right"
        : style.textAlign;
    return {
      color: style.color,
      fontSize: pixels(style.fontSize),
      fontWeight: Number.parseInt(style.fontWeight, 10) || 400,
      lineHeight: style.lineHeight === "normal" ? pixels(style.fontSize) * 1.2 : pixels(style.lineHeight),
      letterSpacing: style.letterSpacing === "normal" ? 0 : pixels(style.letterSpacing),
      textAlign: ["left", "center", "right", "justify"].includes(logicalAlign) ? logicalAlign : "left",
      fontFamilies: String(style.fontFamily || "system-ui").split(",")
        .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean),
      fontStyle: style.fontStyle === "italic" ? "italic" : style.fontStyle.startsWith("oblique") ? "oblique" : "normal",
      fontStretch: style.fontStretch || "100%",
      // The screen says HELLO where the markup says hello. Carried as the
      // instruction rather than folded into the text, so the source string
      // stays what the source says — which is what a pull has to edit.
      textCase: ["uppercase", "lowercase", "capitalize"].includes(style.textTransform)
        ? style.textTransform
        : "none",
      whiteSpace: style.whiteSpace || "normal",
      wordBreak: style.wordBreak || "normal",
      overflowWrap: style.overflowWrap || "normal",
      direction,
      writingMode: style.writingMode || "horizontal-tb"
    };
  };

  const normalizedText = (value, whiteSpace) => {
    const source = String(value || "").replace(/\r\n?/g, "\n");
    if (["pre", "pre-wrap", "break-spaces"].includes(whiteSpace)) return source;
    if (whiteSpace === "pre-line") {
      return source.split("\n").map((line) => line.replace(/[\t\f ]+/g, " ").trim()).join("\n").trim();
    }
    return source.replace(/\s+/g, " ").trim();
  };

  const textLines = (range, parentRect) => {
    const rects = [...range.getClientRects()]
      .filter((rect) => rect.width > 0 || rect.height > 0)
      .sort((left, right) => left.top - right.top || left.left - right.left);
    const lines = [];
    for (const rect of rects) {
      const previous = lines.at(-1);
      if (previous && Math.abs((previous.top + previous.height / 2) - (rect.top + rect.height / 2)) < 1) {
        const right = Math.max(previous.left + previous.width, rect.right);
        previous.left = Math.min(previous.left, rect.left);
        previous.top = Math.min(previous.top, rect.top);
        previous.width = right - previous.left;
        previous.height = Math.max(previous.height, rect.height);
      } else {
        lines.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
      }
    }
    return lines.map((rect) => bounds(rect, parentRect));
  };

  const rangeLineCount = (range) => {
    const rects = [...range.getClientRects()]
      .filter((rect) => rect.width > 0 || rect.height > 0)
      .sort((left, right) => left.top - right.top || left.left - right.left);
    let count = 0;
    let previousCenter = -Infinity;
    for (const rect of rects) {
      const center = rect.top + rect.height / 2;
      if (Math.abs(center - previousCenter) >= 1) {
        count += 1;
        previousCenter = center;
      }
    }
    return count;
  };

  const normalizedOffset = (source, offset, whiteSpace) => {
    const prefix = source.slice(0, offset).replace(/\r\n?/g, "\n");
    if (["pre", "pre-wrap", "break-spaces"].includes(whiteSpace)) return prefix.length;
    if (whiteSpace === "pre-line") {
      return prefix.split("\n").map((line) => line.replace(/[\t\f ]+/g, " ")).join("\n").trimStart().length;
    }
    return prefix.replace(/\s+/g, " ").trimStart().length;
  };

  const textLineBreakOffsets = (textNode, source, normalized, whiteSpace, lineCount) => {
    if (lineCount <= 1 || normalized.length <= 1) return [];
    const segments = typeof Intl.Segmenter === "function"
      ? [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(source)]
      : (() => {
          const result = [];
          let index = 0;
          for (const segment of source) {
            result.push({ segment, index });
            index += segment.length;
          }
          return result;
        })();
    const breaks = [];
    for (let targetLine = 2; targetLine <= lineCount; targetLine += 1) {
      let low = 0;
      let high = segments.length - 1;
      let found = -1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const segment = segments[middle];
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, segment.index + segment.segment.length);
        const prefixLines = rangeLineCount(range);
        range.detach();
        if (prefixLines >= targetLine) {
          found = middle;
          high = middle - 1;
        } else {
          low = middle + 1;
        }
      }
      if (found < 0) continue;
      const offset = normalizedOffset(source, segments[found].index, whiteSpace);
      if (offset > 0 && offset < normalized.length && breaks.at(-1) !== offset) breaks.push(offset);
    }
    return breaks;
  };

  const resolvedFontFamily = (style, text) => {
    const families = String(style.fontFamily || "system-ui").split(",")
      .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
      .filter(Boolean);
    const contentSample = String(text || "Hg").trim().slice(0, 32) || "Hg";
    const sample = families.length === 1
      ? Array.from(contentSample.repeat(32)).slice(0, 32).join("")
      : "mmmmmmmmmmlli";
    const specification = `${style.fontStyle || "normal"} ${style.fontWeight || "400"} ${style.fontSize || "16px"}`;
    const generic = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "-apple-system", "BlinkMacSystemFont"]);
    const fontAvailable = (family) => {
      if (!document.fonts.check(`${specification} "${family}"`, sample)) return false;
      const context = document.createElement("canvas").getContext("2d");
      if (!context) return false;
      const comparisonSize = "72px";
      for (const fallback of ["monospace", "sans-serif", "serif"]) {
        context.font = `${style.fontStyle || "normal"} ${style.fontWeight || "400"} ${comparisonSize} ${fallback}`;
        const fallbackWidth = context.measureText(sample).width;
        context.font = `${style.fontStyle || "normal"} ${style.fontWeight || "400"} ${comparisonSize} "${family}", ${fallback}`;
        if (context.measureText(sample).width !== fallbackWidth) return true;
      }
      return false;
    };
    // A font the capture could not render is reported, not refused. Figma has
    // its own library — it very likely holds the font this renderer lacked, and
    // the plugin already picks from what Figma actually has. Throwing here
    // discarded the whole page, shapes and images included, over text that
    // Figma was going to set correctly anyway.
    //
    // What is genuinely unreliable is the *measurement*: widths and line breaks
    // recorded here came from whatever did render. That is what `unavailable`
    // carries, so the plugin can let Figma lay those runs out itself rather
    // than pinning them to a fallback's metrics.
    const unavailable = [];
    for (const family of families) {
      if (generic.has(family)) return { family, unavailable };
      if (fontAvailable(family)) return { family, unavailable };
      unavailable.push(family);
    }
    return { family: "system-ui", unavailable };
  };

  const sourceSelector = (element, inherited) => {
    if (element.id) return `#${element.id}`;
    const className = typeof element.className === "string"
      ? element.className.split(/\s+/).find(Boolean)
      : null;
    return className ? `.${className}` : inherited;
  };

  /**
   * The nodes an element actually draws, following the flattened tree: an open
   * shadow root in place of the host's own children, and a slot's assigned
   * nodes in place of the slot.
   */
  function renderedChildren(element) {
    if (element.shadowRoot) return [...element.shadowRoot.childNodes];
    if (element.tagName === "SLOT" && typeof element.assignedNodes === "function") {
      const assigned = element.assignedNodes({ flatten: true });
      // Nothing was slotted in, so the slot's own children are the fallback
      // content — which is what is on screen.
      return assigned.length > 0 ? assigned : [...element.childNodes];
    }
    return [...element.childNodes];
  }

  /**
   * The same list, with the boxes that are not boxes flattened out of it.
   *
   * A slot and a `display: contents` element generate no box of their own —
   * they measure 0×0 and would be dropped as invisible, taking everything
   * inside them with them. What draws is what they contain, in their place. A
   * component's entire interface sat behind one such slot.
   */
  function drawnChildren(element) {
    const drawn = [];
    for (const child of renderedChildren(element)) {
      if (child.nodeType === Node.ELEMENT_NODE
        && (child.tagName === "SLOT" || getComputedStyle(child).display === "contents")) {
        drawn.push(...drawnChildren(child));
        continue;
      }
      drawn.push(child);
    }
    return drawn;
  }

  function serializeElement(element, parentRect, identity, inheritedSelector = null, measuredAs = null) {
    if (!(element instanceof Element)) return null;
    const rect = measuredAs ?? element.getBoundingClientRect();
    const style = getComputedStyle(element);
    // A root measured against the viewport is exempt from the size test and
    // from it alone: it is a container for what is drawn, not something drawn
    // itself. Hidden is still hidden.
    const drawn = measuredAs
      ? style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0
      : visible(style, rect);
    if (!drawn) return null;
    const selector = sourceSelector(element, inheritedSelector);
    // Where this element was written, when the project was served through a
    // build UI Sync controls. It is the identity the node keeps, and the exact
    // place the pull direction edits — neither has to be inferred from what the
    // node happens to look like.
    const source = element.getAttribute?.("data-ui-sync-src") || null;
    const common = { ...bounds(rect, parentRect), id: identity, selector, name: safeName(element), ...(source ? { source } : {}) };

    if (element instanceof SVGElement && element.tagName.toLowerCase() === "svg") {
      return {
        kind: "svg",
        ...common,
        svg: element.outerHTML.replaceAll("currentColor", style.color)
      };
    }
    if (element instanceof HTMLImageElement) {
      const dataUrl = imageData(element);
      return dataUrl ? { kind: "image", ...common, dataUrl } : null;
    }

    // An icon drawn by a mask is not a box, however much it measures like one.
    const masked = maskedShape(element, style, rect);
    if (masked) return { kind: "svg", ...common, svg: masked };

    const children = [];
    let elementIndex = 0;
    let textIndex = 0;
    // What the browser actually draws, which is not always what the element
    // contains. A component with an open shadow root renders that root instead
    // of its own children, and the children it does have are drawn wherever its
    // slots put them — so walking childNodes alone walks straight past the
    // entire interface of an app built from web components.
    //
    // A closed root cannot be reached by anyone, by design; such a host is
    // captured as whatever it draws on its own, which is usually nothing.
    for (const child of drawnChildren(element)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const sourceText = String(child.textContent || "").replace(/\r\n?/g, "\n");
        const text = normalizedText(sourceText, style.whiteSpace);
        if (!text) continue;
        const range = document.createRange();
        range.selectNodeContents(child);
        const textRect = range.getBoundingClientRect();
        if (!visible(style, textRect)) continue;
        const lineRects = textLines(range, rect);
        const lineCount = Math.max(1, lineRects.length);
        const wrapMode = ["nowrap", "pre"].includes(style.whiteSpace)
          ? "nowrap"
          : sourceText.includes("\n") && ["pre", "pre-wrap", "pre-line", "break-spaces"].includes(style.whiteSpace)
            ? "explicit"
            : "wrap";
        const horizontalPadding = pixels(style.paddingLeft) + pixels(style.paddingRight);
        const layoutWidth = lineCount > 1
          ? Math.max(textRect.width, element.clientWidth - horizontalPadding)
          : textRect.width;
        const measuredStyle = textStyle(style);
        const extraWidth = Math.max(0, layoutWidth - textRect.width);
        const layoutX = rounded((textRect.left - rect.left) - (measuredStyle.textAlign === "right" ? extraWidth : measuredStyle.textAlign === "center" ? extraWidth / 2 : 0));
        const lineBreakOffsets = wrapMode === "wrap"
          ? textLineBreakOffsets(child, sourceText, text, style.whiteSpace, lineCount)
          : [];
        const resolved = resolvedFontFamily(style, text);
        measuredStyle.resolvedFontFamily = resolved.family;
        // Named so the plugin knows this run's geometry was measured with
        // something other than what the page asked for.
        if (resolved.unavailable.length > 0) measuredStyle.unavailableFonts = resolved.unavailable;
        children.push({
          kind: "text",
          id: `${identity}/text:${textIndex++}`,
          selector,
          name: "Text",
          text: text.slice(0, 4000),
          sourceText: sourceText.slice(0, 4000),
          wrapMode,
          lineCount,
          ...(lineRects.length > 0 ? { lineRects } : {}),
          ...(lineBreakOffsets.length > 0 ? { lineBreakOffsets } : {}),
          layoutWidth: rounded(layoutWidth),
          layoutX,
          ...bounds(textRect, rect),
          style: measuredStyle
        });
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const serialized = serializeElement(child, rect, `${identity}/element:${elementIndex++}`, selector);
        if (serialized) children.push(serialized);
      }
    }
    return {
      kind: "element",
      ...common,
      style: nodeStyle(style, rect),
      children
    };
  }

  /**
   * Which element the app draws into, decided by what it drew.
   *
   * Every one of these names is a convention and not a promise — `.app-frame`
   * is this application's own class, `#root` and `#app` are React and Vue
   * habits — and picking the first that merely *matches* put the whole capture
   * on a guess. A real app scanned this way came back with a screenshot and no
   * layers at all: the named element it found was not the one on screen, and a
   * root that draws nothing serialises to nothing, silently.
   *
   * So the names are an order to try, not an answer, and each candidate is
   * kept only if it actually produced layers. The document itself is last,
   * because it always draws something and would otherwise win every time.
   */
  const candidates = [
    ...document.querySelectorAll("[data-ui-sync-root], .app-frame, #root, #app"),
    document.body,
    document.documentElement
  ].filter(Boolean);

  /**
   * A root can measure nothing and still be the page.
   *
   * An application whose interface is entirely position:fixed — which is most
   * desktop applications — leaves both body and html with no height at all: a
   * real one reported 1182×0 and came back with a screenshot and no layers,
   * because the container of everything on screen was judged invisible. What is
   * drawn there is drawn against the viewport, so that is the box to measure
   * from.
   */
  const viewportRect = () => ({
    left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight,
    width: window.innerWidth, height: window.innerHeight
  });

  let attempted = null;
  for (const candidate of candidates) {
    const own = candidate.getBoundingClientRect();
    const rect = own.width >= 1 && own.height >= 1 ? own : viewportRect();
    const tree = serializeElement(candidate, rect, "root", null, rect);
    if (tree?.children?.length > 0) {
      return { width: rounded(rect.width), height: rounded(rect.height), tree };
    }
    attempted = attempted ?? { candidate, rect, tree };
  }

  // Something was found, but it holds nothing: better than refusing, and the
  // emptiness is the caller's to report.
  if (attempted?.tree) {
    return { width: rounded(attempted.rect.width), height: rounded(attempted.rect.height), tree: attempted.tree };
  }

  const bodyRect = document.body.getBoundingClientRect();
  return {
    width: rounded(bodyRect.width || window.innerWidth),
    height: rounded(bodyRect.height || window.innerHeight),
    // Named, because "no layers" on its own sent someone looking in the wrong
    // place for an afternoon.
    error: `Nothing on this page could be captured as layers: ${candidates.length} candidate root${candidates.length === 1 ? "" : "s"} were tried and each drew nothing (the body measured ${Math.round(bodyRect.width)}×${Math.round(bodyRect.height)}).`
  };
}

module.exports = { serializeRenderedApplication };
