const { nativeImage } = require("electron");
const { createBrowsingSession } = require("./browsing-session.cjs");
const { requestVerdict } = require("./request-policy.cjs");

/**
 * Drives an app UI Sync did not launch, over its debugging port.
 *
 * An Electron app served renderer-only is a shell: the preload bridge belongs
 * to the real window, so the copy UI Sync loads over http has no projects, no
 * account, no rows — every screen is an empty state, and no amount of clicking
 * produces data that is not there. The pages worth handing to a designer only
 * exist in the process the person is actually running.
 *
 * Chromium exposes that process when it is started with a remote debugging
 * port, and the crawl needs exactly four things from a page: run a script,
 * navigate, screenshot, clear storage. So this supplies those over the protocol
 * and reuses the crawl unchanged.
 *
 * The same request policy applies here as in the sandboxed window, and it
 * matters more: this is someone's real application with their real data behind
 * it.
 */

const MAX_TARGET_WAIT = 10_000;

/** Asks a debugging port what pages it has. */
async function listTargets(port, { fetchJson = defaultFetchJson } = {}) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  if (!Array.isArray(targets)) return [];
  return targets
    .filter((target) => target?.type === "page" && typeof target.webSocketDebuggerUrl === "string")
    // A devtools window is a page too, and is not the app.
    .filter((target) => !String(target.url ?? "").startsWith("devtools://"))
    .map((target) => ({
      id: String(target.id ?? ""),
      title: String(target.title ?? "Untitled"),
      url: String(target.url ?? ""),
      webSocketDebuggerUrl: target.webSocketDebuggerUrl
    }));
}

async function defaultFetchJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!response.ok) throw new Error(`The debugging port answered ${response.status}.`);
  return response.json();
}

/**
 * A minimal Chrome DevTools Protocol client.
 *
 * Only request/response and a handful of events are needed, which is far less
 * than any client library would bring with it — and a dependency that can drive
 * a browser is not one to add lightly to a tool that attaches to real apps.
 */
function createProtocol(socket) {
  const pending = new Map();
  const listeners = new Map();
  let nextId = 0;
  let closed = null;

  socket.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message ?? "Protocol error"));
      else resolve(message.result ?? {});
      return;
    }
    for (const handler of listeners.get(message.method) ?? []) handler(message.params ?? {});
  });

  const fail = (reason) => {
    closed = closed ?? new Error(reason);
    for (const { reject } of pending.values()) reject(closed);
    pending.clear();
  };
  socket.addEventListener("close", () => fail("The debugging connection closed."));
  socket.addEventListener("error", () => fail("The debugging connection failed."));

  return {
    on(method, handler) {
      if (!listeners.has(method)) listeners.set(method, []);
      listeners.get(method).push(handler);
    },
    send(method, params = {}) {
      if (closed) return Promise.reject(closed);
      const id = (nextId += 1);
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          socket.send(JSON.stringify({ id, method, params }));
        } catch (cause) {
          pending.delete(id);
          reject(cause);
        }
      });
    },
    close() {
      fail("The debugging connection was closed by UI Sync.");
      try {
        socket.close();
      } catch {}
    }
  };
}

function openSocket(url) {
  return new Promise((resolve, reject) => {
    let socket;
    try {
      socket = new WebSocket(url);
    } catch (cause) {
      reject(cause);
      return;
    }
    const timer = setTimeout(() => {
      try { socket.close(); } catch {}
      reject(new Error("The debugging port did not answer in time."));
    }, MAX_TARGET_WAIT);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(socket); }, { once: true });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error("Could not open a debugging connection."));
    }, { once: true });
  });
}

/**
 * Attaches to a page on a debugging port and returns the same session the
 * sandboxed window returns, so the crawl cannot tell them apart.
 */
async function createAttachedSession(target, { origin, connect = openSocket } = {}) {
  const socket = await connect(target.webSocketDebuggerUrl);
  const protocol = createProtocol(socket);
  const pageOrigin = origin ?? new URL(target.url).origin;
  const originHost = new URL(pageOrigin).host;
  const blocked = { mutations: new Set(), external: new Set(), fetched: new Set() };
  const drawn = new Set();
  let lastRequestAt = 0;
  let lastFetchAt = 0;

  protocol.on("Network.requestWillBeSent", (params) => {
    const verdict = requestVerdict(params.request?.url, params.request?.method, params.type, originHost, drawn);
    if (!verdict.allow) return;
    lastRequestAt = Date.now();
    if (verdict.isFetch) lastFetchAt = lastRequestAt;
  });

  // Enforced rather than merely observed: this is a real application, and a
  // crawl that clicked something writing must not reach the server.
  protocol.on("Fetch.requestPaused", (params) => {
    const verdict = requestVerdict(params.request?.url, params.request?.method, params.resourceType, originHost, drawn);
    if (verdict.allow) {
      if (verdict.fetchedFrom) blocked.fetched.add(verdict.fetchedFrom);
      if (verdict.drawnUrl) drawn.add(verdict.drawnUrl);
      void protocol.send("Fetch.continueRequest", { requestId: params.requestId }).catch(() => {});
      return;
    }
    if (verdict.reason === "external") blocked.external.add(verdict.host);
    if (verdict.reason === "mutation") blocked.mutations.add(verdict.label);
    void protocol.send("Fetch.failRequest", { requestId: params.requestId, errorReason: "BlockedByClient" }).catch(() => {});
  });

  await protocol.send("Page.enable");
  await protocol.send("Runtime.enable");
  await protocol.send("Network.enable");
  await protocol.send("Fetch.enable", { patterns: [{ urlPattern: "*" }] });

  const evaluate = async (expression) => {
    const result = await protocol.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      // The app's own page, not an isolated world: the crawl reads what the
      // application actually rendered.
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Script failed");
    }
    return result.result?.value;
  };

  const navigate = async (url) => {
    const outcome = await protocol.send("Page.navigate", { url });
    if (outcome.errorText) throw new Error(outcome.errorText);
    // Page.navigate resolves when the navigation is committed, not when the
    // document is usable; the settle poll that follows is what waits for that.
    await evaluate("new Promise((resolve) => (document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', resolve, { once: true }) : resolve()))")
      .catch(() => null);
  };

  return createBrowsingSession(pageOrigin, {
    blocked,
    timing: {
      get lastRequestAt() { return lastRequestAt; },
      get lastFetchAt() { return lastFetchAt; },
      forgetFetch() { lastFetchAt = 0; }
    },
    evaluate,
    navigate,
    async screenshot() {
      const shot = await protocol.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      if (!shot.data) return null;
      return nativeImage.createFromBuffer(Buffer.from(shot.data, "base64"));
    },
    clearStorage: () => protocol.send("Storage.clearDataForOrigin", {
      origin: pageOrigin,
      storageTypes: "cookies,local_storage,indexeddb,websql,service_workers,cache_storage"
    }),
    // Only the connection is ours. The window belongs to whoever is running the
    // app, and closing it would take their session down with the scan.
    dispose: () => protocol.close()
  });
}

module.exports = { createAttachedSession, createProtocol, listTargets };
