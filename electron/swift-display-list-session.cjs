const http = require("node:http");
const { randomBytes } = require("node:crypto");
const { z } = require("zod");
const { buildLayerTree, captureSchema } = require("./swift-display-list-tree.cjs");

/**
 * Receives display-list captures from an instrumented SwiftUI app.
 *
 * This is deliberately a second receiver rather than another route on the
 * Design Build runtime. The two capture paths answer the same question in
 * different ways — one exports each screen as a vector PDF, this one reads the
 * render tree SwiftUI drew — and the only way to tell which is better on a real
 * project is to run both against it and look. Sharing a server would have tied
 * their lifetimes together and made "turn the new one off" a code change; apart,
 * either can be run without the other, and both can be run at once so the two
 * results are of the same launch of the same app rather than of two runs that
 * differ for reasons nobody can pin down.
 *
 * It holds no state that outlives a session and writes nothing to disk. A
 * capture arrives, is validated, is turned into a layer tree, and waits in
 * memory for the scan that asked for it.
 */

const MAX_CAPTURE_BYTES = 48 * 1024 * 1024;
const MAX_SCREENS = 500;

const screenNameSchema = z.string().min(1).max(160);

function json(response, statusCode, value) {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  response.end(body);
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    // Refused as it arrives rather than after: a capture of a screen with a
    // large image in it can be tens of megabytes, and buffering one that is
    // already over the limit is the thing the limit exists to prevent.
    if (size > limit) throw new Error("This display-list capture is too large to accept");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function createDisplayListServer({ port = 38459 } = {}) {
  // Reassigned by `start()` when the caller asked for any free port.
  const sessions = new Map();
  let server = null;

  function beginSession(projectRoot) {
    const token = randomBytes(24).toString("hex");
    sessions.set(token, { projectRoot, screens: [], lastCaptureAt: 0, startedAt: Date.now() });
    return {
      token,
      endpoint: `http://127.0.0.1:${port}/v1/crank-display-list/${token}/screen`,
      /**
       * Records that this project cannot be captured this way at all — it has
       * no SwiftUI entry point to start from, say. Kept as a screen rather than
       * thrown, so a scan that still has the other pipeline's result reports why
       * this one is empty instead of failing outright.
       */
      unavailable(reason) {
        const session = sessions.get(token);
        if (!session) return;
        session.screens.push({ name: "This project", ok: false, reason: String(reason).slice(0, 300), layerTree: null, thumbnail: null, warnings: [] });
        session.lastCaptureAt = Date.now();
      }
    };
  }

  /**
   * Accepts one screen. The agent's own `ok: false` is kept rather than thrown
   * away: a screen the agent could not read is a fact the scan has to report,
   * and dropping it would leave the screen merely absent with no reason given.
   */
  function acceptScreen(session, name, payload) {
    if (session.screens.length >= MAX_SCREENS) throw new Error("This app reported more screens than a scan carries");
    if (payload?.ok !== true) {
      const found = typeof payload?.found === "string" && payload.found.length > 0
        ? ` It had: ${payload.found.slice(0, 400)}.`
        : "";
      session.screens.push({
        name,
        ok: false,
        reason: (typeof payload?.reason === "string" ? payload.reason.slice(0, 300) : "the app reported no display list") + found,
        layerTree: null,
        thumbnail: null,
        warnings: []
      });
      session.lastCaptureAt = Date.now();
      return;
    }
    const capture = captureSchema.parse(payload);
    const { width, height, tree, warnings } = buildLayerTree(capture, {
      pageId: `swift-display-list-${session.screens.length}`
    });
    session.screens.push({
      name,
      ok: true,
      reason: null,
      layerTree: { width, height, tree },
      // What the screen looked like, so a page read this way has something to
      // show in the sidebar. Null when the app could not draw itself into an
      // image, which is a missing picture and not a missing page.
      thumbnail: typeof capture.screenshot === "string"
        ? { dataUrl: `data:image/png;base64,${capture.screenshot}`, width, height }
        : null,
      warnings,
      // Kept so a scan can be compared against what SwiftUI itself prints,
      // which is the only independent record of what was on screen.
      description: typeof capture.description === "string" ? capture.description.slice(0, 2_000_000) : null
    });
    session.lastCaptureAt = Date.now();
  }

  /**
   * Waits until the app has stopped sending, rather than for a fixed count.
   * How many screens an app has is what the scan is trying to find out, so it
   * cannot be part of the question.
   */
  async function waitForScreens(token, { timeoutMs = 20_000, settleMs = 1_500 } = {}) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const session = sessions.get(token);
      if (!session) throw new Error("The display-list session expired");
      if (session.screens.length > 0 && Date.now() - session.lastCaptureAt > settleMs) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return sessions.get(token)?.screens ?? [];
  }

  return {
    async start() {
      if (server) return;
      server = http.createServer((request, response) => {
        void (async () => {
          const url = new URL(request.url || "/", `http://127.0.0.1:${port}`);
          const match = url.pathname.match(/^\/v1\/crank-display-list\/([a-f0-9]{48})\/screen$/);
          if (!match) return json(response, 404, { error: "Not found" });
          const session = sessions.get(match[1]);
          if (!session) return json(response, 404, { error: "Display-list session expired" });
          if (request.method !== "POST") return json(response, 405, { error: "Method not allowed" });

          const rawName = request.headers["x-crank-screen-name"];
          const name = screenNameSchema.safeParse(typeof rawName === "string" ? rawName : "").success
            ? String(rawName)
            : `Screen ${session.screens.length + 1}`;
          const body = await readBody(request, MAX_CAPTURE_BYTES);
          acceptScreen(session, name, JSON.parse(body));
          return json(response, 200, { accepted: true });
        })().catch((error) => json(response, 400, {
          error: error instanceof Error ? error.message : "Invalid display-list capture"
        }));
      });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", resolve);
      });
      // Port 0 means "any free port", and the endpoint handed to the app has to
      // be the one actually bound. Reporting the requested port instead sent
      // every capture to a port nothing was listening on.
      const address = server.address();
      if (address && typeof address === "object") port = address.port;
    },
    beginSession,
    waitForScreens,
    screens(token) { return sessions.get(token)?.screens ?? []; },
    endSession(token) { sessions.delete(token); },
    async stop() {
      if (!server) return;
      const active = server;
      server = null;
      await new Promise((resolve) => active.close(resolve));
    },
    get port() { return port; }
  };
}

module.exports = { createDisplayListServer };
