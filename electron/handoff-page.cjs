/**
 * Renders a page inventory as a self-contained handoff page.
 *
 * The deliverable is a file, not a view: one .html that opens in any browser,
 * can be sent to a designer, and carries its own images. Looking at the same
 * screenshots inside this app would hand the user nothing they could keep.
 */

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
.gallery { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 30px 24px; }
figure { margin: 0; display: flex; flex-direction: column; gap: 9px; min-width: 0; }
figure img {
  width: 100%; display: block; border: 1px solid var(--line); border-radius: 10px;
  background: var(--card); cursor: zoom-in;
}
figcaption { display: flex; align-items: baseline; gap: 9px; min-width: 0; }
figcaption .n { color: var(--muted); font-size: 11px; font-variant-numeric: tabular-nums; }
figcaption h2 { margin: 0; font-size: 13px; font-weight: 560; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
figcaption a { margin-left: auto; color: var(--accent); font-size: 11.5px; text-decoration: none; white-space: nowrap; }
.addr { margin: 0; color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.single { max-width: 1280px; margin: 0 auto; }
.single img { width: 100%; border: 1px solid var(--line); border-radius: 12px; background: var(--card); }
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
}
document.addEventListener("click", (event) => {
  const trigger = event.target.closest("[data-target]");
  if (!trigger) return;
  event.preventDefault();
  show(trigger.dataset.target);
});
show(params.get("screen") || "overview");
`;

/**
 * @param inventory result from scanUrl
 * @param meta      { title, generatedAt }
 */
function renderHandoffPage(inventory, { title = "Design handoff", generatedAt = new Date().toISOString() } = {}) {
  const pages = inventory?.pages ?? [];
  const shot = (page, className = "") => (page.thumbnail
    ? `<img class="${className}" src="${escapeHtml(page.thumbnail.dataUrl)}" alt="${escapeHtml(page.name)}" data-target="${escapeHtml(page.id)}">`
    : `<p class="empty">No screenshot was captured for this page.</p>`);

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

  const singles = pages.map((page) => `
    <section data-screen="${escapeHtml(page.id)}" class="single" hidden>
      <div class="meta">
        <h2>${escapeHtml(page.name)}</h2>
        <p class="addr">${escapeHtml(addressOf(page))}</p>
      </div>
      ${shot(page)}
    </section>`).join("");

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

module.exports = { addressOf, escapeHtml, renderHandoffPage };
