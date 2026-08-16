const { BrowserWindow } = require("electron");
const { randomBytes } = require("node:crypto");
const { collectUiState, isFrameworkInternalPath } = require("./state-discovery.cjs");

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
    callback({ cancel: false });
  });

  const settle = async () => {
    try {
      await contents.executeJavaScript(
        "Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 3000))])",
        true
      );
    } catch {}
    await wait(280);
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
    async goto(route) {
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
      try {
        await contents.loadURL(target.toString());
      } catch {
        return null;
      }
      await settle();
      return read();
    },
    async click(locator) {
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
      await settle();
      return read();
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
