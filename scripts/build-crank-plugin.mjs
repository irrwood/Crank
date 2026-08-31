import { build } from "vite";
import { packager } from "@electron/packager";
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Produces a Codex plugin that owns its MCP process.
 *
 * The first plugin was only a launcher for a nearby checkout or Crank.app. It
 * worked on the author's machine but made installation conditional on a
 * second product and turned an Electron exit into `Transport closed`. This
 * build inlines the Node MCP server and its dependencies, then ships the
 * already self-contained widget beside it.
 */

const root = path.resolve(import.meta.dirname, "..");
const plugin = path.join(root, "plugins", "crank");
const temporary = path.join(root, "output", "crank-plugin-build");
const scripts = path.join(plugin, "scripts");
const resources = path.join(plugin, "resources");
const runtime = path.join(plugin, "runtime", `${process.platform}-${process.arch}`);

await rm(temporary, { recursive: true, force: true });
await mkdir(temporary, { recursive: true });

await build({
  configFile: false,
  logLevel: "info",
  build: {
    ssr: path.join(root, "electron", "mcp-standalone-entry.cjs"),
    target: "node20",
    outDir: temporary,
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "start-crank-mcp.cjs",
        format: "cjs",
        inlineDynamicImports: true
      }
    }
  },
  ssr: { noExternal: true }
});

await mkdir(scripts, { recursive: true });
await mkdir(resources, { recursive: true });
await cp(path.join(temporary, "start-crank-mcp.cjs"), path.join(scripts, "start-crank-mcp.cjs"));
const bundledWidget = await readFile(path.join(root, "codex", "dist", "flow-widget.html"), "utf8");
const hostedWidgetOrigin = "https://crank.tofukanban.uk";
const bundledStyle = bundledWidget.match(/<style>([\s\S]*?)<\/style>/)?.[1];
const bundledScript = bundledWidget.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!bundledStyle || !bundledScript) throw new Error("The built Crank widget has no inline fallback assets.");
const networkWidget = `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Crank for Codex</title><link rel="stylesheet" href="${hostedWidgetOrigin}/assets/widget.css" onerror="document.getElementById('crank-fallback-style').media='all'"><style id="crank-fallback-style" media="not all">${bundledStyle}</style></head><body><script src="${hostedWidgetOrigin}/assets/widget.js" onerror="this.remove();const s=document.createElement('script');s.textContent=${JSON.stringify(bundledScript)};document.body.append(s)"></script></body></html>`;
await writeFile(path.join(resources, "flow-widget.html"), networkWidget);
await cp(path.join(root, "public", "app-icon.png"), path.join(plugin, "assets", "app-icon.png"));

// Capture needs Chromium, but it does not need Crank's desktop window. Package
// the official Electron runtime and the existing capture modules as a private
// plugin dependency. Keeping it beside the Node sidecar makes installation
// self-contained and avoids searching /Applications or a source checkout.
const runtimeBuild = path.join(temporary, "runtime");
const [builtRuntime] = await packager({
  dir: root,
  name: "Crank Runtime",
  platform: process.platform,
  arch: process.arch,
  out: runtimeBuild,
  overwrite: true,
  prune: true,
  asar: { unpack: "**/{figma-plugin,swift-tools}/**" },
  // Packager renames the bundle and rewrites its Info.plist, which invalidates
  // the ad-hoc signature Electron shipped with: `codesign -v` then reports
  // "code has no resources but signature indicates they must be present", and
  // macOS refuses to launch the runtime. Re-sign the finished bundle — inner
  // frameworks and helpers first, which is why this goes through osx-sign
  // rather than a `codesign --deep` pass. Ad-hoc is what this machine can
  // offer: there is no Developer ID identity here, so a downloaded copy still
  // needs signing and notarisation before Gatekeeper will accept it.
  //
  // Hardened runtime is off on purpose. It turns on library validation, which
  // only accepts libraries sharing the main binary's Team ID — an ad-hoc
  // signature has none, so the app aborted at launch unable to load its own
  // Electron Framework. Hardening buys nothing without notarisation anyway.
  ...(process.platform === "darwin"
    ? {
      osxSign: {
        identity: "-",
        identityValidation: false,
        optionsForFile: () => ({ hardenedRuntime: false })
      }
    }
    : {}),
  appBundleId: "com.crank.runtime",
  appVersion: versionFromPackage(await readFile(path.join(root, "package.json"), "utf8")),
  extendInfo: process.platform === "darwin" ? { LSUIElement: true } : undefined,
  ignore: (file) => {
    if (/^\/node_modules\/\.(vite|bin)(\/|$)/.test(file)) return true;
    const rendererOnly = [
      "lucide-react", "react", "react-dom", "scheduler",
      "@xyflow/react", "@xyflow/system", "zustand",
      "@dagrejs/dagre", "@dagrejs/graphlib"
    ];
    if (rendererOnly.some((name) => file === `/node_modules/${name}` || file.startsWith(`/node_modules/${name}/`))) return true;
    if (file === "") return false;
    const shipped = ["/package.json", "/electron", "/assets", "/figma-plugin", "/swift-sdk", "/swift-tools", "/shared", "/node_modules"];
    if (/\.test\.cjs$/.test(file)) return true;
    if (/^\/swift-tools\/.*\.swift$/.test(file)) return true;
    return !shipped.some((entry) => file === entry || file.startsWith(`${entry}/`));
  }
});
await rm(runtime, { recursive: true, force: true });
await mkdir(runtime, { recursive: true });
if (process.platform === "darwin") {
  // Codex's plugin installer copies ordinary files but does not preserve the
  // symlinks inside a nested macOS app bundle. Keep the signed Electron layout
  // in a ditto archive and expand it only while a scan is running.
  await runCommand("ditto", [
    "-c",
    "-k",
    "--sequesterRsrc",
    "--keepParent",
    path.join(builtRuntime, "Crank Runtime.app"),
    path.join(runtime, "Crank Runtime.zip")
  ]);
} else {
  const archiveRoot = path.join(temporary, "runtime-archive");
  const archivePayload = path.join(archiveRoot, "Crank Runtime");
  await mkdir(archiveRoot, { recursive: true });
  await cp(builtRuntime, archivePayload, { recursive: true, preserveTimestamps: true, verbatimSymlinks: true });
  if (process.platform === "linux") {
    await runCommand("tar", ["-czf", path.join(runtime, "Crank Runtime.tar.gz"), "-C", archiveRoot, "Crank Runtime"]);
  } else if (process.platform === "win32") {
    await runCommand("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Compress-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
      archivePayload,
      path.join(runtime, "Crank Runtime.zip")
    ]);
  } else {
    throw new Error(`Crank does not package a capture runtime for ${process.platform}.`);
  }
}

const manifestPath = path.join(plugin, ".codex-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const { version } = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
await writeFile(manifestPath, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
await rm(temporary, { recursive: true, force: true });
console.log(`built standalone Crank plugin with ${process.platform}-${process.arch} capture runtime at ${plugin}`);

function versionFromPackage(contents) {
  return JSON.parse(contents).version;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} stopped with ${signal ?? code ?? "unknown"}.`));
    });
  });
}
