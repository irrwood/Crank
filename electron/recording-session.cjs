const { BrowserWindow } = require("electron");
const { randomBytes } = require("node:crypto");
const { collectUiState, identityOf, isHtmlContentType, signatureOf } = require("./state-discovery.cjs");
const { MAX_ASSET_BYTES, MAX_TOTAL_ASSET_BYTES, captureHtmlDocument } = require("./html-snapshot.cjs");

/**
 * Records the pages someone visits while driving the app themselves.
 *
 * Crawling cannot reach what needs a login, a filled form, or simply judgement
 * about which screens matter. The person using the tool knows all three, so
 * this opens a real window, watches what they land on, and captures each new
 * state without asking them to do anything else.
 *
 * Unlike discovery, nothing is blocked: the window is theirs to use, and
 * blocking writes would break the very flows they are trying to reach.
 */
function createRecordingSession(origin, { onCaptured, onNavigate, width = 1280, height = 860 } = {}) {
  const window = new BrowserWindow({
    show: true,
    width,
    height,
    useContentSize: true,
    title: "Recording — use the app, pages are captured as you go",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: `persist:ui-sync-recording-${signatureOf(origin)}`
    }
  });

  const contents = window.webContents;
  const seen = new Map();
  let closed = false;
  let busy = false;
  let pending = null;

  const capture = async () => {
    if (closed || busy) {
      pending = Date.now();
      return;
    }
    busy = true;
    try {
      const snapshot = await contents.executeJavaScript(`(${collectUiState.toString()})()`, true).catch(() => null);
      if (!snapshot) return;
      if (snapshot.contentType && !isHtmlContentType(snapshot.contentType)) return;

      const signature = signatureOf(snapshot.fingerprint);
      if (seen.has(signature)) return;

      const captured = await contents.executeJavaScript(
        `(${captureHtmlDocument.toString()})(${JSON.stringify({ maxAssetBytes: MAX_ASSET_BYTES, maxTotalAssetBytes: MAX_TOTAL_ASSET_BYTES })})`,
        true
      ).catch(() => null);

      const image = await contents.capturePage().catch(() => null);
      const thumbnail = image && !image.isEmpty()
        ? (() => {
            const size = image.getSize();
            const scaled = image.resize({ width: 420, height: Math.max(1, Math.round(size.height * (420 / size.width))) });
            return { dataUrl: scaled.toDataURL(), width: size.width, height: size.height };
          })()
        : null;

      const page = {
        // Recorded by hand or found by the crawl, a page at one address is one
        // page, so both name it the same way and the two merge rather than
        // arriving as near-duplicates.
        id: identityOf(snapshot.url || "/", []),
        name: (snapshot.heading || snapshot.title || snapshot.url || "Page").slice(0, 80),
        signature,
        route: snapshot.url || "/",
        url: snapshot.url || "/",
        // Recorded by hand: the address is the way back, there is no click
        // recipe to replay.
        recipe: [],
        depth: 0,
        source: "recorded",
        variants: [],
        thumbnail,
        snapshot: captured?.html ? { html: captured.html, bytes: captured.html.length, stats: captured.stats } : null
      };
      seen.set(signature, page);
      onCaptured?.(page);
    } finally {
      busy = false;
      if (pending) {
        pending = null;
        setTimeout(capture, 400);
      }
    }
  };

  // Capture after the page settles, and again when in-page navigation changes
  // what is on screen without a full load.
  contents.on("did-finish-load", () => setTimeout(capture, 900));
  contents.on("did-navigate-in-page", () => setTimeout(capture, 900));
  window.on("closed", () => { closed = true; });

  return {
    window,
    get pages() {
      return [...seen.values()];
    },
    /** Captures whatever is on screen right now, on request. */
    captureNow: capture,
    open: (path = "/") => contents.loadURL(new URL(path, origin).toString()),
    close() {
      closed = true;
      if (!window.isDestroyed()) window.destroy();
    }
  };
}

module.exports = { createRecordingSession };
