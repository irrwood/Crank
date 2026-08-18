const path = require("node:path");

/**
 * A path to a file the app ships, that something outside the app can open.
 *
 * A packaged build reads its own files out of `app.asar`, and Electron makes
 * that transparent — for its own reads. Nothing else can see inside it: the
 * Finder cannot reveal a file there, Figma cannot browse to one, and `swiftc`
 * cannot compile one. Those files are unpacked beside the archive at build
 * time, and this is the way to the copy that actually exists on disk.
 *
 * Unchanged when running from source, where there is no archive at all.
 */
function shippedPath(...parts) {
  const inside = path.join(__dirname, "..", ...parts);
  const archive = `app.asar${path.sep}`;
  return inside.includes(archive) ? inside.replace(archive, `app.asar.unpacked${path.sep}`) : inside;
}

module.exports = { shippedPath };
