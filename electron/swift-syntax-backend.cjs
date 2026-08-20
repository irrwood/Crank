const { access, mkdir, stat } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { shippedPath } = require("./packaged-path.cjs");
const { resolveXcodePaths } = require("./xcode-paths.cjs");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, arguments_, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      stdio: ["pipe", "pipe", "pipe"],
      ...options
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
    if (options.input) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

async function ensureScannerBinary(cacheDirectory) {
  const xcode = await resolveXcodePaths();
  if (!xcode || !(await exists(xcode.swiftc)) || !(await exists(path.join(xcode.swiftHostLibrary, "SwiftSyntax.swiftmodule")))) {
    return null;
  }

  const sourcePath = path.resolve(shippedPath("swift-tools"), "UISyncSwiftScanner", "main.swift");
  const binaryDirectory = path.join(cacheDirectory, "swift-syntax");
  const binaryPath = path.join(binaryDirectory, "ui-sync-swift-scanner");
  await mkdir(binaryDirectory, { recursive: true });

  const [sourceInfo, compilerInfo, moduleInfo, binaryInfo] = await Promise.all([
    stat(sourcePath),
    stat(xcode.swiftc),
    stat(path.join(xcode.swiftHostLibrary, "SwiftSyntax.swiftmodule")),
    stat(binaryPath).catch(() => null)
  ]);
  const newestInput = Math.max(sourceInfo.mtimeMs, compilerInfo.mtimeMs, moduleInfo.mtimeMs);
  if (binaryInfo && binaryInfo.mtimeMs >= newestInput) return binaryPath;

  await run(xcode.swiftc, [
    "-sdk", xcode.macosSdk,
    "-target", `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macosx14.0`,
    "-I", xcode.swiftHostLibrary,
    "-L", xcode.swiftHostLibrary,
    "-lSwiftSyntax",
    "-lSwiftParser",
    "-Xlinker", "-rpath",
    "-Xlinker", xcode.swiftHostLibrary,
    sourcePath,
    "-o", binaryPath
  ]);
  return binaryPath;
}

/**
 * Parses a project's Swift with Xcode's own SwiftSyntax.
 *
 * `onDiagnostic` separates "this Mac has no SwiftSyntax toolchain" from "the
 * scanner was there and failed". The second case silently downgrades every
 * later step to the regular-expression scan, which is exactly the kind of
 * substitution that must be reported rather than absorbed.
 */
async function scanWithSwiftSyntax(root, files, cacheDirectory, { onDiagnostic } = {}) {
  if (!cacheDirectory || files.length === 0) return null;
  const report = (reason, message) => {
    if (typeof onDiagnostic === "function") onDiagnostic({ reason, message });
  };
  let binaryPath = null;
  try {
    binaryPath = await ensureScannerBinary(cacheDirectory);
  } catch (error) {
    report("compile-failed", `The SwiftSyntax scanner could not be compiled: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
  if (!binaryPath) {
    report("unavailable", "Xcode's bundled SwiftSyntax toolchain was not found, so UI Sync used its regular-expression Swift scan.");
    return null;
  }
  try {
    const output = await run(binaryPath, [root], { input: `${files.join("\n")}\n` });
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed)) {
      report("invalid-output", "The SwiftSyntax scanner returned an unexpected result.");
      return null;
    }
    return parsed;
  } catch (error) {
    report("scan-failed", `The SwiftSyntax scanner failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

module.exports = { ensureScannerBinary, scanWithSwiftSyntax };
