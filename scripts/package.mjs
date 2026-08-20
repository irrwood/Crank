import { packager } from "@electron/packager";
import { rm } from "node:fs/promises";

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
    return !shipped.some((entry) => file === entry || file.startsWith(`${entry}/`));
  },
  appBundleId: "com.crank.desktop",
  appVersion: process.env.npm_package_version ?? "0.1.0"
});
console.log(`built ${built}`);
