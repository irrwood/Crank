const http = require("node:http");
const https = require("node:https");
const { discoverStates } = require("./state-discovery.cjs");
const { createDiscoverySession } = require("./state-discovery-session.cjs");

/**
 * Builds a page inventory from nothing but a URL.
 *
 * Anything debuggable in a browser is in scope — React, Python, Rails, a
 * static folder, an Electron renderer — because discovery only ever talks
 * HTTP. Knowing how to *start* a project is the messy, per-ecosystem part and
 * is deliberately not required here: the app is already running.
 */

function normalizeTargetUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { ok: false, message: "Enter the address your app is running on." };
  const withScheme = /^[a-z]+:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, message: `"${raw}" is not a valid address.` };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return { ok: false, message: "Only http and https addresses can be scanned." };
  }
  // A typo like "ht!tp://nope" otherwise parses as the host "ht!tp".
  const isIpv6 = url.hostname.startsWith("[") && url.hostname.endsWith("]");
  if (!isIpv6 && !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/i.test(url.hostname)) {
    return { ok: false, message: `"${raw}" is not a valid address.` };
  }
  return { ok: true, origin: url.origin, startPath: url.pathname + url.search || "/" };
}

function fetchText(url, { timeout = 4000 } = {}) {
  return new Promise((resolve) => {
    const client = url.startsWith("https:") ? https : http;
    let request;
    try {
      request = client.get(url, { timeout }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          resolve(null);
          return;
        }
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 512_000) request.destroy();
        });
        response.on("end", () => resolve(body));
      });
    } catch {
      resolve(null);
      return;
    }
    request.on("timeout", () => { request.destroy(); resolve(null); });
    request.on("error", () => resolve(null));
  });
}

/**
 * A sitemap is a list of pages the app publishes about itself — no guessing,
 * no framework knowledge. When one exists it beats crawling for reach.
 */
function parseSitemapPaths(xml, origin) {
  if (typeof xml !== "string") return [];
  const paths = [];
  for (const match of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)) {
    try {
      const url = new URL(match[1]);
      if (url.origin !== origin) continue;
      const path = url.pathname + url.search;
      if (!paths.includes(path)) paths.push(path);
    } catch {}
    if (paths.length >= 200) break;
  }
  return paths;
}

async function readSitemap(origin) {
  for (const candidate of ["/sitemap.xml", "/sitemap_index.xml"]) {
    const body = await fetchText(`${origin}${candidate}`);
    const paths = parseSitemapPaths(body, origin);
    if (paths.length > 0) return paths;
  }
  return [];
}

async function captureThumbnail(session, width = 420) {
  const image = await session.capture();
  if (!image || image.isEmpty()) return null;
  const size = image.getSize();
  const scaled = image.resize({ width, height: Math.max(1, Math.round(size.height * (width / size.width))) });
  return { dataUrl: scaled.toDataURL(), width: size.width, height: size.height };
}

/**
 * Scans a running app and returns one entry per distinct visual state.
 * `seedPaths` lets a caller supply addresses it already knows about; they are
 * merged with whatever the sitemap and the crawl turn up.
 */
async function scanUrl(target, {
  seedPaths = [],
  maxStates = 60,
  maxDepth = 1,
  maxActionsPerState = 12,
  withThumbnails = true,
  onProgress
} = {}) {
  const normalized = normalizeTargetUrl(target);
  if (!normalized.ok) return { ok: false, message: normalized.message };
  const { origin, startPath } = normalized;

  const session = createDiscoverySession(origin);
  try {
    const reachable = await session.goto(startPath);
    if (!reachable) {
      return { ok: false, message: `Nothing answered at ${origin}. Start the app, then scan again.` };
    }

    const sitemapPaths = await readSitemap(origin);
    const routes = [...new Set([startPath, ...seedPaths, ...sitemapPaths])];

    const { states, skipped } = await discoverStates(session, {
      routes,
      maxStates,
      maxDepth,
      maxActionsPerState,
      onProgress
    });

    const pages = [];
    for (const state of states) {
      let thumbnail = null;
      if (withThumbnails) {
        // Recapture from the recipe so the shot matches the recorded state
        // rather than whatever the crawl happened to leave on screen.
        let snapshot = await session.goto(state.route);
        for (const step of state.recipe) {
          if (!snapshot) break;
          snapshot = await session.click(step.locator);
        }
        if (snapshot) thumbnail = await captureThumbnail(session);
      }
      pages.push({ ...state, thumbnail });
    }

    return {
      ok: true,
      origin,
      pages,
      skipped,
      sources: {
        sitemap: sitemapPaths.length,
        seeds: seedPaths.length,
        crawled: pages.filter((page) => page.depth > 0).length
      },
      blocked: session.blocked
    };
  } finally {
    session.close();
  }
}

module.exports = { normalizeTargetUrl, parseSitemapPaths, scanUrl };
