const { randomBytes } = require("node:crypto");
const { createServer } = require("node:http");
const { mkdir, readFile, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { z } = require("zod");

/**
 * Carries MCP calls into the Crank window when it is already running.
 *
 * Starting a second Electron runtime would give two processes the same stored
 * inventory and make them compete for the one Figma and SwiftUI bridge. The
 * stdio MCP process therefore delegates to the existing owner over loopback.
 * A per-machine 256-bit token is required even on localhost: another local
 * process must not gain scan or Figma-send authority merely by guessing a port.
 */

// 38457 is the Figma bridge and 38458 is the SwiftUI runtime bridge.
const DEFAULT_PORT = 38459;
const TOKEN = /^[a-f0-9]{64}$/;
const METHODS = new Set([
  "listProjects", "getInventory", "getPage", "getPageImage", "getPageDocument", "openFlow",
  "scanProject", "scanUrl", "scanAttached", "sendToFigma", "getFigmaStatus",
  "copyForPaper", "pushToPaper"
]);
const requestSchema = z.object({
  method: z.string().refine((value) => METHODS.has(value)),
  args: z.array(z.unknown()).max(8)
}).strict();

async function ensureToken(tokenPath) {
  try {
    return z.string().regex(TOKEN).parse((await readFile(tokenPath, "utf8")).trim());
  } catch {
    const token = randomBytes(32).toString("hex");
    await mkdir(path.dirname(tokenPath), { recursive: true });
    await writeFile(tokenPath, `${token}\n`, { mode: 0o600 });
    return token;
  }
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(value));
}

async function readJson(request, maximum = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximum) throw new Error("MCP RPC request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createMcpRpcServer({ operations, tokenPath, port = DEFAULT_PORT, host = "127.0.0.1" }) {
  let token = null;
  let server = null;
  return {
    get port() { return server?.address()?.port ?? port; },
    async start() {
      token = await ensureToken(tokenPath);
      server = createServer(async (request, response) => {
        if (request.headers.authorization !== `Bearer ${token}`) {
          sendJson(response, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        if (request.method === "GET" && request.url === "/health") {
          sendJson(response, 200, { ok: true });
          return;
        }
        if (request.method !== "POST" || request.url !== "/rpc") {
          sendJson(response, 404, { ok: false, error: "Not found" });
          return;
        }
        try {
          const call = requestSchema.parse(await readJson(request));
          const result = await operations[call.method](...call.args, () => {});
          sendJson(response, 200, { ok: true, result });
        } catch (cause) {
          sendJson(response, 400, { ok: false, error: cause instanceof Error ? cause.message : String(cause) });
        }
      });
      // Swift builds can legitimately take longer than Node's default request
      // timeout. The MCP job is still pollable while this local call remains up.
      server.requestTimeout = 0;
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      return this;
    },
    async stop() {
      const active = server;
      server = null;
      if (!active) return;
      await new Promise((resolve) => active.close(resolve));
    }
  };
}

async function createMcpRpcClient({ tokenPath, port = DEFAULT_PORT, host = "127.0.0.1" }) {
  let token;
  try { token = z.string().regex(TOKEN).parse((await readFile(tokenPath, "utf8")).trim()); } catch { return null; }
  const base = `http://${host}:${port}`;
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const health = await fetch(`${base}/health`, { headers, signal: AbortSignal.timeout(800) });
    if (!health.ok) return null;
  } catch {
    return null;
  }
  const call = async (method, args) => {
    const response = await fetch(`${base}/rpc`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(requestSchema.parse({ method, args }))
    });
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.error || `Crank RPC returned ${response.status}`);
    return payload.result;
  };
  return {
    listProjects: () => call("listProjects", []),
    getInventory: (id) => call("getInventory", [id]),
    getPage: (id, pageId) => call("getPage", [id, pageId]),
    getPageImage: (id, pageId) => call("getPageImage", [id, pageId]),
    getPageDocument: (id, pageId) => call("getPageDocument", [id, pageId]),
    openFlow: () => call("openFlow", []),
    scanProject: (root, workspaceRoot) => call("scanProject", [root, workspaceRoot]),
    scanUrl: (url, seeds) => call("scanUrl", [url, seeds]),
    scanAttached: (debugPort) => call("scanAttached", [debugPort]),
    sendToFigma: (id, figmaUrl, pageIds) => call("sendToFigma", [id, figmaUrl, pageIds]),
    getFigmaStatus: (pairingCode) => call("getFigmaStatus", [pairingCode]),
    copyForPaper: (id, pageIds, title) => call("copyForPaper", [id, pageIds, title]),
    pushToPaper: (id, pageIds) => call("pushToPaper", [id, pageIds])
  };
}

module.exports = { DEFAULT_PORT, createMcpRpcClient, createMcpRpcServer, ensureToken };
