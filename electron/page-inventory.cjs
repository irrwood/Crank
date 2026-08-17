const http = require("node:http");
const https = require("node:https");
const path = require("node:path");
const { readFile } = require("node:fs/promises");
const { discoverStates } = require("./state-discovery.cjs");
const { resolveDevCommand, startDevServer } = require("./dev-server.cjs");
const { detectElectronRenderer, startRendererServer } = require("./renderer-server.cjs");
const { discoverJavascriptProjectRoots, scanJavascriptProject } = require("./project-scanner.cjs");
const { describeForeignProject } = require("./foreign-project.cjs");
const { startForeignServer } = require("./foreign-server.cjs");
const { startLocalRendererServer } = require("./static-server.cjs");
const { readdir } = require("node:fs/promises");
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
 * Replays one page — load its route, then click its recipe — and captures it.
 *
 * Shared by the scan and by recapturing a single page on its own, so a page is
 * captured identically however it was asked for. Replaying from a fresh load
 * every time is what makes a page reproducible at all: an earlier click may
 * have switched the language or theme, and that would otherwise be baked in.
 */
async function capturePage(session, { route, recipe = [] }, { withThumbnails = true, withHtml = true, withFigmaTree = true } = {}) {
  if (!withThumbnails) return { thumbnail: null, snapshot: null, reached: true };
  await session.reset?.();
  let reached = await session.goto(route, { patient: true });
  for (const step of recipe) {
    if (!reached) break;
    reached = await session.click(step.locator, { patient: true });
  }
  if (!reached) return { thumbnail: null, snapshot: null, reached: false };
  // A thumbnail keeps the grid quick to draw; the markup is what carries real
  // text, real SVG and readable colour, so both are kept.
  const thumbnail = await captureThumbnail(session);
  const captured = withHtml ? await session.captureHtml() : null;
  const snapshot = captured?.html
    ? { html: captured.html, bytes: captured.html.length, stats: captured.stats }
    : null;
  const figma = withFigmaTree ? await session.captureFigmaTree?.() : null;
  return { thumbnail, snapshot, figmaTree: figma?.tree ? figma : null, reached: true };
}

/**
 * Turns discovered states into pages by revisiting and capturing each one.
 *
 * Capture is the long half — every page is loaded again, waited on and
 * photographed — so it says which page it is on. Without that the window goes
 * silent for minutes once discovery finishes, which reads as having hung.
 */
async function captureStates(session, states, options, onStatus) {
  const pages = [];
  for (const [index, state] of states.entries()) {
    onStatus?.({
      phase: "capturing",
      detail: `Capturing page ${index + 1} of ${states.length} — ${state.name}`
    });
    const { reached, ...shot } = await capturePage(session, state, options);
    const variants = [];
    for (const variant of state.variants ?? []) {
      const { reached: found, ...look } = await capturePage(session, variant, options);
      variants.push({ ...variant, ...look });
    }
    pages.push({ ...state, ...shot, variants });
  }
  return pages;
}

/**
 * Walks one more level out from a page already in an inventory.
 *
 * A scan stops at a fixed depth, and what it did not walk is exactly the
 * unclicked controls of the pages it kept. Continuing from one of them costs a
 * replay of that page rather than of the project, and links back to pages
 * already held are not followed, so the work stays proportional to what is
 * actually new.
 */
async function exploreFromPage(target, page, { pages: held = [], maxStates = 20, onStatus, onProgress, ...options } = {}) {
  const normalized = normalizeTargetUrl(target);
  if (!normalized.ok) return { ok: false, message: normalized.message };
  const session = createDiscoverySession(normalized.origin);
  try {
    const { states, skipped, filtered, inert, start, reached } = await discoverStates(session, {
      from: { route: page.route, recipe: page.recipe ?? [] },
      seenAddresses: held.flatMap((entry) => [entry.route, entry.url].filter(Boolean)),
      // One click further than the page already sits, counted from where it is
      // rather than from the app's root.
      maxDepth: (page.recipe?.length ?? 0) + 1,
      maxStates,
      onProgress
    });
    if (!reached) {
      return { ok: false, message: `Could not reach 「${page.name}」 again — the way back to it has changed. Rescan the project.` };
    }
    // The page walked from is excluded because it *is* that page, not because
    // its id happens to match one already held: an inventory saved by an older
    // version stores an id this walk would never compute again, and comparing
    // the two handed the starting page back as a discovery.
    const knownIds = new Set(held.map((entry) => entry.id));
    const found = states.filter((state) => state !== start && !knownIds.has(state.id));
    return {
      ok: true,
      origin: normalized.origin,
      pages: await captureStates(session, found, options, onStatus),
      skipped,
      filtered,
      inert
    };
  } finally {
    session.close();
  }
}

/**
 * Captures one page again, leaving the rest of the inventory alone.
 *
 * A page can come out wrong on its own — data that had not arrived, an image
 * that had not loaded — and the only remedy was rescanning the whole project,
 * which for a real one is minutes. The recipe is what makes this possible: the
 * page records how to reach itself.
 */
async function recapturePage(target, page, options = {}) {
  const normalized = normalizeTargetUrl(target);
  if (!normalized.ok) return { ok: false, message: normalized.message };
  const session = createDiscoverySession(normalized.origin);
  try {
    const { reached, ...shot } = await capturePage(session, page, options);
    // Say so rather than handing back an emptied page, which would read as a
    // successful capture of a blank screen.
    if (!reached) {
      return {
        ok: false,
        message: page.recipe?.length
          ? `Could not reach 「${page.name}」 again — the way back to it has changed. Rescan the project.`
          : `Nothing answered at ${page.route}. The app may no longer serve this address.`
      };
    }
    // A look that cannot be reached any more keeps what it had; only the page
    // itself failing is worth refusing over.
    const variants = [];
    for (const variant of page.variants ?? []) {
      const { reached: found, ...look } = await capturePage(session, variant, options);
      variants.push(found ? { ...variant, ...look } : variant);
    }
    return { ok: true, page: { ...page, ...shot, variants } };
  } finally {
    session.close();
  }
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
  withHtml = true,
  withFigmaTree = true,
  onProgress,
  onStatus
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

    const { states, skipped, filtered, inert } = await discoverStates(session, {
      routes,
      maxStates,
      maxDepth,
      maxActionsPerState,
      onProgress
    });

    const pages = await captureStates(session, states, { withThumbnails, withHtml, withFigmaTree }, onStatus);

    return {
      ok: true,
      origin,
      pages,
      skipped,
      filtered,
      // Controls that did nothing. When that is every control on the only page
      // found, the app was served without the runtime its screens need.
      inert,
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

/**
 * Scans a project folder: works out how to serve it, serves it, scans it, and
 * shuts down whatever it started.
 *
 * Electron projects are served renderer-only. Running their dev script opens
 * the desktop app and ties the dev server to that window, so closing it would
 * end the scan.
 */
const skipDirectories = new Set([
  "node_modules", ".git", "dist", "build", "out", "coverage", ".next", ".vite",
  ".wrangler", "__pycache__", ".venv", "venv"
]);

/**
 * Finds the pages of a plain static site.
 *
 * No package.json means no dev script and no declared command, but a folder of
 * HTML needs neither — the files only have to be served. Listing them on disk
 * is exact, and beats a sitemap here because a published sitemap carries the
 * production URLs rather than local paths.
 */
async function findStaticSite(root, { maxPages = 200, maxDepth = 4 } = {}) {
  const found = [];
  const walk = async (directory, depth, prefix) => {
    if (found.length >= maxPages || depth > maxDepth) return;
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= maxPages) return;
      if (entry.name.startsWith(".") && entry.name !== ".well-known") continue;
      const next = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (skipDirectories.has(entry.name)) continue;
        await walk(next, depth + 1, `${prefix}${entry.name}/`);
      } else if (/\.html?$/i.test(entry.name)) {
        found.push(`${prefix}${entry.name}`);
      }
    }
  };
  await walk(root, 0, "");
  if (found.length === 0) return null;

  const entry = found.find((page) => page === "index.html")
    ?? found.find((page) => page.endsWith("/index.html"))
    ?? found[0];
  return { entry, pages: found };
}

/**
 * A workspace root is not one app. Its dev script commonly starts several in
 * parallel, each announcing its own address, and whichever answers first would
 * be scanned — the choice would be arbitrary and usually wrong. Offer the
 * runnable packages instead of guessing.
 */
async function findWorkspacePackages(root) {
  let roots = [];
  try {
    roots = await discoverJavascriptProjectRoots(root);
  } catch {
    return [];
  }
  const others = roots.filter((candidate) => path.resolve(candidate) !== path.resolve(root));
  if (others.length < 2) return [];
  const packages = [];
  for (const candidate of others) {
    try {
      const manifest = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
      if (!manifest.scripts || !["dev", "start", "serve", "preview"].some((name) => manifest.scripts[name])) continue;
      packages.push({ root: candidate, name: manifest.name || path.basename(candidate) });
    } catch {}
  }
  return packages.length >= 2 ? packages : [];
}

/**
 * Serves a project however it declares itself, hands the address to `job`, and
 * shuts down whatever it started.
 *
 * A folder has no address of its own, so every operation on one — scanning it,
 * recapturing a single page, walking one page further — has to start the
 * project first and stop it afterwards. That part is identical for all of them
 * and is the only reason those operations were previously impossible to
 * express separately from a full scan.
 */
async function withProjectServer(root, { onStatus, allowWorkspaceRoot = false, ...options } = {}, job) {
  const packages = allowWorkspaceRoot ? [] : await findWorkspacePackages(root);

  // A folder can be a site *and* contain projects — a portfolio with a couple
  // of demos in it. Dropping it means "scan this", so the packages are offered
  // alongside the result rather than instead of it. The picker only takes over
  // when the folder itself has nothing to serve.
  if (packages.length > 0) {
    const runnable = await resolveDevCommand(root);
    const servesItself = runnable.ok || Boolean(await findStaticSite(root, { maxPages: 1 }));
    if (!servesItself) {
      return {
        ok: false,
        reason: "workspace",
        message: "This folder holds several runnable projects. Pick the one to scan.",
        packages
      };
    }
  }

  // Reading the source finds addresses nothing links to — an Electron app's
  // "?view=settings" window has no link into it, so crawling alone can never
  // reach it. Source analysis proposes addresses; the crawl decides what is
  // really there.
  let seedPaths = [];
  try {
    const scanned = await scanJavascriptProject(root);
    seedPaths = [...new Set((scanned?.screens ?? []).map((screen) => screen.capturePath).filter(Boolean))];
  } catch {}

  const electron = await detectElectronRenderer(root);
  onStatus?.({ phase: "starting", detail: electron ? "Serving the Electron renderer" : "Starting the project's dev server" });

  const started = electron ? await startRendererServer(root) : await startDevServer(root, { startTimeoutMs: 90_000 });
  if (!started.ok) {
    // UI Sync only knows how to start Node projects. Rather than stopping at
    // "no package.json", report what this project declares about itself so the
    // address is one command away.
    if (started.reason === "no-manifest" || started.reason === "no-dev-script") {
      const foreign = await describeForeignProject(root);
      if (foreign?.commands?.length) {
        onStatus?.({ phase: "starting", detail: `Running this ${foreign.kind} project's own command` });
        const ran = await startForeignServer(root, foreign, { startTimeoutMs: 90_000 });
        if (ran.ok) {
          onStatus?.({ phase: "scanning", detail: ran.attached ? `Reusing ${ran.url}` : `Serving at ${ran.url}` });
          try {
            const result = await job(ran.url, { seedPaths });
            return result.ok ? { ...result, servedBy: ran.command, attached: Boolean(ran.attached) } : result;
          } finally {
            ran.stop?.();
          }
        }
        // Could not run it after all — hand back what the project declares.
        return {
          ok: false,
          reason: "foreign",
          message: `${ran.message} Start this ${foreign.kind} project yourself, then scan its address.`,
          foreign
        };
      }
      // Nothing declared to run, but a folder of HTML can simply be served.
      const staticSite = await findStaticSite(root);
      if (staticSite) {
        onStatus?.({ phase: "starting", detail: `Serving ${staticSite.pages.length} static pages` });
        const server = await startLocalRendererServer(path.join(root, staticSite.entry));
        onStatus?.({ phase: "scanning", detail: `Serving at ${server.origin}` });
        try {
          const result = await job(server.origin, {
            seedPaths: [...new Set([...seedPaths, ...staticSite.pages.map((page) => `/${page}`)])],
            // Enough room for every file found, unless the caller asked for less.
            maxStates: options.maxStates ?? Math.max(60, staticSite.pages.length + 20)
          });
          return result.ok
            ? { ...result, servedBy: `static files (${staticSite.pages.length} pages)`, attached: false, packages }
            : result;
        } finally {
          await server.close();
        }
      }

      if (foreign) {
        return {
          ok: false,
          reason: "foreign",
          message: `UI Sync cannot start a ${foreign.kind} project itself. Start it with one of these, then scan its address.`,
          foreign
        };
      }
    }
    return { ok: false, message: started.message, reason: started.reason, output: started.output ?? null };
  }

  onStatus?.({ phase: "scanning", detail: started.attached ? `Reusing ${started.url}` : `Serving at ${started.url}` });
  try {
    const result = await job(started.url, { seedPaths: [...seedPaths, ...(options.seedPaths ?? [])] });
    return result.ok ? { ...result, servedBy: started.command, attached: Boolean(started.attached) } : result;
  } finally {
    // Never stop a server this operation did not start.
    started.stop?.();
  }
}

async function scanFolder(root, options = {}) {
  const { onStatus, allowWorkspaceRoot, ...forward } = options;
  return withProjectServer(root, options, (url, served) => scanUrl(url, {
    ...forward,
    onStatus,
    seedPaths: served.seedPaths,
    ...(served.maxStates ? { maxStates: served.maxStates } : {})
  }));
}

module.exports = { exploreFromPage, normalizeTargetUrl, parseSitemapPaths, recapturePage, scanFolder, scanUrl, withProjectServer };
