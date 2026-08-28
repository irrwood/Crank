import { packager } from "@electron/packager";
import { mkdir, rm, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { compileScannerBinary } = require("../electron/swift-syntax-backend.cjs");
const { compileCompositorBinary } = require("../electron/swift-pdf-compositor.cjs");
const { requireXcodePaths } = require("../electron/xcode-paths.cjs");

/**
 * Builds the macOS app someone can be handed.
 *
 * Two things have to leave the archive. The Figma plugin is picked out of the
 * Finder and imported by Figma, and the Swift tools are compiled by swiftc —
 * none of which can see inside app.asar, so those are unpacked beside it and
 * the app looks for them there (see packaged-path.cjs).
 */
const [, , ...args] = process.argv;
const arch = args.find((value) => value.startsWith("--arch="))?.slice("--arch=".length) ?? "arm64";

await rm("release", { recursive: true, force: true });

// The Swift tools ship compiled. They are the one part of this app that is not
// open, and unpacking them beside the archive — which `swiftc` needs in order
// to read them at all — would otherwise put their source in every copy handed
// out, in plain text, one right-click away.
const prebuilt = path.resolve("swift-tools", "prebuilt");
await rm(prebuilt, { recursive: true, force: true });
await mkdir(prebuilt, { recursive: true });
const xcode = await requireXcodePaths("Install the full Xcode app before packaging: the Swift tools are compiled into the build");
await compileScannerBinary(path.join(prebuilt, "ui-sync-swift-scanner"), xcode);
await compileCompositorBinary(path.join(prebuilt, "ui-sync-pdf-compositor"), xcode);
console.log("compiled the Swift tools into swift-tools/prebuilt");
const [built] = await packager({
  dir: ".",
  name: "Crank",
  platform: "darwin",
  arch,
  icon: "assets/app-icon",
  out: "release",
  overwrite: true,
  prune: true,
  // Matched against each file's full path, so it has to start from anywhere.
  asar: { unpack: "**/{figma-plugin,swift-tools}/**" },
  // Named rather than excluded: a list of what to leave out is a list someone
  // has to keep up to date, and the day it falls behind, something private
  // ships. A first attempt at this shipped 67 browser console logs from a
  // debugging session. This is everything the app actually runs from.
  ignore: (file) => {
    // node_modules is the exception to the rule below, and the reason for the
    // rule does not apply to it: it holds nobody's work but its authors', so a
    // list of what to leave out cannot one day leak something of the user's.
    // What it can do is ship sixty megabytes nothing runs.
    //
    // Three things are in there that the packaged app never loads. Vite's
    // pre-bundle cache and the dev tools' shims are build leftovers. And every
    // package the *renderer* imports is already inside `dist` — Vite bundled
    // it — so a second copy travels along as source for no one.
    if (/^\/node_modules\/\.(vite|bin)(\/|$)/.test(file)) return true;
    const bundledIntoDist = [
      "lucide-react", "react", "react-dom", "scheduler",
      "@xyflow/react", "@xyflow/system", "zustand",
      "@dagrejs/dagre", "@dagrejs/graphlib"
    ];
    if (bundledIntoDist.some((name) => file === `/node_modules/${name}` || file.startsWith(`/node_modules/${name}/`))) {
      return true;
    }
    if (file === "") return false;
    // `/swift-sdk` holds the capture agent that is appended into a copy of a
    // SwiftUI project at scan time. Left out, a packaged build could open an
    // iOS project and never read a display list from it.
    const shipped = ["/package.json", "/electron", "/dist", "/assets", "/figma-plugin", "/swift-sdk", "/swift-tools", "/shared", "/node_modules"];
    if (/\.test\.cjs$/.test(file)) return true;
    // Compiled above and shipped from swift-tools/prebuilt instead.
    if (/^\/swift-tools\/.*\.swift$/.test(file)) return true;
    return !shipped.some((entry) => file === entry || file.startsWith(`${entry}/`));
  },
  appBundleId: "com.crank.desktop",
  appVersion: process.env.npm_package_version ?? "0.1.0"
});
console.log(`built ${built}`);

/**
 * The archive someone downloads.
 *
 * `ditto` rather than `zip`: a macOS app bundle carries symlinks and extended
 * attributes inside its frameworks, and a zip that flattens them produces a
 * copy that will not launch. Named with the version because a release page
 * holds several at once.
 */
const archive = path.resolve("release", `Crank-${process.env.npm_package_version ?? "0.1.0"}-${arch}.zip`);
await new Promise((done, fail) => {
  const run = spawn("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(built, "Crank.app"), archive], { stdio: "inherit" });
  run.on("error", fail);
  run.on("exit", (code) => (code === 0 ? done() : fail(new Error(`ditto exited with ${code}`))));
});
const { size } = await stat(archive);
console.log(`archived ${archive} (${Math.round(size / 1e6)}MB)`);
