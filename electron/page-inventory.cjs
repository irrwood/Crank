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
const { createAttachedSession, listTargets } = require("./cdp-session.cjs");
const { describeAppBundle, launchAppBundle, looksLikeAppBundle } = require("./app-bundle.cjs");
const { isAppOrigin, originOf, routeWithin } = require("./page-origin.cjs");

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
  // An installed app has no server to ask.
  if (isAppOrigin(origin)) return [];
  for (const candidate of ["/sitemap.xml", "/sitemap_index.xml"]) {
    const body = await fetchText(`${origin}${candidate}`);
    const paths = parseSitemapPaths(body, origin);
    if (paths.length > 0) return paths;
  }
  return [];
}

async function captureThumbnail(session, width = 1220) {
  // Wide enough to survive being looked at, and WebP so that costs nothing:
  // measured on a real page, 1220 wide encodes to what the old 420-wide PNG
  // did. Falls back to the PNG when the page has no WebP encoder to lend.
  const raster = await session.captureRaster?.({ width });
  if (raster) return raster;
  const image = await session.capture();
  if (!image || image.isEmpty()) return null;
  const size = image.getSize();
  const scaled = image.resize({ width, height: Math.max(1, Math.round(size.height * (width / size.width))) });
  return { dataUrl: scaled.toDataURL(), width: scaled.getSize().width, height: scaled.getSize().height };
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
  // Three views of one visit, each for a different distance. The thumbnail
  // keeps a grid quick to draw. The layer tree is what a card draws and what
  // reaches Figma. The markup is the page itself, for opening one and reading
  // it — the only one of the three that is not an approximation.
  //
  // Keeping all three used to mean keeping every picture three times, which is
  // what made a thirty-page scan 350MB. It does not any more: the pictures are
  // stored once by content, and all three point at the same ones.
  const thumbnail = await captureThumbnail(session);
  const captured = withHtml ? await session.captureHtml() : null;
  const snapshot = captured?.html
    ? { html: captured.html, bytes: captured.html.length, stats: captured.stats }
    : null;
  const figma = withFigmaTree ? await session.captureFigmaTree?.() : null;
  return { thumbnail, snapshot, layerTree: figma?.tree ? figma : null, reached: true };
}

/**
 * Scans UI Sync's own interface, with UI Sync's own data behind it.
 *
 * The general paths cannot do this one. Serving the interface gets a copy with
 * no bridge and therefore no projects; attaching over a debugging port needs a
 * second instance, which the single-instance lock refuses. Neither limitation
 * applies to an application scanning itself: it has its own preload, and can
 * open its own window.
 */
async function scanSelf({ appRoot, onStatus, ...options } = {}) {
  onStatus?.({ phase: "starting", detail: "Opening Crank's own interface" });
  const { createSelfScanSession } = require("./self-scan-session.cjs");
  const { origin, session } = await createSelfScanSession({ appRoot });
  const result = await runScan(session, origin, "/", { ...options, onStatus });
  return result.ok
    ? { ...result, servedBy: "Crank itself, through a bridge that only reads", attached: false }
    : result;
}

/**
 * Scans the app already running behind a debugging port.
 *
 * The pages worth handing to a designer are the ones with real content in
 * them, and for an app whose screens are drawn from a process — an Electron
 * renderer, a front end with a backend — those exist only in the copy the
 * person is actually running. Serving the interface again produces the same
 * app with nothing in it.
 */
async function scanAttached(port, { targetId = null, onStatus, ...options } = {}) {
  const safePort = Number(port);
  if (!Number.isInteger(safePort) || safePort < 1 || safePort > 65535) {
    return { ok: false, message: "That is not a port number." };
  }
  let targets;
  try {
    targets = await listTargets(safePort);
  } catch (cause) {
    return {
      ok: false,
      message: `Nothing is listening for a debugger on port ${safePort}. Start the app with --remote-debugging-port=${safePort}, then try again.`
    };
  }
  if (targets.length === 0) {
    return { ok: false, message: `Port ${safePort} answered, but has no application window open.` };
  }
  const target = targetId ? targets.find((entry) => entry.id === targetId) ?? targets[0] : targets[0];
  onStatus?.({ phase: "starting", detail: `Attached to ${target.title}` });

  let origin;
  let startPath;
  try {
    const shown = new URL(target.url);
    origin = originOf(shown);
    // Relative to the app rather than to the disk, for a window loaded from a
    // file: the folders above it are where the app was installed, not a route.
    startPath = routeWithin(shown.pathname, origin) + shown.search || "/";
  } catch {
    return { ok: false, message: `That window is showing ${target.url || "nothing"}, which cannot be scanned.` };
  }
  if (!origin) {
    return { ok: false, message: `That window is showing ${target.url || "nothing"}, which cannot be scanned.` };
  }

  const session = await createAttachedSession(target, { origin });
  const result = await runScan(session, origin, startPath, { ...options, onStatus });
  return result.ok
    ? { ...result, servedBy: `attached to ${target.title}`, attached: true, windows: targets }
    : result;
}

/**
 * Opens an installed application, hands its window to a job, and puts it away.
 *
 * The person holding the build is often not the person who can run the
 * project, and for them the app *is* the project. What the job then does is the
 * attached work unchanged — the same crawl, the same guards, the same capture —
 * because an app opened with a debugging port and an app that already had one
 * are the same app.
 */
async function withAppSession(root, { onStatus } = {}, job) {
  const bundle = await describeAppBundle(root);
  if (!bundle) return { ok: false, message: `${root} is not an application.` };
  if (bundle.runtime !== "electron") {
    // Named rather than attempted: an app with no web runtime inside exposes no
    // debugging protocol at all, and opening it would only produce a wait.
    return {
      ok: false,
      reason: "not-web",
      message: `${bundle.name} is not built on a web runtime — there is no Electron framework and no packed app inside it, so it has no pages to read. Web and Electron apps can be scanned this way.`
    };
  }

  onStatus?.({ phase: "starting", detail: `Opening ${bundle.name} with a debugging port` });
  const launched = await launchAppBundle(bundle);
  if (!launched.ok) return { ok: false, message: launched.message };

  // From here on the app is open, so every way out of this function goes
  // through the shutdown. Attaching used to sit outside it, and the one app
  // that failed to attach — a real one, serving its interface from a scheme of
  // its own — was left running, which then made the *next* scan report that a
  // copy was already running. One fault, reported as a different one.
  let session = null;
  try {
    const window = launched.windows[0];
    const origin = originOf(window.url);
    if (!origin) {
      return { ok: false, message: `${bundle.name} opened a window showing ${window.url || "nothing"}, which cannot be scanned.` };
    }
    session = await createAttachedSession(window, { origin });
    return await job(session, { bundle, origin, window });
  } finally {
    session?.close();
    // Crank opened this copy, so Crank closes it. An app left running behind
    // the scan is one the person did not ask for and would have to find.
    await launched.stop();
  }
}

/** The icon macOS already draws for an installed app. */
async function bundleIcon(root) {
  try {
    const image = await require("electron").app?.getFileIcon?.(root, { size: "normal" });
    return image && !image.isEmpty() ? image.toDataURL() : null;
  } catch {
    return null;
  }
}

/** Where in the app the window Crank attached to already was. */
function startPathOf(url, origin) {
  try {
    const shown = new URL(url);
    return routeWithin(shown.pathname, origin) + shown.search || "/";
  } catch {
    return "/";
  }
}

/** Scans an installed application, from its own launch to its own shutdown. */
async function scanAppBundle(target, { onStatus, ...options } = {}) {
  return withAppSession(target, { onStatus }, async (session, { bundle, origin, window }) => {
    onStatus?.({ phase: "starting", detail: `${bundle.name} is open — reading ${window.title || bundle.name}` });
    const result = await runScan(session, origin, startPathOf(window.url, origin), { ...options, onStatus });
    return result.ok
      ? {
        ...result,
        // A page declares its icon and a scan takes it from there, but a
        // desktop app rarely bothers — it already has one, the one it wears in
        // the Dock, and that is what tells it apart in the list.
        icon: result.icon ?? await bundleIcon(bundle.root),
        servedBy: `${bundle.name}, opened with a debugging port`,
        attached: true,
        launched: bundle.name
      }
      : result;
  });
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
async function exploreFromPage(target, page, options = {}) {
  const normalized = normalizeTargetUrl(target);
  if (!normalized.ok) return { ok: false, message: normalized.message };
  return exploreWith(createDiscoverySession(normalized.origin), normalized.origin, page, options);
}

/** The same walk, one level out from a page of an installed application. */
async function exploreInApp(root, page, options = {}) {
  return withAppSession(root, options, (session, { origin }) => exploreWith(session, origin, page, options, { keepOpen: true }));
}

async function exploreWith(session, origin, page, { pages: held = [], maxStates = 20, onStatus, onProgress, ...options } = {}, { keepOpen = false } = {}) {
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
      origin,
      pages: await captureStates(session, found, options, onStatus),
      skipped,
      filtered,
      inert
    };
  } finally {
    // The application's own window closes with the app; a window Crank opened
    // for the walk is closed here.
    if (!keepOpen) session.close();
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
  return recaptureWith(createDiscoverySession(normalized.origin), page, options);
}

/** The same capture, of one page of an installed application. */
async function recaptureInApp(root, page, options = {}) {
  return withAppSession(root, options, (session) => recaptureWith(session, page, options, { keepOpen: true }));
}

async function recaptureWith(session, page, options = {}, { keepOpen = false } = {}) {
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
    if (!keepOpen) session.close();
  }
}

/**
 * Scans a running app and returns one entry per distinct visual state.
 * `seedPaths` lets a caller supply addresses it already knows about; they are
 * merged with whatever the sitemap and the crawl turn up.
 */
async function scanUrl(target, options = {}) {
  const normalized = normalizeTargetUrl(target);
  if (!normalized.ok) return { ok: false, message: normalized.message };
  const { origin, startPath } = normalized;
  return runScan(createDiscoverySession(origin), origin, startPath, options);
}

/**
 * The scan itself, over whichever session was handed to it.
 *
 * A window UI Sync opened and an app it attached to differ only in how the
 * page is reached; what is discovered and captured must not differ at all, or
 * the two would disagree about what a project contains.
 */
async function runScan(session, origin, startPath, {
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
    // Taken once for the project, not per page: it is the same icon on all of
    // them, and it is what tells one project from another in the list.
    const icon = await session.captureIcon?.().catch(() => null) ?? null;

    return {
      ok: true,
      origin,
      icon,
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
/**
 * Whether the folder says of itself that it is a workspace.
 *
 * A monorepo root usually has a dev script, but it orchestrates rather than
 * serves: `pnpm --parallel --filter a --filter b dev` starts two applications
 * and no single address, so treating the root as runnable started that command
 * and then scanned nothing. Asking whether a dev script exists is the wrong
 * question; the project already answers the right one by declaring its
 * packages.
 */
async function declaresWorkspace(root) {
  for (const file of ["pnpm-workspace.yaml", "pnpm-workspace.yml", "lerna.json"]) {
    if (await readFile(path.join(root, file), "utf8").then(() => true).catch(() => false)) return true;
  }
  try {
    const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const declared = manifest.workspaces;
    return Array.isArray(declared) ? declared.length > 0 : Array.isArray(declared?.packages) && declared.packages.length > 0;
  } catch {
    return false;
  }
}

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
    // A folder that declares its packages is not an application, whatever its
    // own dev script does. One that merely happens to contain projects — a
    // portfolio with a couple of demos in it — still gets scanned itself.
    const runnable = await resolveDevCommand(root);
    const servesItself = !(await declaresWorkspace(root))
      && (runnable.ok || Boolean(await findStaticSite(root, { maxPages: 1 })));
    if (!servesItself) {
      return {
        ok: false,
        reason: "workspace",
        message: "This folder is a workspace: it declares packages and its dev script hands work to them rather than serving an interface. Its packages are listed instead.",
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
  // An installed app is a folder too, and dropping one means the app, not its
  // insides: there is no dev script in there to run, only a build to open.
  if (looksLikeAppBundle(root)) return scanAppBundle(root, options);
  return withProjectServer(root, options, (url, served) => scanUrl(url, {
    ...forward,
    onStatus,
    seedPaths: served.seedPaths,
    ...(served.maxStates ? { maxStates: served.maxStates } : {})
  }));
}

module.exports = { declaresWorkspace, exploreFromPage, exploreInApp, listTargets, looksLikeAppBundle, normalizeTargetUrl, parseSitemapPaths, recaptureInApp, recapturePage, scanAppBundle, scanAttached, scanFolder, scanSelf, scanUrl, withProjectServer };
