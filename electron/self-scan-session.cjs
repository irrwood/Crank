const path = require("node:path");
const { BrowserWindow } = require("electron");
const { createBrowsingSession } = require("./browsing-session.cjs");
const { requestVerdict } = require("./request-policy.cjs");
const { startLocalRendererServer } = require("./static-server.cjs");

/**
 * Drives a copy of UI Sync's own interface, with UI Sync's own data behind it.
 *
 * Every other way of scanning this app produced one empty page. Served over
 * http the interface has no preload, so it has no projects to show; attaching
 * to the real window over a debugging port needs a second instance, which the
 * single-instance lock refuses. Both are answers to a question that does not
 * apply here: the preload is in this repository, and the window to crawl can be
 * opened directly.
 *
 * It has to be a second window. Crawling navigates, clicks everything it finds
 * and clears storage between visits — doing that to the window someone is using
 * would drive their interface around and wipe what it remembers.
 *
 * And the bridge it carries only reads. See self-scan-preload: with the real
 * one attached, a crawl clicking Rescan would start scans inside a scan.
 */
async function createSelfScanSession({ appRoot, devServerUrl = process.env.UI_SYNC_DEV_SERVER_URL } = {}) {
  // In development the interface is already being served with hot reload, and
  // reusing it means the crawl sees exactly what the developer sees. Otherwise
  // the built interface is served over http rather than loaded from a file:
  // a file:// document has no origin, and every route the crawl resolves is
  // checked against one.
  const local = devServerUrl ? null : await startLocalRendererServer(path.join(appRoot, "dist", "index.html"));
  const origin = devServerUrl ?? local.origin;

  const window = new BrowserWindow({
    show: false,
    width: 1220,
    height: 790,
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "self-scan-preload.cjs")
    }
  });

  const originHost = new URL(origin).host;
  const blocked = { mutations: new Set(), external: new Set(), fetched: new Set() };
  const drawn = new Set();
  let lastRequestAt = 0;
  let lastFetchAt = 0;
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.session.setPermissionRequestHandler((_w, _p, callback) => callback(false));
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    // This app's own pictures, in this app's own interface.
    //
    // The shared policy judges a scheme it does not recognise as off-host,
    // which is right for a third party's page and wrong here. `crank-asset://`
    // is where the stored screenshots live, and its host is a content hash, so
    // it can never sit "within" the loopback origin the interface is served
    // from — every thumbnail and every project icon came back a broken image,
    // in a scan of the one app that is not a third party.
    //
    // Only here, and only for reads. A scan of someone else's page still
    // cannot ask for these.
    if (details.url.startsWith("crank-asset://")
      && ["GET", "HEAD"].includes(String(details.method || "GET").toUpperCase())) {
      lastRequestAt = Date.now();
      callback({ cancel: false });
      return;
    }
    const verdict = requestVerdict(details.url, details.method, details.resourceType, originHost, drawn);
    if (!verdict.allow) {
      if (verdict.reason === "external") blocked.external.add(verdict.host);
      if (verdict.reason === "mutation") blocked.mutations.add(verdict.label);
      callback({ cancel: true });
      return;
    }
    if (verdict.fetchedFrom) blocked.fetched.add(verdict.fetchedFrom);
    if (verdict.drawnUrl) drawn.add(verdict.drawnUrl);
    lastRequestAt = Date.now();
    if (verdict.isFetch) lastFetchAt = lastRequestAt;
    callback({ cancel: false });
  });

  return {
    origin,
    session: createBrowsingSession(origin, {
      blocked,
      timing: {
        get lastRequestAt() { return lastRequestAt; },
        get lastFetchAt() { return lastFetchAt; },
        forgetFetch() { lastFetchAt = 0; }
      },
      evaluate: (expression) => contents.executeJavaScript(expression, true),
      navigate: (url) => contents.loadURL(url),
      screenshot: () => contents.capturePage(),
      // Not the real session's storage: this window has its own, and clearing
      // it must never reach what the running interface remembers.
      clearStorage: () => contents.session.clearStorageData({
        storages: ["localstorage", "indexdb", "websql", "serviceworkers", "cachestorage"]
      }),
      dispose: () => {
        if (!window.isDestroyed()) window.destroy();
        local?.close?.();
      }
    })
  };
}

module.exports = { createSelfScanSession };
