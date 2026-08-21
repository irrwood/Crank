import { packager } from "@electron/packager";
import { mkdir, rm } from "node:fs/promises";
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
    if (file === "") return false;
    const shipped = ["/package.json", "/electron", "/dist", "/assets", "/figma-plugin", "/swift-tools", "/shared", "/node_modules"];
    if (/\.test\.cjs$/.test(file)) return true;
    // Compiled above and shipped from swift-tools/prebuilt instead.
    if (/^\/swift-tools\/.*\.swift$/.test(file)) return true;
    return !shipped.some((entry) => file === entry || file.startsWith(`${entry}/`));
  },
  appBundleId: "com.crank.desktop",
  appVersion: process.env.npm_package_version ?? "0.1.0"
});
console.log(`built ${built}`);
