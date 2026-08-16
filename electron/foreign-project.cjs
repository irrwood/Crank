const path = require("node:path");
const { readFile } = require("node:fs/promises");

/**
 * Describes how to start a project UI Sync cannot run itself.
 *
 * Only declarations are reported — a Dockerfile CMD, a compose port, a
 * Procfile entry, a command the README puts in a code fence. Inventing a
 * plausible command for someone's project would be guessing, and a half-working
 * start produces a confusing scan rather than an honest failure.
 */

const markers = [
  { file: "requirements.txt", kind: "Python" },
  { file: "pyproject.toml", kind: "Python" },
  { file: "manage.py", kind: "Django" },
  { file: "Gemfile", kind: "Ruby" },
  { file: "go.mod", kind: "Go" },
  { file: "Cargo.toml", kind: "Rust" },
  { file: "composer.json", kind: "PHP" },
  { file: "pom.xml", kind: "Java" },
  { file: "build.gradle", kind: "Java" }
];

const serverCommandPattern = /\b(?:uvicorn|gunicorn|hypercorn|daphne|flask run|rails server|rails s|php -S|python -m http\.server|python manage\.py runserver|go run|cargo run|bundle exec|npm|pnpm|yarn|air|mix phx\.server)\b/i;

function readPort(text) {
  if (typeof text !== "string") return null;
  const patterns = [
    /--port[=\s]+(\d{2,5})/,
    /-p[=\s]+(\d{2,5})/,
    /EXPOSE\s+(\d{2,5})/i,
    /"(\d{2,5}):\d{2,5}"/,
    /(?:^|\s)(\d{2,5}):\d{2,5}(?:\s|$)/m,
    /localhost:(\d{2,5})/,
    /127\.0\.0\.1:(\d{2,5})/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  }
  return null;
}

async function read(root, file) {
  try {
    return await readFile(path.join(root, file), "utf8");
  } catch {
    return null;
  }
}

/**
 * Parses a Dockerfile CMD/ENTRYPOINT in either form: the JSON array
 * `["python","-m","uvicorn"]` or the plain shell string.
 */
function parseDockerCommand(dockerfile) {
  if (typeof dockerfile !== "string") return null;
  const match = dockerfile.match(/^\s*(?:CMD|ENTRYPOINT)\s+(.+)$/im);
  if (!match) return null;
  const raw = match[1].trim();
  if (raw.startsWith("[")) {
    try {
      const parts = JSON.parse(raw);
      if (Array.isArray(parts) && parts.every((part) => typeof part === "string")) return parts.join(" ");
    } catch {}
    return null;
  }
  return raw;
}

function readmeCommands(readme) {
  if (typeof readme !== "string") return [];
  const found = [];
  for (const fence of readme.matchAll(/```(?:bash|sh|shell|console)?\n([\s\S]*?)```/g)) {
    for (const line of fence[1].split("\n")) {
      const command = line.replace(/^\s*[$#>]\s*/, "").trim();
      if (!command || command.startsWith("#")) continue;
      if (!serverCommandPattern.test(command)) continue;
      if (!found.includes(command)) found.push(command);
      if (found.length >= 3) return found;
    }
  }
  return found;
}

/**
 * @returns null when the folder has no recognisable non-Node project in it.
 */
async function describeForeignProject(root) {
  const [dockerfile, compose, procfile, readme] = await Promise.all([
    read(root, "Dockerfile"),
    read(root, "docker-compose.yml"),
    read(root, "Procfile"),
    read(root, "README.md")
  ]);

  let kind = null;
  for (const marker of markers) {
    if (await read(root, marker.file)) {
      kind = marker.kind;
      break;
    }
  }
  if (!kind && !dockerfile && !compose && !procfile) return null;

  const commands = [];
  const add = (source, command) => {
    if (!command) return;
    const trimmed = command.trim();
    if (!trimmed || commands.some((entry) => entry.command === trimmed)) return;
    commands.push({ source, command: trimmed });
  };

  for (const command of readmeCommands(readme)) add("README", command);
  add("Dockerfile", parseDockerCommand(dockerfile));
  const web = procfile?.match(/^\s*web:\s*(.+)$/im);
  add("Procfile", web?.[1]);

  const port = readPort(commands.map((entry) => entry.command).join("\n"))
    ?? readPort(dockerfile)
    ?? readPort(compose);

  return { kind: kind ?? "Container", commands, port };
}

module.exports = { describeForeignProject, parseDockerCommand, readPort, readmeCommands };
