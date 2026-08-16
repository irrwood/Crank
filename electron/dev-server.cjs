const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { access, readFile } = require("node:fs/promises");

const scriptPreference = ["dev", "start", "serve", "preview"];

const packageManagerLockfiles = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"]
];

function chooseDevScript(scripts) {
  if (!scripts || typeof scripts !== "object") return null;
  for (const name of scriptPreference) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) return name;
  }
  return null;
}

async function detectPackageManager(root) {
  for (const [lockfile, manager] of packageManagerLockfiles) {
    try {
      await access(path.join(root, lockfile));
      return manager;
    } catch {}
  }
  return "npm";
}

/**
 * Reads a port the project pinned itself, so an already-running server can be
 * recognised. Returns null when the script lets the tool pick a port, because
 * guessing a framework default risks attaching to an unrelated app.
 */
function extractConfiguredPort(script) {
  if (typeof script !== "string") return null;
  const patterns = [
    /--port[=\s]+(\d{2,5})/,
    /(?:^|\s)-p[=\s]+(\d{2,5})/,
    /(?:^|\s)PORT=(\d{2,5})/
  ];
  for (const pattern of patterns) {
    const match = script.match(pattern);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return null;
}

/**
 * Vite highlights the port inside the URL it prints, so escape codes land
 * between the colon and the digits. They must go before the URL is matched.
 */
function stripAnsi(value) {
  return value.replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, "")
    .replace(/\u001B\[[0-9;?]*[ -\/]*[@-~]/g, "");
}

/**
 * Dev servers announce themselves on stdout in varying shapes: Vite prints
 * "Local: http://localhost:5173/", Next "- Local: http://localhost:3000".
 * A port is required, because package managers echo the script source first and
 * that echo can contain a port-less localhost URL built by string concatenation.
 */
function parseServerUrls(chunk) {
  if (typeof chunk !== "string") return [];
  const found = [];
  for (const match of stripAnsi(chunk).matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})(?![\d.])/gi)) {
    let url;
    try {
      url = new URL(match[0]);
    } catch {
      continue;
    }
    if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1";
    url.hash = "";
    url.search = "";
    url.pathname = "/";
    const normalized = url.toString();
    if (!found.includes(normalized)) found.push(normalized);
  }
  return found;
}

function parseServerUrl(chunk) {
  return parseServerUrls(chunk)[0] ?? null;
}

function probeUrl(url, { timeout = 1500 } = {}) {
  return new Promise((resolve) => {
    let request;
    try {
      request = http.get(url, { timeout }, (response) => {
        response.resume();
        resolve(response.statusCode !== undefined && response.statusCode < 500);
      });
    } catch {
      resolve(false);
      return;
    }
    request.on("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.on("error", () => resolve(false));
  });
}

async function waitForServer(url, { attempts = 100, interval = 250, signal } = {}) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) return false;
    if (await probeUrl(url)) return true;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return false;
}

function buildRunArgs(packageManager, scriptName) {
  if (packageManager === "npm") return ["run", scriptName];
  return ["run", scriptName];
}

/**
 * Resolves how a project would be served without starting anything, so callers
 * can surface an actionable error before spawning a process.
 */
async function resolveDevCommand(root) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  } catch {
    return { ok: false, reason: "no-manifest", message: "No package.json was found in this project." };
  }
  const scriptName = chooseDevScript(manifest.scripts);
  if (!scriptName) {
    return {
      ok: false,
      reason: "no-dev-script",
      message: "This project has no dev, start, serve or preview script to run."
    };
  }
  try {
    await access(path.join(root, "node_modules"));
  } catch {
    return {
      ok: false,
      reason: "dependencies-missing",
      message: "Dependencies are not installed. Install them in this project, then try again."
    };
  }
  const packageManager = await detectPackageManager(root);
  const script = manifest.scripts[scriptName];
  return {
    ok: true,
    scriptName,
    script,
    packageManager,
    configuredPort: extractConfiguredPort(script),
    command: `${packageManager} run ${scriptName}`
  };
}

/**
 * Starts (or attaches to) the project's own dev server so the preview reuses
 * the project's HMR pipeline rather than reimplementing refresh.
 */
async function startDevServer(root, { onLog, startTimeoutMs = 60000 } = {}) {
  const resolved = await resolveDevCommand(root);
  if (!resolved.ok) return resolved;

  if (resolved.configuredPort) {
    const existing = `http://127.0.0.1:${resolved.configuredPort}/`;
    if (await probeUrl(existing)) {
      return { ok: true, url: existing, origin: new URL(existing).origin, attached: true, command: resolved.command };
    }
  }

  const child = spawn(resolved.packageManager, buildRunArgs(resolved.packageManager, resolved.scriptName), {
    cwd: root,
    env: { ...process.env, BROWSER: "none", FORCE_COLOR: "0" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  const candidates = [];
  let exited = null;
  const output = [];
  const collect = (chunk) => {
    const text = chunk.toString();
    output.push(text);
    if (output.length > 200) output.shift();
    onLog?.(text);
    for (const url of parseServerUrls(text)) {
      if (!candidates.includes(url)) candidates.push(url);
    }
  };
  child.stdout.on("data", collect);
  child.stderr.on("data", collect);
  child.on("exit", (code) => { exited = code ?? 0; });
  child.on("error", () => { exited = -1; });

  const deadline = Date.now() + startTimeoutMs;
  while (Date.now() < deadline) {
    if (exited !== null) {
      return {
        ok: false,
        reason: "exited",
        message: `${resolved.command} exited before serving a page.`,
        output: output.join("").slice(-4000)
      };
    }
    for (const candidate of candidates) {
      if (!await probeUrl(candidate)) continue;
      return {
        ok: true,
        url: candidate,
        origin: new URL(candidate).origin,
        attached: false,
        command: resolved.command,
        stop: () => stopDevServer(child)
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  stopDevServer(child);
  return {
    ok: false,
    reason: "timeout",
    message: `${resolved.command} did not report a local URL in time.`,
    output: output.join("").slice(-4000)
  };
}

function stopDevServer(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    // The package-manager wrapper spawns the real server, so signal the group.
    if (process.platform === "win32") child.kill();
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

module.exports = {
  buildRunArgs,
  chooseDevScript,
  detectPackageManager,
  extractConfiguredPort,
  parseServerUrl,
  parseServerUrls,
  probeUrl,
  stripAnsi,
  resolveDevCommand,
  startDevServer,
  stopDevServer,
  waitForServer
};
