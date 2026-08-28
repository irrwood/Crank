const { access } = require("node:fs/promises");
const { execFile } = require("node:child_process");
const path = require("node:path");

const FALLBACK_DEVELOPER_DIRECTORY = "/Applications/Xcode.app/Contents/Developer";

let cachedPaths = null;

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function execOutput(command, arguments_) {
  return new Promise((resolve) => {
    execFile(command, arguments_, { timeout: 10_000 }, (error, stdout) => {
      resolve(error ? null : String(stdout || "").trim());
    });
  });
}

function toolchainPaths(developerDirectory) {
  const toolchain = path.join(developerDirectory, "Toolchains", "XcodeDefault.xctoolchain");
  return {
    developerDirectory,
    xcodebuild: path.join(developerDirectory, "usr", "bin", "xcodebuild"),
    simctl: path.join(developerDirectory, "usr", "bin", "simctl"),
    swiftc: path.join(toolchain, "usr", "bin", "swiftc"),
    swiftHostLibrary: path.join(toolchain, "usr", "lib", "swift", "host"),
    macosSdk: path.join(developerDirectory, "Platforms", "MacOSX.platform", "Developer", "SDKs", "MacOSX.sdk"),
    toolchainDirectory: toolchain
  };
}

// A full Xcode install is required: the Command Line Tools directory has no
// simctl, no simulator SDKs, and no bundled SwiftSyntax host library.
async function isFullXcodeDeveloperDirectory(candidate) {
  if (!candidate) return false;
  const paths = toolchainPaths(candidate);
  const [hasXcodebuild, hasSwiftc, hasSimctl] = await Promise.all([
    exists(paths.xcodebuild),
    exists(paths.swiftc),
    exists(paths.simctl)
  ]);
  return hasXcodebuild && hasSwiftc && hasSimctl;
}

async function resolveDeveloperDirectory() {
  const candidates = [
    process.env.DEVELOPER_DIR,
    await execOutput("/usr/bin/xcode-select", ["-p"]),
    FALLBACK_DEVELOPER_DIRECTORY
  ];
  for (const candidate of candidates) {
    if (candidate && await isFullXcodeDeveloperDirectory(candidate)) return candidate;
  }
  return null;
}

/**
 * Where Xcode actually is on this Mac.
 *
 * Resolved once per process, in the order `DEVELOPER_DIR`, `xcode-select -p`,
 * then the default install location — so an Xcode that was moved, renamed, or
 * installed as a beta is found rather than reported missing.
 */
async function resolveXcodePaths() {
  if (!cachedPaths) {
    cachedPaths = (async () => {
      const developerDirectory = await resolveDeveloperDirectory();
      if (!developerDirectory) return null;
      const paths = toolchainPaths(developerDirectory);
      if (await exists(paths.macosSdk)) return paths;
      const sdk = await execOutput(path.join(developerDirectory, "usr", "bin", "xcrun"), ["--sdk", "macosx", "--show-sdk-path"]);
      return { ...paths, macosSdk: sdk && await exists(sdk) ? sdk : paths.macosSdk };
    })().catch(() => null);
  }
  return cachedPaths;
}

async function requireXcodePaths(message = "Install the full Xcode app before running this step") {
  const paths = await resolveXcodePaths();
  if (!paths) throw new Error(message);
  return paths;
}

function resetXcodePathCache() {
  cachedPaths = null;
}

module.exports = {
  FALLBACK_DEVELOPER_DIRECTORY,
  requireXcodePaths,
  resetXcodePathCache,
  resolveXcodePaths
};
