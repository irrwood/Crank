const { access, mkdir, stat } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");

const xcodeHostLibraryPath = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/host";
const xcodeSwiftCompilerPath = "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/swiftc";
const xcodeMacSdkPath = "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk";

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
  if (!(await exists(xcodeSwiftCompilerPath)) || !(await exists(path.join(xcodeHostLibraryPath, "SwiftSyntax.swiftmodule")))) {
    return null;
  }

  const sourcePath = path.resolve(__dirname, "..", "swift-tools", "UISyncSwiftScanner", "main.swift");
  const binaryDirectory = path.join(cacheDirectory, "swift-syntax");
  const binaryPath = path.join(binaryDirectory, "ui-sync-swift-scanner");
  await mkdir(binaryDirectory, { recursive: true });

  const [sourceInfo, compilerInfo, moduleInfo, binaryInfo] = await Promise.all([
    stat(sourcePath),
    stat(xcodeSwiftCompilerPath),
    stat(path.join(xcodeHostLibraryPath, "SwiftSyntax.swiftmodule")),
    stat(binaryPath).catch(() => null)
  ]);
  const newestInput = Math.max(sourceInfo.mtimeMs, compilerInfo.mtimeMs, moduleInfo.mtimeMs);
  if (binaryInfo && binaryInfo.mtimeMs >= newestInput) return binaryPath;

  await run(xcodeSwiftCompilerPath, [
    "-sdk", xcodeMacSdkPath,
    "-target", `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macosx14.0`,
    "-I", xcodeHostLibraryPath,
    "-L", xcodeHostLibraryPath,
    "-lSwiftSyntax",
    "-lSwiftParser",
    "-Xlinker", "-rpath",
    "-Xlinker", xcodeHostLibraryPath,
    sourcePath,
    "-o", binaryPath
  ]);
  return binaryPath;
}

async function scanWithSwiftSyntax(root, files, cacheDirectory) {
  if (!cacheDirectory || files.length === 0) return null;
  try {
    const binaryPath = await ensureScannerBinary(cacheDirectory);
    if (!binaryPath) return null;
    const output = await run(binaryPath, [root], { input: `${files.join("\n")}\n` });
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

module.exports = { ensureScannerBinary, scanWithSwiftSyntax };
