/**
 * Renders a page inventory as a self-contained handoff page.
 *
 * The deliverable is a file, not a view: one .html that opens in any browser,
 * can be sent to a designer, and carries its own images. Looking at the same
 * screenshots inside this app would hand the user nothing they could keep.
 */

/**
 * Draws one layer, the same way the app's own preview draws it.
 *
 * The single view used to embed the captured markup — a whole foreign document
 * per page, stylesheet, fonts and all, which is what made a scan of a real
 * portfolio 350MB. Drawing from the layer tree instead costs a fortieth of that
 * and shows what will actually reach Figma, rather than what the browser could
 * still make of the original page.
 */
function drawLayer(layer, paint) {
  const painted = paint.paintLayer(layer);
  const style = escapeHtml(paint.styleText(painted.style));
  if (painted.tag === "img") return `<img alt="" src="${escapeHtml(painted.src)}" style="${style}">`;
  const inside = painted.text !== undefined
    ? escapeHtml(painted.text)
    : painted.children.map((child) => drawLayer(child, paint)).join("");
  return `<div style="${style}">${inside}</div>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function addressOf(page) {
  if (!page.recipe || page.recipe.length === 0) return page.route;
  const steps = page.recipe.map((step) => `click “${step.label || step.locator}”`).join(" → ");
  return `${page.route} → ${steps}`;
}

const styles = `
:root {
  --ink: #16181d; --muted: #6b7280; --line: #e5e7eb; --bg: #fbfbfa; --card: #fff;
  --accent: #3b6cf6;
}
@media (prefers-color-scheme: dark) {
  :root { --ink: #eceef2; --muted: #9aa1ad; --line: #2b2f38; --bg: #16181d; --card: #1d2027; }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif;
}
header {
  position: sticky; top: 0; z-index: 5; background: var(--bg);
  border-bottom: 1px solid var(--line); padding: 20px 32px 0;
}
.title { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.title h1 { margin: 0; font-size: 19px; letter-spacing: -0.01em; }
.title span { color: var(--muted); font-size: 12px; }
nav { display: flex; gap: 4px; overflow-x: auto; padding: 14px 0 0; }
nav button {
  flex: 0 0 auto; border: 0; background: none; color: var(--muted); cursor: pointer;
  padding: 7px 12px; border-radius: 7px 7px 0 0; font: inherit; font-size: 12.5px;
  border-bottom: 2px solid transparent; white-space: nowrap;
}
nav button:hover { color: var(--ink); }
nav button[aria-current="true"] { color: var(--ink); border-bottom-color: var(--accent); font-weight: 560; }
main { padding: 28px 32px 80px; }
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 38px 26px; }
figure { margin: 0; display: flex; flex-direction: column; gap: 9px; min-width: 0; }
figure img {
  width: 100%; display: block; border: 1px solid var(--line); border-radius: 10px;
  background: var(--card); cursor: zoom-in;
  /* Two layers: a tight contact shadow and a wide soft one. A gallery that
     looks finished can be screenshotted straight into a deck. */
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.06), 0 10px 28px rgba(0, 0, 0, 0.09);
  transition: box-shadow 160ms ease, transform 130ms ease;
}
figure:hover img { box-shadow: 0 2px 6px rgba(0, 0, 0, 0.08), 0 22px 52px rgba(0, 0, 0, 0.15); transform: translateY(-3px); }
@media (prefers-color-scheme: dark) {
  figure img { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 12px 34px rgba(0, 0, 0, 0.55); }
  figure:hover img { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.6), 0 26px 60px rgba(0, 0, 0, 0.7); }
}
figcaption { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
figcaption .n { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
figcaption h2 { margin: 0; font-size: 13px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
figcaption a { margin-left: auto; color: var(--accent); font-size: 11.5px; text-decoration: none; white-space: nowrap; }
.addr { margin: 0; color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.single { max-width: 1280px; margin: 0 auto; }
.frame > img { width: 100%; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
.frame { border: 1px solid var(--line); border-radius: 12px; background: #fff; overflow: hidden; }
.frame iframe { width: 100%; height: 78vh; border: 0; background: #fff; display: block; }
/* Drawn at the size it was captured, then scaled to whatever width the page is
   read at. A transform keeps text as text, so it stays sharp when zoomed in. */
.layers { position: relative; transform-origin: top left; }
.layers * { box-sizing: border-box; }
.note { color: var(--muted); font-size: 11.5px; margin: 10px 0 0; }
.shot { position: relative; }
.looks { display: flex; gap: 4px; flex-wrap: wrap; margin-top: 8px; }
.looks button {
  border: 1px solid var(--line); background: var(--card); color: var(--muted);
  border-radius: 999px; padding: 3px 11px; font: inherit; font-size: 11px; cursor: pointer;
}
.looks button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); font-weight: 560; }
.single .meta { display: flex; align-items: baseline; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
.single .meta h2 { margin: 0; font-size: 17px; }
.empty { color: var(--muted); border: 1px dashed var(--line); border-radius: 10px; padding: 40px; text-align: center; }
footer { border-top: 1px solid var(--line); margin-top: 48px; padding: 20px 32px 40px; color: var(--muted); font-size: 11.5px; }
footer ul { margin: 8px 0 0; padding-left: 18px; }
`;

const script = `
const params = new URLSearchParams(location.search);
function show(id) {
  const single = id && id !== "overview";
  document.querySelectorAll("[data-screen]").forEach((node) => {
    node.hidden = single ? node.dataset.screen !== id : node.dataset.screen !== "overview";
  });
  document.querySelectorAll("nav button").forEach((button) => {
    button.setAttribute("aria-current", String(button.dataset.target === (single ? id : "overview")));
  });
  const url = new URL(location.href);
  if (single) url.searchParams.set("screen", id); else url.searchParams.delete("screen");
  history.replaceState(null, "", url);
  window.scrollTo({ top: 0 });
  // A hidden section has no width, so nothing in it could be fitted until now.
  fit();
}
document.addEventListener("click", (event) => {
  const pick = event.target.closest("[data-look-pick]");
  if (pick) {
    event.preventDefault();
    const group = pick.closest(".shot");
    const wanted = pick.dataset.lookPick;
    group.querySelectorAll("[data-look]").forEach((look) => { look.hidden = look.dataset.look !== wanted; });
    group.querySelectorAll("[data-look-pick]").forEach((button) => {
      button.setAttribute("aria-pressed", String(button.dataset.lookPick === wanted));
    });
    fit();
    return;
  }
  const trigger = event.target.closest("[data-target]");
  if (!trigger) return;
  event.preventDefault();
  show(trigger.dataset.target);
});
/**
 * Fits each drawing to the width it is being read at.
 *
 * The layers are placed at the pixel positions they were captured at, which is
 * wider than most windows. Scaling the whole drawing keeps every position true
 * to the capture, and because it is a transform rather than a resize, the text
 * is still text at any zoom.
 */
function fit() {
  document.querySelectorAll(".layers").forEach((drawing) => {
    const captured = parseFloat(drawing.style.width) || 0;
    const available = drawing.parentElement.clientWidth;
    if (!captured || !available) return;
    const scale = Math.min(1, available / captured);
    drawing.style.transform = "scale(" + scale + ")";
    // The transform does not change how much room the element asks for, so the
    // frame is told the drawn height directly or it keeps the unscaled one.
    drawing.parentElement.style.height = Math.round((parseFloat(drawing.style.height) || 0) * scale) + "px";
  });
}
window.addEventListener("resize", fit);
show(params.get("screen") || "overview");
fit();
`;

/**
 * @param inventory result from scanUrl
 * @param meta      { title, generatedAt }
 */
// Loaded rather than required: what a layer looks like is decided in one place
// the window also draws from, and that place is a module.
async function renderHandoffPage(inventory, { title = "Design handoff", generatedAt = new Date().toISOString() } = {}) {
  const paint = await import("../shared/layer-paint.js");
  const pages = inventory?.pages ?? [];
  // A page and its re-skins share one slot: the same page in dark mode or
  // another language is not another page, so the looks are toggled in place.
  const shot = (page) => {
    const looks = [{ id: page.id, name: "Default", thumbnail: page.thumbnail }, ...(page.variants ?? [])];
    const usable = looks.filter((look) => look.thumbnail);
    if (usable.length === 0) return `<p class="empty">No screenshot was captured for this page.</p>`;
    const images = usable.map((look, index) =>
      `<img src="${escapeHtml(look.thumbnail.dataUrl)}" alt="${escapeHtml(page.name)}"
        data-target="${escapeHtml(page.id)}" data-look="${index}"${index === 0 ? "" : " hidden"}>`).join("");
    const toggle = usable.length > 1
      ? `<div class="looks">${usable.map((look, index) =>
          `<button type="button" data-look-pick="${index}"${index === 0 ? ' aria-pressed="true"' : ""}>${escapeHtml(look.name)}</button>`
        ).join("")}</div>`
      : "";
    return `<div class="shot">${images}${toggle}</div>`;
  };

  const gallery = pages.map((page, index) => `
      <figure>
        ${shot(page)}
        <figcaption>
          <span class="n">${String(index + 1).padStart(2, "0")}</span>
          <h2>${escapeHtml(page.name)}</h2>
          <a href="?screen=${encodeURIComponent(page.id)}" data-target="${escapeHtml(page.id)}">Open ↗</a>
        </figcaption>
        <p class="addr">${escapeHtml(addressOf(page))}</p>
      </figure>`).join("");

  // The single view draws the layers, not a picture of them: sharp at any zoom,
  // text selectable, SVG still vector. The grid keeps thumbnails so it stays
  // quick to draw.
  const singles = pages.map((page) => {
    const looks = [{ id: page.id, layerTree: page.layerTree, name: "Default", snapshot: page.snapshot, thumbnail: page.thumbnail },
      ...(page.variants ?? [])];
    const frames = looks.map((look, index) => {
      // The page itself when it was captured — sharp at any zoom, text
      // selectable, SVG still vector. The layers are the fallback, and they are
      // an approximation: the boxes, the type and the colours, not the gradient.
      if (look.snapshot?.html) {
        return `<iframe data-look="${index}"${index === 0 ? "" : " hidden"} loading="lazy"
          sandbox="allow-same-origin" title="${escapeHtml(page.name)}"
          srcdoc="${escapeHtml(look.snapshot.html)}"></iframe>`;
      }
      const tree = look.layerTree?.tree;
      if (tree) {
        return `<div class="layers" data-look="${index}"${index === 0 ? "" : " hidden"}
          style="height:${Math.round(tree.height || 0)}px;width:${Math.round(tree.width || 0)}px">${drawLayer(tree, paint)}</div>`;
      }
      if (look.thumbnail) {
        return `<img data-look="${index}"${index === 0 ? "" : " hidden"}
          src="${escapeHtml(look.thumbnail.dataUrl)}" alt="${escapeHtml(page.name)}">`;
      }
      return `<p class="empty" data-look="${index}"${index === 0 ? "" : " hidden"}>Nothing was captured for this page.</p>`;
    }).join("");
    const toggle = looks.length > 1
      ? `<div class="looks">${looks.map((look, index) =>
          `<button type="button" data-look-pick="${index}"${index === 0 ? ' aria-pressed="true"' : ""}>${escapeHtml(look.name)}</button>`
        ).join("")}</div>`
      : "";
    const notes = page.snapshot?.stats?.rasterised?.length
      ? `<p class="note">${page.snapshot.stats.rasterised.length} area(s) could only be captured as pixels: ${escapeHtml(page.snapshot.stats.rasterised.join(", "))}. Everything else is live markup.</p>`
      : page.layerTree?.error
        ? `<p class="note">These layers could not be read: ${escapeHtml(page.layerTree.error)}</p>`
        : "";
    return `
    <section data-screen="${escapeHtml(page.id)}" class="single" hidden>
      <div class="meta">
        <h2>${escapeHtml(page.name)}</h2>
        <p class="addr">${escapeHtml(addressOf(page))}</p>
      </div>
      ${toggle}
      <div class="shot frame">${frames}</div>
      ${notes}
    </section>`;
  }).join("");

  const tabs = [`<button data-target="overview" aria-current="true">All pages</button>`]
    .concat(pages.map((page) => `<button data-target="${escapeHtml(page.id)}">${escapeHtml(page.name)}</button>`))
    .join("");

  const filtered = (inventory?.filtered ?? []).map((item) =>
    `<li>${escapeHtml(item.label)} — changed ${Math.round(item.magnitude * 1000) / 10}% of the screen</li>`).join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${styles}</style>
</head>
<body>
<header>
  <div class="title">
    <h1>${escapeHtml(title)}</h1>
    <span>${pages.length} pages · ${escapeHtml(inventory?.origin ?? "")} · ${escapeHtml(generatedAt.slice(0, 10))}</span>
  </div>
  <nav>${tabs}</nav>
</header>
<main>
  <div data-screen="overview"><div class="gallery">${gallery || '<p class="empty">No pages were found.</p>'}</div></div>
  ${singles}
</main>
<footer>
  <p>Captured from a running app. Each address below reproduces its page from a fresh load.</p>
  ${filtered ? `<p>Left out for changing too little of the screen to count as a page:</p><ul>${filtered}</ul>` : ""}
</footer>
<script>${script}</script>
</body>
</html>`;
}

module.exports = { addressOf, drawLayer, escapeHtml, renderHandoffPage };
