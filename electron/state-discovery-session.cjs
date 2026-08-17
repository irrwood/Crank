const { BrowserWindow } = require("electron");
const { randomBytes } = require("node:crypto");
const { createBrowsingSession } = require("./browsing-session.cjs");
const { requestVerdict } = require("./request-policy.cjs");

/**
 * Drives an app in a window UI Sync opens for the purpose.
 *
 * This is the sandboxed half of discovery: node integration off, a throwaway
 * partition, permissions denied, and every request judged by the shared policy
 * so a crawl cannot write to someone's project. The crawl itself lives in
 * browsing-session, which the attached-app driver shares.
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
  let lastFetchAt = 0;
  const contents = window.webContents;
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  contents.session.webRequest.onBeforeRequest((details, callback) => {
    const verdict = requestVerdict(details.url, details.method, details.resourceType, originHost);
    if (!verdict.allow) {
      if (verdict.reason === "external") blocked.external.add(verdict.host);
      if (verdict.reason === "mutation") blocked.mutations.add(verdict.label);
      callback({ cancel: true });
      return;
    }
    lastRequestAt = Date.now();
    if (verdict.isFetch) lastFetchAt = lastRequestAt;
    callback({ cancel: false });
  });

  return createBrowsingSession(origin, {
    blocked,
    timing: {
      get lastRequestAt() { return lastRequestAt; },
      get lastFetchAt() { return lastFetchAt; },
      forgetFetch() { lastFetchAt = 0; }
    },
    evaluate: (expression) => contents.executeJavaScript(expression, true),
    navigate: (url) => contents.loadURL(url),
    screenshot: () => contents.capturePage(),
    clearStorage: () => contents.session.clearStorageData({
      storages: ["cookies", "localstorage", "indexdb", "websql", "serviceworkers", "cachestorage"]
    }),
    dispose: () => { if (!window.isDestroyed()) window.destroy(); }
  });
}

module.exports = { createDiscoverySession };
