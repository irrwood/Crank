import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * MCP App resources are one HTML response, while Vite normally emits an asset
 * graph. Inlining the widget's already-bundled JS and CSS keeps it offline,
 * gives the resource an empty CSP, and avoids coupling it to any web server.
 */

await new Promise((resolve, reject) => {
  const run = spawn(process.execPath, [path.resolve("node_modules", "vite", "bin", "vite.js"), "build", "--config", path.resolve("codex", "vite.config.ts")], { stdio: "inherit" });
  run.on("error", reject);
  run.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`Codex widget Vite build exited with ${code}`)));
});

const output = path.resolve("codex", "dist");
const assets = path.join(output, "assets");
const networkOutput = path.resolve("codex", "network-dist");
const files = await readdir(assets);
const cssFile = files.find((file) => file.endsWith(".css"));
if (!cssFile) throw new Error("The Codex widget build emitted no stylesheet.");
const [css, javascript] = await Promise.all([
  readFile(path.join(assets, cssFile), "utf8"),
  readFile(path.join(assets, "widget.js"), "utf8")
]);
const html = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crank for Codex</title><style>${css}</style></head><body><script>${javascript.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, "flow-widget.html"), html);
await rm(networkOutput, { recursive: true, force: true });
await mkdir(path.join(networkOutput, "assets"), { recursive: true });
await cp(path.join(assets, "widget.js"), path.join(networkOutput, "assets", "widget.js"));
await cp(path.join(assets, cssFile), path.join(networkOutput, "assets", "widget.css"));
await writeFile(path.join(networkOutput, "index.html"), `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="description" content="Crank's local-first visual workspace for editable application flows."><title>Crank Canvas</title><link rel="stylesheet" href="/assets/widget.css"></head><body><script src="/assets/widget.js"></script></body></html>`);
// The hosted files are the plugin's update channel. Revalidation keeps a new
// Canvas build visible on the next open without turning every render into a
// fresh download when the ETag is unchanged.
await writeFile(path.join(networkOutput, "_headers"), `/assets/*\n  Cache-Control: public, max-age=0, must-revalidate\n\n/index.html\n  Cache-Control: public, max-age=0, must-revalidate\n`);
console.log(`built ${path.join(output, "flow-widget.html")} (${Math.round(Buffer.byteLength(html) / 1024)}KB)`);
console.log(`built network Crank canvas at ${networkOutput}`);
