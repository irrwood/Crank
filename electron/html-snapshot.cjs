/**
 * Captures a rendered page as self-contained HTML.
 *
 * A screenshot is a dead image: blurry when zoomed, text cannot be selected,
 * and no colour or spacing can be read back. The real markup stays sharp at
 * any size and keeps its text and SVG intact.
 *
 * Rasterising is a last resort, used only where the browser holds pixels that
 * no markup can express — a canvas's bitmap, a video frame. Everything else
 * (SVG charts above all) is preserved as real nodes, and every fallback is
 * counted so a snapshot that quietly degraded can be spotted.
 */

const MAX_ASSET_BYTES = 2_500_000;
const MAX_TOTAL_ASSET_BYTES = 40_000_000;

/**
 * Runs inside the page. Serialised with toString(), so it must be
 * self-contained and use no closure variables.
 */
async function captureHtmlDocument(limits) {
  const { maxAssetBytes, maxTotalAssetBytes } = limits;
  const stats = {
    stylesheets: 0,
    inlinedAssets: 0,
    rasterised: [],
    skippedAssets: [],
    svgPreserved: 0,
    bytes: 0
  };
  let assetBudget = maxTotalAssetBytes;

  const asDataUrl = async (url) => {
    if (!url || url.startsWith("data:")) return url || null;
    let absolute;
    try {
      absolute = new URL(url, location.href).href;
    } catch {
      return null;
    }
    if (new URL(absolute).origin !== location.origin) {
      stats.skippedAssets.push(absolute.slice(0, 120));
      return null;
    }
    try {
      const response = await fetch(absolute);
      if (!response.ok) return null;
      const blob = await response.blob();
      if (blob.size > maxAssetBytes || blob.size > assetBudget) {
        stats.skippedAssets.push(`${absolute.slice(0, 100)} (${Math.round(blob.size / 1024)}KB)`);
        return null;
      }
      assetBudget -= blob.size;
      stats.inlinedAssets += 1;
      return await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  };

  // --- stylesheets -------------------------------------------------------
  const cssTexts = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let text = "";
    try {
      text = Array.from(sheet.cssRules).map((rule) => rule.cssText).join("\n");
    } catch {
      if (sheet.href) {
        try {
          const response = await fetch(sheet.href);
          if (response.ok) text = await response.text();
        } catch {}
      }
    }
    if (!text) continue;
    stats.stylesheets += 1;
    // Resolve url() against the sheet's own location before inlining.
    const base = sheet.href || location.href;
    const references = [...new Set(Array.from(text.matchAll(/url\((['"]?)([^'")]+)\1\)/g)).map((match) => match[2]))];
    for (const reference of references) {
      if (reference.startsWith("data:") || reference.startsWith("#")) continue;
      let absolute;
      try {
        absolute = new URL(reference, base).href;
      } catch {
        continue;
      }
      const inlined = await asDataUrl(absolute);
      if (inlined) text = text.split(reference).join(inlined);
    }
    cssTexts.push(text);
  }

  // --- mark originals so clones can be matched back ----------------------
  const marker = "data-ui-sync-node";
  const originals = Array.from(document.querySelectorAll("canvas, img, video, input, textarea, select, iframe"));
  originals.forEach((element, index) => element.setAttribute(marker, String(index)));

  const clone = document.documentElement.cloneNode(true);

  const find = (index) => clone.querySelector(`[${marker}="${index}"]`);

  for (const [index, element] of originals.entries()) {
    const target = find(index);
    if (!target) continue;
    const tag = element.tagName.toLowerCase();

    if (tag === "canvas") {
      // The only honest fallback: a canvas holds pixels, not markup.
      let dataUrl = null;
      try {
        if (element.width > 0 && element.height > 0) dataUrl = element.toDataURL("image/png");
      } catch {}
      const replacement = document.createElement("img");
      if (dataUrl) {
        replacement.src = dataUrl;
        stats.rasterised.push(`canvas ${element.width}×${element.height}`);
      } else {
        stats.skippedAssets.push("canvas (could not be read)");
      }
      replacement.setAttribute("style", `width:${element.clientWidth}px;height:${element.clientHeight}px;display:block`);
      target.replaceWith(replacement);
      continue;
    }

    if (tag === "img") {
      const inlined = await asDataUrl(element.currentSrc || element.src);
      if (inlined) target.setAttribute("src", inlined);
      else target.removeAttribute("src");
      target.removeAttribute("srcset");
      continue;
    }

    if (tag === "video") {
      const replacement = document.createElement("img");
      try {
        const frame = document.createElement("canvas");
        frame.width = element.videoWidth || element.clientWidth;
        frame.height = element.videoHeight || element.clientHeight;
        frame.getContext("2d").drawImage(element, 0, 0, frame.width, frame.height);
        replacement.src = frame.toDataURL("image/png");
        stats.rasterised.push("video frame");
      } catch {
        stats.skippedAssets.push("video");
      }
      replacement.setAttribute("style", `width:${element.clientWidth}px;height:${element.clientHeight}px;display:block`);
      target.replaceWith(replacement);
      continue;
    }

    if (tag === "iframe") {
      // Cannot be reproduced without its own document; leave an empty frame
      // of the right size rather than pretending it rendered.
      const placeholder = document.createElement("div");
      placeholder.setAttribute("style", `width:${element.clientWidth}px;height:${element.clientHeight}px`);
      target.replaceWith(placeholder);
      stats.skippedAssets.push("iframe");
      continue;
    }

    // Form state lives in properties, not attributes, so it has to be written
    // back or every field would snapshot as empty.
    if (tag === "input") {
      if (element.type === "checkbox" || element.type === "radio") {
        if (element.checked) target.setAttribute("checked", "");
        else target.removeAttribute("checked");
      } else if (element.value) {
        target.setAttribute("value", element.value);
      }
    } else if (tag === "textarea") {
      target.textContent = element.value;
    } else if (tag === "select") {
      const options = target.querySelectorAll("option");
      Array.from(element.options).forEach((option, position) => {
        if (!options[position]) return;
        if (option.selected) options[position].setAttribute("selected", "");
        else options[position].removeAttribute("selected");
      });
    }
  }

  originals.forEach((element) => element.removeAttribute(marker));
  clone.querySelectorAll(`[${marker}]`).forEach((element) => element.removeAttribute(marker));

  stats.svgPreserved = clone.querySelectorAll("svg").length;

  // Scripts would re-run and overwrite the captured state; the snapshot is
  // meant to be exactly what was on screen.
  clone.querySelectorAll("script, noscript").forEach((element) => element.remove());
  clone.querySelectorAll('link[rel~="stylesheet"], link[rel~="preload"], link[rel~="modulepreload"]')
    .forEach((element) => element.remove());

  const head = clone.querySelector("head") || clone.insertBefore(document.createElement("head"), clone.firstChild);
  const style = document.createElement("style");
  style.textContent = cssTexts.join("\n");
  head.appendChild(style);

  const html = `<!doctype html>\n${clone.outerHTML}`;
  stats.bytes = html.length;
  return { html, stats, viewport: { width: window.innerWidth, height: document.documentElement.scrollHeight } };
}

module.exports = { MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, captureHtmlDocument };
