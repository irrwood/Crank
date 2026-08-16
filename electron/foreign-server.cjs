const path = require("node:path");
const { spawn } = require("node:child_process");
const { access, readFile, readdir } = require("node:fs/promises");
const { probeUrl } = require("./dev-server.cjs");

/**
 * Runs a project UI Sync has no native support for, using only what the
 * project declares about itself: the command from its Dockerfile, Procfile or
 * README, the environment from its compose file, and the interpreter sitting
 * in its own virtual environment.
 *
 * Nothing here is invented. A guessed command that half-starts is worse than
 * an honest refusal, because the scan then reports pages that are wrong rather
 * than reporting nothing.
 */

const venvNames = [".venv", "venv", "env", ".virtualenv"];

async function isDirectory(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the project's own interpreter. Its location also settles the working
 * directory: a virtual environment sits at the root of the Python project, so
 * a venv in `v3_backend/` means the code runs from `v3_backend/`.
 */
async function findInterpreter(root, { maxDepth = 2 } = {}) {
  const queue = [{ directory: root, depth: 0 }];
  while (queue.length > 0) {
    const { directory, depth } = queue.shift();
    for (const name of venvNames) {
      const candidate = path.join(directory, name, "bin", "python");
      if (await isDirectory(candidate)) {
        return { python: candidate, binDirectory: path.dirname(candidate), workingDirectory: directory };
      }
    }
    if (depth >= maxDepth) continue;
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {}
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || ["node_modules", "__pycache__", "dist", "build"].includes(entry.name)) continue;
      queue.push({ directory: path.join(directory, entry.name), depth: depth + 1 });
    }
  }
  return null;
}

/**
 * Reads the environment a compose file declares. Projects use it to select a
 * mode that needs no credentials, which is exactly the mode worth scanning.
 */
function parseComposeEnvironment(compose) {
  if (typeof compose !== "string") return {};
  const environment = {};
  const lines = compose.split("\n");
  let inside = false;
  let indent = 0;
  for (const line of lines) {
    if (/^\s*environment:\s*$/.test(line)) {
      inside = true;
      indent = line.search(/\S/);
      continue;
    }
    if (!inside) continue;
    if (line.trim() === "") continue;
    const currentIndent = line.search(/\S/);
    if (currentIndent <= indent) {
      inside = false;
      continue;
    }
    const match = line.match(/^\s*-\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match && !line.trim().startsWith("#")) environment[match[1]] = match[2].trim();
  }
  return environment;
}

function portOf(command, fallback) {
  const match = String(command ?? "").match(/--port[=\s]+(\d{2,5})/);
  return match ? Number(match[1]) : fallback;
}

/**
 * Starts the declared command with the project's interpreter on PATH.
 *
 * Uses a shell because declared commands carry inline environment prefixes
 * ("CATFOLIO_DEMO=1 uvicorn …"). This is the project's own command, the same
 * trust already extended to an npm dev script.
 */
async function startForeignServer(root, foreign, { onLog, startTimeoutMs = 90_000 } = {}) {
  const chosen = foreign?.commands?.[0];
  if (!chosen) return { ok: false, reason: "no-command", message: "This project declares no command to start it." };

  const interpreter = await findInterpreter(root);
  if (!interpreter) {
    return {
      ok: false,
      reason: "no-interpreter",
      message: "No virtual environment was found in this project. Create one and install its dependencies, then try again."
    };
  }

  const port = portOf(chosen.command, foreign.port);
  if (!port) return { ok: false, reason: "no-port", message: "The declared command names no port to serve on." };

  const url = `http://127.0.0.1:${port}/`;
  if (await probeUrl(url)) {
    return { ok: true, url, origin: `http://127.0.0.1:${port}`, attached: true, command: `already running on ${port}` };
  }

  const compose = await readFile(path.join(root, "docker-compose.yml"), "utf8").catch(() => null);
  const declaredEnvironment = parseComposeEnvironment(compose);

  // Bind to the loopback interface: the declared command often targets
  // 0.0.0.0 because it was written for a container, which would expose the
  // user's project to their whole network.
  const command = chosen.command.replace(/--host[=\s]+0\.0\.0\.0/g, "--host 127.0.0.1");

  const child = spawn("/bin/sh", ["-c", command], {
    cwd: interpreter.workingDirectory,
    env: {
      ...process.env,
      ...declaredEnvironment,
      PATH: `${interpreter.binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
      PYTHONUNBUFFERED: "1"
    },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const output = [];
  let exited = null;
  const collect = (chunk) => {
    const text = chunk.toString();
    output.push(text);
    if (output.length > 200) output.shift();
    onLog?.(text);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.on("error", () => { exited = -1; });
  child.on("exit", (code) => { exited = code ?? 0; });

  const stop = () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      child.kill("SIGKILL");
    }
  };

  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeUrl(url)) {
      return {
        ok: true,
        url,
        origin: `http://127.0.0.1:${port}`,
        attached: false,
        command: `${chosen.command}  (declared in ${chosen.source})`,
        stop
      };
    }
    if (exited !== null) {
      const tail = output.join("").trim().split("\n").slice(-3).join(" ").slice(0, 300);
      stop();
      return {
        ok: false,
        reason: "exited",
        message: `The project's own command exited before serving a page.${tail ? ` Last output: ${tail}` : ""}`,
        output: output.join("").slice(-4000)
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  stop();
  return { ok: false, reason: "timeout", message: `Nothing answered on port ${port} within ${Math.round(startTimeoutMs / 1000)}s.` };
}

module.exports = { findInterpreter, parseComposeEnvironment, portOf, startForeignServer };
