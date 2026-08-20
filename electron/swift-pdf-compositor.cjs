const { access, mkdir, stat } = require("node:fs/promises");
const { spawn } = require("node:child_process");
const path = require("node:path");
const { z } = require("zod");
const { shippedPath } = require("./packaged-path.cjs");
const { resolveXcodePaths } = require("./xcode-paths.cjs");

const compositionSchema = z.object({
  basePdfPath: z.string().min(1),
  basePageNumber: z.number().int().positive(),
  overlayPdfPath: z.string().min(1),
  overlayFrame: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive()
  }).strict(),
  outputPath: z.string().min(1),
  cacheDirectory: z.string().min(1)
}).strict();

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, arguments_) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `${command} exited with status ${code}`));
    });
  });
}

async function ensureCompositorBinary(cacheDirectory) {
  const xcode = await resolveXcodePaths();
  if (!xcode || !(await exists(xcode.swiftc))) {
    throw new Error("The full Xcode toolchain is required to compose SwiftUI PDF pages");
  }
  const sourcePath = path.resolve(shippedPath("swift-tools"), "UISyncPdfCompositor", "main.swift");
  const binaryDirectory = path.join(cacheDirectory, "pdf-compositor");
  const binaryPath = path.join(binaryDirectory, "ui-sync-pdf-compositor");
  await mkdir(binaryDirectory, { recursive: true });
  const [sourceInfo, compilerInfo, binaryInfo] = await Promise.all([
    stat(sourcePath),
    stat(xcode.swiftc),
    stat(binaryPath).catch(() => null)
  ]);
  const newestInput = Math.max(sourceInfo.mtimeMs, compilerInfo.mtimeMs);
  if (!binaryInfo || binaryInfo.mtimeMs < newestInput) {
    await run(xcode.swiftc, [
      "-sdk", xcode.macosSdk,
      "-target", `${process.arch === "x64" ? "x86_64" : "arm64"}-apple-macosx14.0`,
      sourcePath,
      "-o", binaryPath
    ]);
  }
  return binaryPath;
}

async function composePdfPage(input) {
  const options = compositionSchema.parse(input);
  const binaryPath = await ensureCompositorBinary(options.cacheDirectory);
  const frame = options.overlayFrame;
  await run(binaryPath, [
    options.basePdfPath,
    String(options.basePageNumber),
    options.overlayPdfPath,
    String(frame.x),
    String(frame.y),
    String(frame.width),
    String(frame.height),
    options.outputPath
  ]);
  return options.outputPath;
}

module.exports = { composePdfPage, ensureCompositorBinary };
