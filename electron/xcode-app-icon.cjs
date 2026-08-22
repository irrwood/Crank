const { execFile } = require("node:child_process");
const { readFile, readdir, rm } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");

/**
 * An Xcode project's own app icon, for the row that stands for it.
 *
 * An installed app carries its icon where the Finder can find it. A project
 * carries the same picture in its asset catalog — under `AppIcon.appiconset`,
 * in a dozen sizes with a manifest saying which is which — and reading it is
 * what lets a scanned project wear its own face in the sidebar rather than a
 * folder glyph shared with everything else.
 */

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules", "Pods", "Carthage", "DerivedData", "build", "Build", ".build"]);

async function findAppIconSet(root, depth = 4) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  const here = directories.find((entry) => entry.name === "AppIcon.appiconset");
  if (here) return path.join(root, here.name);
  if (depth <= 0) return null;
  for (const entry of directories) {
    if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name.endsWith(".xcodeproj")) continue;
    const found = await findAppIconSet(path.join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

/** The largest picture the set declares — a row draws it small, but a small source stays small. */
function largestDeclaredIcon(contents) {
  let best = null;
  for (const image of contents?.images ?? []) {
    if (typeof image?.filename !== "string" || !image.filename) continue;
    const side = Number(String(image.size ?? "").split("x")[0]) || 0;
    const scale = Number(String(image.scale ?? "1x").replace("x", "")) || 1;
    const pixels = side * scale;
    if (!best || pixels > best.pixels) best = { filename: image.filename, pixels };
  }
  return best?.filename ?? null;
}

function resizeWithSips(source, target) {
  return new Promise((resolve, reject) => {
    execFile("sips", ["-s", "format", "png", "-Z", "128", source, "--out", target], { timeout: 8000 }, (cause) => {
      if (cause) reject(cause);
      else resolve(target);
    });
  });
}

/**
 * Reads the icon an Xcode project ships, as a data URL a row can draw.
 *
 * Returns null rather than something approximate when the project has no icon
 * set, or has one with nothing in it — a project without an icon is a fact the
 * sidebar can show with a glyph of its own.
 */
async function readXcodeAppIcon(root, { resize = resizeWithSips } = {}) {
  const iconSet = await findAppIconSet(String(root ?? "")).catch(() => null);
  if (!iconSet) return null;
  const contents = await readFile(path.join(iconSet, "Contents.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => null);
  const declared = largestDeclaredIcon(contents);
  const present = (await readdir(iconSet).catch(() => [])).filter((entry) => /\.(?:png|jpe?g)$/i.test(entry));
  const candidates = [...(declared ? [declared] : []), ...present.sort((left, right) => right.length - left.length)];
  for (const candidate of candidates) {
    const source = path.join(iconSet, candidate);
    const scaled = path.join(os.tmpdir(), `crank-xcode-icon-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.png`);
    try {
      await resize(source, scaled);
      const bytes = await readFile(scaled);
      await rm(scaled, { force: true });
      if (bytes.length > 0) return `data:image/png;base64,${bytes.toString("base64")}`;
    } catch {
      // Try the next one: an asset catalog can name a file it does not hold.
    }
  }
  return null;
}

module.exports = { findAppIconSet, largestDeclaredIcon, readXcodeAppIcon };
