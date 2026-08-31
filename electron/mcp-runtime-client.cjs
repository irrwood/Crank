const { execFile, spawn } = require("node:child_process");
const { constants } = require("node:fs");
const { access, mkdir, mkdtemp, rm } = require("node:fs/promises");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const { z } = require("zod");
const { createMcpRpcClient } = require("./mcp-rpc.cjs");

/**
 * Starts the capture engine that ships inside the Codex plugin.
 *
 * A saved flow needs only Node, but a new scan needs Chromium. Looking for an
 * installed Crank.app made the desktop product an accidental dependency and
 * let a model-visible "open" action launch a window. This connector starts the
 * plugin's own Electron distribution with `--mcp-runtime`; that process has no
 * window or Dock icon and exposes only a per-session authenticated RPC port.
 */

const absolutePathSchema = z.string().min(1).max(4096).refine(path.isAbsolute);
const execFileAsync = promisify(execFile);

function bundledRuntimeArchive(pluginRoot, platform = process.platform, arch = process.arch) {
  const root = absolutePathSchema.parse(pluginRoot);
  const directory = path.join(root, "runtime", `${platform}-${arch}`);
  return path.join(directory, platform === "linux" ? "Crank Runtime.tar.gz" : "Crank Runtime.zip");
}

function extractedRuntimeExecutable(directory, platform = process.platform) {
  const root = absolutePathSchema.parse(directory);
  if (platform === "darwin") return path.join(root, "Crank Runtime.app", "Contents", "MacOS", "Crank Runtime");
  if (platform === "win32") return path.join(root, "Crank Runtime", "Crank Runtime.exe");
  return path.join(root, "Crank Runtime", "crank-runtime");
}

async function extractRuntime(archive, destination, platform = process.platform, run = execFileAsync) {
  const source = absolutePathSchema.parse(archive);
  const target = absolutePathSchema.parse(destination);
  await mkdir(target, { recursive: true });
  if (platform === "darwin") {
    await run("ditto", ["-x", "-k", source, target]);
    return;
  }
  if (platform === "linux") {
    await run("tar", ["-xzf", source, "-C", target]);
    return;
  }
  if (platform === "win32") {
    await run("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }",
      source,
      target
    ]);
    return;
  }
  throw new Error(`Crank does not include a capture runtime for ${platform}.`);
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  return z.number().int().min(1).max(65535).parse(port);
}

function createBundledRuntimeConnector({
  archive = null,
  executable = null,
  dataDirectory,
  connect = createMcpRpcClient,
  extract = extractRuntime,
  start = spawn,
  startupTimeoutMs = 15_000
}) {
  const runtimeArchive = archive === null ? null : absolutePathSchema.parse(archive);
  const suppliedExecutable = executable === null ? null : absolutePathSchema.parse(executable);
  if (!runtimeArchive && !suppliedExecutable) {
    throw new Error("Crank's bundled capture runtime was not configured.");
  }
  const sharedDataDirectory = absolutePathSchema.parse(dataDirectory);
  let child = null;
  let sessionDirectory = null;
  let connection = null;
  let connecting = null;
  let diagnostics = "";

  const terminate = () => {
    if (child && child.exitCode === null && !child.killed) child.kill("SIGTERM");
  };

  async function launch() {
    sessionDirectory = await mkdtemp(path.join(os.tmpdir(), "crank-codex-runtime-"));
    let runtimeExecutable = suppliedExecutable;
    if (runtimeArchive) {
      await access(runtimeArchive, constants.R_OK).catch(() => {
        throw new Error("Crank's bundled capture runtime is missing. Reinstall the Crank plugin; the desktop app is not a fallback.");
      });
      const extractionDirectory = path.join(sessionDirectory, "runtime");
      await extract(runtimeArchive, extractionDirectory).catch((error) => {
        throw new Error(`Crank's bundled capture runtime could not be unpacked: ${error instanceof Error ? error.message : String(error)}`);
      });
      runtimeExecutable = extractedRuntimeExecutable(extractionDirectory);
    }
    await access(runtimeExecutable, constants.X_OK).catch(() => {
      const condition = runtimeArchive ? "incomplete" : "missing";
      throw new Error(`Crank's bundled capture runtime is ${condition}. Reinstall the Crank plugin; the desktop app is not a fallback.`);
    });
    const tokenPath = path.join(sessionDirectory, "rpc-token");
    const port = await availablePort();
    child = start(runtimeExecutable, ["--mcp-runtime"], {
      env: {
        ...process.env,
        CRANK_USER_DATA_DIR: sharedDataDirectory,
        CRANK_MCP_RPC_PORT: String(port),
        CRANK_MCP_RPC_TOKEN_PATH: tokenPath
      },
      stdio: ["ignore", "ignore", "pipe"]
    });
    child.stderr?.on("data", (chunk) => {
      diagnostics = `${diagnostics}${chunk}`.slice(-16_000);
    });
    let startupFailure = null;
    child.once("error", (error) => { startupFailure = error; });
    child.once("exit", (code, signal) => {
      if (!connection) {
        startupFailure = new Error(
          `Crank's bundled capture runtime stopped before it was ready (${signal ?? code ?? "unknown"}).${diagnostics ? ` ${diagnostics.trim()}` : ""}`
        );
      }
    });
    const deadline = Date.now() + startupTimeoutMs;
    while (Date.now() < deadline) {
      if (startupFailure) throw startupFailure;
      const client = await connect({ tokenPath, port });
      if (client) return client;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    terminate();
    throw new Error(`Crank's bundled capture runtime did not become ready.${diagnostics ? ` ${diagnostics.trim()}` : ""}`);
  }

  return {
    async connect() {
      if (connection) return connection;
      connecting ??= launch()
        .then((client) => (connection = client))
        .catch(async (error) => {
          terminate();
          child = null;
          if (sessionDirectory) await rm(sessionDirectory, { recursive: true, force: true });
          sessionDirectory = null;
          connecting = null;
          throw error;
        });
      return connecting;
    },
    terminate,
    async stop() {
      const active = child;
      terminate();
      if (active && active.exitCode === null) {
        await Promise.race([
          new Promise((resolve) => active.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 2_000))
        ]);
        if (active.exitCode === null) active.kill("SIGKILL");
      }
      child = null;
      connection = null;
      connecting = null;
      if (sessionDirectory) await rm(sessionDirectory, { recursive: true, force: true });
      sessionDirectory = null;
    }
  };
}

module.exports = {
  availablePort,
  bundledRuntimeArchive,
  createBundledRuntimeConnector,
  extractRuntime,
  extractedRuntimeExecutable
};
