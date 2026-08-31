const path = require("node:path");
const { discoverJavascriptProjectRoots, discoverSwiftUiProjectRoots } = require("./project-scanner.cjs");
const { resolveXcodeProjectRoot } = require("./swiftui-inventory.cjs");

/**
 * The projects inside a folder, other than the folder itself.
 *
 * Finding out what a folder holds is a different question from scanning what
 * it holds, and much cheaper: it reads directory names, where a scan starts
 * each project, drives it, and for an Xcode project builds it. Someone who
 * added a package wants the list to catch up, not to sit through every project
 * being captured again.
 *
 * Both kinds, because a folder can hold both — a Python service with an iOS
 * client beside it is one repository, and only finding the JavaScript in it is
 * how the client ended up with nowhere to appear.
 *
 * A folder that is itself an Xcode project holds nothing to list: it is the
 * project, and offering it as its own child would put it in the sidebar twice.
 */
async function projectsInside(root) {
  const safeRoot = path.resolve(root);
  if (await resolveXcodeProjectRoot(safeRoot)) return [];
  const [javascript, swift] = await Promise.all([
    discoverJavascriptProjectRoots(safeRoot).catch(() => []),
    discoverSwiftUiProjectRoots(safeRoot).catch(() => [])
  ]);
  const inside = [...javascript, ...swift]
    .map((candidate) => path.resolve(candidate))
    .filter((candidate) => candidate !== safeRoot);
  return [...new Set(inside)].sort();
}

module.exports = { projectsInside };
