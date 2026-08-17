const { BrowserWindow } = require("electron");
const { randomBytes } = require("node:crypto");
const { collectUiState, isFrameworkInternalPath } = require("./state-discovery.cjs");
const { MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, captureHtmlDocument } = require("./html-snapshot.cjs");
const { serializeRenderedApplication } = require("./figma-tree.cjs");
const { assignKeys } = require("./node-identity.cjs");

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Drives a real app in an offscreen window for state discovery.
 *
 * Crawling clicks through someone's actual project, so application writes are
 * cancelled: any non-GET request that is not framework tooling is blocked, and
 * everything off-host is blocked too. Together with skipping destructive
 * controls, a crawl cannot write to a database or call a mutating endpoint.
 * Framework internals stay allowed — see isFrameworkInternalPath.
 */
function createDiscoverySession(origin, { width = 1220, height = 790 } = {}) {
  const window = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `temporary:ui-sync-discovery-${randomBytes(12).toString("hex")}`
    }
  });

  const originHost = new URL(origin).host;
  const blocked = { mutations: new Set(), external: new Set() };
  // A page showing "Loading…" has a perfectly stable DOM, so quiescence alone
  // cannot tell "finished" from "still waiting". The moment the last request
  // *started* is the signal — counting requests in and out never balanced,
  // because a websocket or a cancelled request leaves the count stuck above
  // zero and every wait then ran to its limit.
  let lastRequestAt = 0;
  // Tracked apart from other traffic: a page that fetched data is still
  // working after the response lands, because something has to render it.
  // Documents, styles and images carry no such follow-on work.
  let lastFetchAt = 0;
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    if (["data:", "blob:"].some((scheme) => details.url.startsWith(scheme))) {
      callback({ cancel: false });
      return;
    }
    let url;
    try {
      url = new URL(details.url);
    } catch {
      callback({ cancel: true });
      return;
    }
    // Not origin, and not host either: Vite serves HMR from a separate port
    // (127.0.0.1:24678), so anything on the loopback interface counts as local.
    const isLoopback = ["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname);
    const isLocal = url.host === originHost || isLoopback;
    if (!isLocal || !["http:", "https:", "ws:", "wss:"].includes(url.protocol)) {
      blocked.external.add(url.host);
      callback({ cancel: true });
      return;
    }
    const method = (details.method || "GET").toUpperCase();
    if (!["GET", "HEAD"].includes(method) && !isFrameworkInternalPath(url.pathname)) {
      blocked.mutations.add(`${method} ${url.pathname}`);
      callback({ cancel: true });
      return;
    }
    lastRequestAt = Date.now();
    if (["xhr", "fetch"].includes(details.resourceType)) lastFetchAt = lastRequestAt;
    callback({ cancel: false });
  });

  /**
   * Waits for the page to stop changing, not for a fixed delay.
   *
   * Data arrives asynchronously and charts are built after it lands: this
   * app's analytics page had no chart at all 300ms in and six of them at two
   * seconds. A fixed wait captured the loading state and reported a clean
   * snapshot, which is worse than capturing nothing.
   */
  // Polling interval, not a delay: a page that is already finished should cost
  // three quick samples, not a fixed wait. A static page was costing 1.5s of
  // pure waiting while its capture took 127ms.
  const settle = async ({ quietFor = 1, interval = 120, maxWait = 3_000, grace = 0 } = {}) => {
    try {
      await contents.executeJavaScript(
        "Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))])",
        true
      );
    } catch {}

    const measure = () => contents.executeJavaScript(
      `(() => {
        const body = document.body;
        return body ? \`\${document.querySelectorAll("*").length}:\${body.innerText.length}:\${document.querySelectorAll("canvas,svg,img").length}\` : "";
      })()`,
      true
    ).catch(() => null);

    const deadline = Date.now() + maxWait;
    let previous = await measure();
    let stable = 0;
    let seenRequestAt = lastRequestAt;

    while (Date.now() < deadline) {
      await wait(interval);
      // Stillness only counts once the network has gone quiet. A page waiting
      // on a fetch sits perfectly still, and charts are drawn a few hundred
      // milliseconds *after* their data lands — counting that earlier calm
      // ended the wait before anything had been rendered.
      if (lastRequestAt !== seenRequestAt) {
        seenRequestAt = lastRequestAt;
        stable = 0;
      }
      const current = await measure();
      stable = current !== null && current === previous ? stable + 1 : 0;
      previous = current;
      if (stable < quietFor || Date.now() - lastRequestAt <= interval) continue;

      // A page that fetched data is still working after the response lands —
      // charts are built from it. A page that only loaded markup is finished
      // the moment it stops changing, and waiting on those is the whole cost
      // of scanning a static site.
      if (lastFetchAt === 0 || Date.now() - lastFetchAt > grace) break;
    }
  };

  const read = async () => {
    try {
      return await contents.executeJavaScript(`(${collectUiState.toString()})()`, true);
    } catch {
      return null;
    }
  };

  return {
    get blocked() {
      return { mutations: [...blocked.mutations], external: [...blocked.external] };
    },
    /**
     * Clears what the app remembered between visits.
     *
     * A language or theme switch is persisted, so once the crawl clicked one
     * every later page came back re-skinned and was recorded under a polluted
     * name. Replaying from the app's own default keeps each page comparable
     * with the last scan, which is what a baseline needs.
     */
    async reset() {
      try {
        await contents.session.clearStorageData({
          storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers", "cachestorage"]
        });
      } catch {}
    },
    async goto(route, { patient = false } = {}) {
      // Resolve against the origin rather than assigning to pathname: a route
      // like "/?view=settings" would otherwise be encoded into the path as
      // "/%3Fview=settings" and silently load the wrong view.
      const path = typeof route === "string" && route ? route : "/";
      let target;
      try {
        target = new URL(path, origin);
      } catch {
        return null;
      }
      if (target.origin !== origin) return null;
      lastFetchAt = 0;
      try {
        await contents.loadURL(target.toString());
      } catch {
        return null;
      }
      // Discovery only needs the structure, so it does not wait for data to
      // land. Capture does — a chart drawn after the fetch would be missing.
      await settle(patient ? { quietFor: 3, interval: 150, maxWait: 15_000, grace: 1_200 } : undefined);
      return read();
    },
    async click(locator, { patient = false } = {}) {
      let clicked = false;
      try {
        clicked = await contents.executeJavaScript(`(() => {
          const element = document.querySelector(${JSON.stringify(locator)});
          if (!element) return false;
          element.scrollIntoView({ block: "center" });
          element.click();
          return true;
        })()`, true);
      } catch {
        return null;
      }
      if (!clicked) return null;
      await settle(patient ? { quietFor: 3, interval: 150, maxWait: 15_000, grace: 1_200 } : undefined);
      // A link can carry the window off-site even when its href looked local.
      // The load is blocked, leaving a dead page: report nothing rather than
      // fingerprinting the error.
      try {
        const here = await contents.executeJavaScript("location.origin", true);
        if (here !== origin) return null;
      } catch {
        return null;
      }
      return read();
    },
    async captureHtml() {
      try {
        const limits = { maxAssetBytes: MAX_ASSET_BYTES, maxTotalAssetBytes: MAX_TOTAL_ASSET_BYTES };
        return await contents.executeJavaScript(
          `(${captureHtmlDocument.toString()})(${JSON.stringify(limits)})`,
          true
        );
      } catch (cause) {
        return { html: null, error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    /**
     * The layer tree the Figma plugin builds from. Same page, same session as
     * the HTML snapshot — one visit produces both.
     */
    async captureFigmaTree() {
      try {
        const tree = await contents.executeJavaScript(
          `(${serializeRenderedApplication.toString()})()`,
          true
        );
        if (tree?.tree) assignKeys(tree.tree);
        return tree;
      } catch (cause) {
        return { error: cause instanceof Error ? cause.message : String(cause) };
      }
    },
    async capture() {
      try {
        return await contents.capturePage();
      } catch {
        return null;
      }
    },
    close() {
      if (!window.isDestroyed()) window.destroy();
    }
  };
}

module.exports = { createDiscoverySession };
