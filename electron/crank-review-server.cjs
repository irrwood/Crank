const { randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const { z } = require("zod/v4");
const { parseSourceAnchor } = require("./source-anchors.cjs");

/**
 * Serves one captured Crank screen as a local DOM review surface.
 *
 * Codex's native annotation overlay belongs to its Browser surface, not to an
 * arbitrary MCP App iframe. A giant canvas would preserve the pixels but erase
 * the identity underneath a comment, so this server draws the same captured
 * layer tree as Crank and leaves a deterministic `data-crank-id` on every DOM
 * node. Pointer hits are written back as the active repository selection; the
 * Browser owns the comment UI, while Crank owns what the comment points at.
 *
 * The server binds only to loopback, uses an unguessable per-review URL, loads
 * no network resources, and validates the only write crossing the HTTP edge.
 */

const sourceRefSchema = z.object({
  file: z.string().min(1).max(1000),
  line: z.number().int().min(1).max(10_000_000),
  column: z.number().int().min(1).max(100_000),
  component: z.string().min(1).max(300).optional()
});
const reviewSelectionSchema = z.object({
  screenId: z.string().min(1).max(200),
  nodeId: z.string().min(1).max(1000),
  name: z.string().max(300).optional(),
  source: z.string().max(1400).optional(),
  pointer: z.object({
    x: z.number().finite().min(-100_000).max(100_000),
    y: z.number().finite().min(-100_000).max(100_000),
    clientX: z.number().finite().min(-100_000).max(100_000),
    clientY: z.number().finite().min(-100_000).max(100_000)
  })
});
const reviewSessionSchema = z.object({
  inventoryId: z.string().regex(/^[a-f0-9]{16}$/),
  locale: z.enum(["en", "zh-CN"]),
  screen: z.object({
    id: z.string().min(1).max(200),
    name: z.string().min(1).max(200),
    route: z.string().max(2000).optional(),
    sourceRef: sourceRefSchema.optional()
  }),
  document: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("layers"),
      width: z.number().finite().positive().max(100_000),
      height: z.number().finite().positive().max(100_000),
      layerTree: z.object({
        width: z.number().finite().positive().max(100_000),
        height: z.number().finite().positive().max(100_000),
        tree: z.record(z.string(), z.unknown())
      }),
      dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(30_000_000).optional()
    }),
    z.object({
      kind: z.literal("image"),
      width: z.number().finite().positive().max(100_000),
      height: z.number().finite().positive().max(100_000),
      dataUrl: z.string().regex(/^data:image\/[a-z0-9.+-]+;base64,/i).max(30_000_000)
    })
  ]),
  onSelection: z.custom((value) => typeof value === "function", "onSelection must be a function")
});

const copy = {
  en: {
    review: "Codex review",
    hint: "Select an element, then use Codex Browser annotation to describe the change.",
    selected: "Selected",
    noSource: "No deterministic source reference was captured for this element.",
    imageOnly: "This screen is a raster fallback. Region annotations remain available, but element-level source identity is unavailable."
  },
  "zh-CN": {
    review: "Codex 审阅",
    hint: "先选择页面元素，再用 Codex Browser 标注说明需要怎样修改。",
    selected: "已选择",
    noSource: "这个元素没有抓取到确定的源码位置。",
    imageOnly: "这个页面使用位图回退；仍可框选区域，但无法获得元素级源码定位。"
  }
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function jsonForScript(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function layerAttributes(layer) {
  const values = [
    ["data-crank-id", layer.id],
    ["data-crank-layer-id", layer.id],
    ["data-source", layer.source],
    ["data-component", layer.name]
  ];
  return values.filter(([, value]) => typeof value === "string" && value)
    .map(([name, value]) => `${name}="${escapeHtml(value)}"`).join(" ");
}

function hasImageLayer(value) {
  if (!value || typeof value !== "object") return false;
  if (value.kind === "image" && typeof value.dataUrl === "string" && value.dataUrl.length > 0) return true;
  return Array.isArray(value.children) && value.children.some(hasImageLayer);
}

async function drawLayer(layer, paint) {
  const painted = paint.paintLayer(layer);
  const style = escapeHtml(paint.styleText(painted.style));
  const attributes = layerAttributes(layer);
  if (painted.tag === "img") {
    return `<img alt="" ${attributes} src="${escapeHtml(painted.src)}" style="${style}">`;
  }
  const inside = painted.text !== undefined
    ? escapeHtml(painted.text)
    : (await Promise.all(painted.children.map((child) => drawLayer(child, paint)))).join("");
  return `<div ${attributes} style="${style}">${inside}</div>`;
}

async function renderReviewDocument(session, token) {
  const safe = reviewSessionSchema.parse(session);
  const text = copy[safe.locale];
  const paint = await import("../shared/layer-paint.js");
  const screenAttrs = [
    `data-crank-id="${escapeHtml(safe.screen.id)}"`,
    `data-component="${escapeHtml(safe.screen.sourceRef?.component ?? safe.screen.name)}"`,
    safe.screen.sourceRef
      ? `data-source="${escapeHtml(`${safe.screen.sourceRef.file}:${safe.screen.sourceRef.line}:${safe.screen.sourceRef.column}`)}"`
      : ""
  ].filter(Boolean).join(" ");
  let content;
  if (safe.document.kind === "layers") {
    const layers = await drawLayer(safe.document.layerTree.tree, paint);
    content = safe.document.dataUrl
      ? `<img alt="" aria-hidden="true" class="reference" src="${escapeHtml(safe.document.dataUrl)}"><div class="vector-overlay${hasImageLayer(safe.document.layerTree.tree) ? "" : " is-hit-map"}">${layers}</div>`
      : layers;
  } else {
    content = `<img alt="${escapeHtml(safe.screen.name)}" src="${escapeHtml(safe.document.dataUrl)}">`;
  }
  const bootstrap = {
    screenId: safe.screen.id,
    token,
    selectedLabel: text.selected,
    noSourceLabel: text.noSource
  };

  return `<!doctype html>
<html lang="${safe.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(safe.screen.name)} · ${escapeHtml(text.review)}</title>
<style>
:root { color-scheme: light dark; --bg:#f5f5f3; --panel:rgba(255,255,255,.9); --ink:#171817; --muted:#73756f; --line:rgba(24,25,23,.12); --accent:#326bea; }
@media (prefers-color-scheme: dark) { :root { --bg:#171816; --panel:rgba(30,31,29,.92); --ink:#f2f2ef; --muted:#a5a79f; --line:rgba(255,255,255,.14); } }
* { box-sizing:border-box; }
html,body { margin:0; min-height:100%; background:var(--bg); color:var(--ink); font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif; }
header { position:sticky; top:0; z-index:10000; min-height:58px; display:flex; align-items:center; gap:18px; padding:10px 18px; background:var(--panel); border-bottom:1px solid var(--line); backdrop-filter:blur(18px); }
.identity { min-width:0; display:grid; gap:2px; }
.identity strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.identity small,.hint { color:var(--muted); }
.hint { margin-left:auto; text-align:right; max-width:520px; }
.viewport { min-height:calc(100vh - 58px); overflow:auto; padding:32px; }
.sheet-space { margin:0 auto; position:relative; }
.sheet { position:relative; transform-origin:top left; background:white; border-radius:12px; overflow:hidden; box-shadow:0 18px 60px rgba(0,0,0,.14); }
.sheet > img { display:block; width:100%; height:100%; object-fit:contain; }
.reference,.vector-overlay { position:absolute; inset:0; width:100%; height:100%; }
.reference { object-fit:fill !important; pointer-events:none; user-select:none; }
.vector-overlay [data-crank-layer-id]:not(img) { background:transparent !important; border-color:transparent !important; box-shadow:none !important; backdrop-filter:none !important; filter:none !important; }
.vector-overlay.is-hit-map [data-crank-layer-id] { color:transparent !important; text-shadow:none !important; }
.vector-overlay.is-hit-map img { opacity:0 !important; }
.sheet [data-crank-id] { cursor:crosshair; }
.sheet [data-crank-id].is-crank-selected { outline:2px solid var(--accent) !important; outline-offset:2px; }
.selection { position:fixed; z-index:10001; left:18px; bottom:18px; max-width:min(560px,calc(100vw - 36px)); display:none; gap:4px; padding:10px 12px; border:1px solid var(--line); border-radius:10px; background:var(--panel); box-shadow:0 10px 32px rgba(0,0,0,.13); backdrop-filter:blur(18px); }
.selection.is-visible { display:grid; }
.selection strong,.selection code { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.selection code { color:var(--muted); font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace; }
.fallback { max-width:800px; margin:18px auto 0; color:var(--muted); text-align:center; }
</style>
</head>
<body>
<header>
  <div class="identity"><strong>${escapeHtml(safe.screen.name)}</strong><small>${escapeHtml(safe.screen.route || "/")}</small></div>
  <div class="hint">${escapeHtml(text.hint)}</div>
</header>
<main class="viewport" id="viewport">
  <div class="sheet-space" id="sheet-space" style="width:${safe.document.width}px;height:${safe.document.height}px">
    <div class="sheet" id="sheet" ${screenAttrs} style="width:${safe.document.width}px;height:${safe.document.height}px">${content}</div>
  </div>
  ${safe.document.kind === "image" ? `<p class="fallback">${escapeHtml(text.imageOnly)}</p>` : ""}
</main>
<aside class="selection" id="selection"><strong></strong><code></code></aside>
<script>
const review = ${jsonForScript(bootstrap)};
const sheet = document.getElementById("sheet");
const space = document.getElementById("sheet-space");
const selection = document.getElementById("selection");
function fit() {
  const available = Math.max(240, document.documentElement.clientWidth - 64);
  const scale = Math.min(1, available / ${safe.document.width});
  sheet.style.transform = "scale(" + scale + ")";
  space.style.width = Math.round(${safe.document.width} * scale) + "px";
  space.style.height = Math.round(${safe.document.height} * scale) + "px";
}
function sourceRef(value) {
  const match = /^(.+):(\\d+):(\\d+)$/.exec(value || "");
  return match ? { file:match[1], line:Number(match[2]), column:Number(match[3]) } : null;
}
document.addEventListener("pointerdown", (event) => {
  const target = event.target.closest("[data-crank-id]");
  if (!target || !sheet.contains(target)) return;
  document.querySelectorAll(".is-crank-selected").forEach((node) => node.classList.remove("is-crank-selected"));
  target.classList.add("is-crank-selected");
  const rect = sheet.getBoundingClientRect();
  const scale = rect.width / ${safe.document.width};
  const payload = {
    screenId:review.screenId,
    nodeId:target.dataset.crankId,
    name:target.dataset.component || undefined,
    source:target.dataset.source || undefined,
    pointer:{ x:(event.clientX-rect.left)/scale, y:(event.clientY-rect.top)/scale, clientX:event.clientX, clientY:event.clientY }
  };
  selection.classList.add("is-visible");
  selection.querySelector("strong").textContent = review.selectedLabel + ": " + (payload.name || payload.nodeId);
  selection.querySelector("code").textContent = payload.source || review.noSourceLabel;
  fetch(location.pathname + "/selection", { method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(payload) }).catch(() => {});
}, true);
window.addEventListener("resize", fit);
fit();
</script>
</body>
</html>`;
}

function readJson(request, limit = 32_768) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Review selection payload is too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new Error("Review selection payload is not valid JSON.")); }
    });
    request.on("error", reject);
  });
}

function createCrankReviewServer({ createToken = () => randomBytes(24).toString("hex") } = {}) {
  const sessions = new Map();
  let server = null;
  let origin = null;

  async function listen() {
    if (origin) return origin;
    server = createServer(async (request, response) => {
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-security-policy", "default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; frame-ancestors 'self'");
      response.setHeader("x-content-type-options", "nosniff");
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const match = /^\/review\/([a-f0-9]{48})(\/selection)?$/.exec(url.pathname);
      const session = match ? sessions.get(match[1]) : null;
      if (!session) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }
      if (request.method === "GET" && !match[2]) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(await renderReviewDocument(session, match[1]));
        return;
      }
      if (request.method === "POST" && match[2]) {
        try {
          const hit = reviewSelectionSchema.parse(await readJson(request));
          const anchor = hit.source ? parseSourceAnchor(hit.source) : null;
          const sourceRef = anchor
            ? { ...anchor, ...(hit.name ? { component: hit.name } : {}) }
            : session.screen.sourceRef ?? null;
          await session.onSelection({
            kind: "node",
            screenId: hit.screenId,
            nodeId: hit.nodeId,
            ...(hit.name ? { name: hit.name } : {}),
            sourceRef,
            pointer: hit.pointer
          });
          response.writeHead(204);
          response.end();
        } catch (error) {
          response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
        }
        return;
      }
      response.writeHead(405, { allow: "GET, POST" });
      response.end();
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    origin = `http://127.0.0.1:${address.port}`;
    return origin;
  }

  return {
    async open(input) {
      const session = reviewSessionSchema.parse(input);
      const token = createToken();
      // A review carries a complete captured tree. Bound old tabs so repeatedly
      // opening screens cannot turn the long-lived MCP sidecar into an archive
      // of every page the user has ever inspected.
      if (sessions.size >= 12) sessions.delete(sessions.keys().next().value);
      sessions.set(token, session);
      return { url: `${await listen()}/review/${token}`, token };
    },
    async close() {
      sessions.clear();
      origin = null;
      if (!server) return;
      const active = server;
      server = null;
      await new Promise((resolve, reject) => active.close((error) => error ? reject(error) : resolve()));
    }
  };
}

module.exports = {
  createCrankReviewServer,
  escapeHtml,
  renderReviewDocument,
  reviewSelectionSchema
};
