const { createServer } = require("node:http");
const path = require("node:path");
const { readFile, stat } = require("node:fs/promises");

/**
 * Serves a folder of files over HTTP.
 *
 * A static site is the simplest kind of web project and had no way in: no
 * package.json means no dev script, and no Dockerfile means nothing declared
 * to run. It needs neither — the files only have to be reachable.
 *
 * Lifted out of the main process unchanged so the capture path and page
 * discovery share one server rather than growing two.
 */
const captureMimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};

async function startLocalRendererServer(entryPath) {
  const rendererRoot = path.dirname(entryPath);
  const entryName = path.basename(entryPath);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const requestedName = decodeURIComponent(url.pathname).replace(/^\/+/, "") || entryName;
      let target = path.resolve(rendererRoot, requestedName);
      if (target !== rendererRoot && !target.startsWith(`${rendererRoot}${path.sep}`)) {
        response.writeHead(403).end();
        return;
      }
      let body;
      try {
        body = await readFile(target);
      } catch {
        target = entryPath;
        body = await readFile(target);
      }
      response.writeHead(200, {
        "Content-Type": captureMimeTypes[path.extname(target).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-store",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Connection": "close"
      });
      response.end(body);
    } catch (error) {
      response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : "Renderer server error");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the local renderer server");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    url: `http://127.0.0.1:${address.port}/${encodeURIComponent(entryName)}`,
    close: () => new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    })
  };
}

module.exports = { captureMimeTypes, startLocalRendererServer };
