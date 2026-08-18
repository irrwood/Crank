const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { describeForeignProject, parseDockerCommand, readPort, readmeCommands } = require("./foreign-project.cjs");

async function folder(files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-foreign-"));
  for (const [name, contents] of Object.entries(files)) await writeFile(path.join(root, name), contents);
  return root;
}

test("reads a Dockerfile CMD in both forms", () => {
  assert.equal(
    parseDockerCommand('EXPOSE 8787\nCMD ["python", "-m", "uvicorn", "app.main:app", "--port", "8787"]'),
    "python -m uvicorn app.main:app --port 8787"
  );
  assert.equal(parseDockerCommand("CMD gunicorn app:app -b 0.0.0.0:5000"), "gunicorn app:app -b 0.0.0.0:5000");
  assert.equal(parseDockerCommand("FROM python:3.11"), null);
  assert.equal(parseDockerCommand(null), null);
});

test("takes only server commands out of a README", () => {
  const readme = [
    "## Quick Start", "```bash", "pip install -r requirements.txt",
    "CATFOLIO_DEMO=1 uvicorn app.main:app --host 127.0.0.1 --port 8787", "```",
    "```bash", "# a comment", "pytest", "```"
  ].join("\n");
  const commands = readmeCommands(readme);
  assert.deepEqual(commands, ["CATFOLIO_DEMO=1 uvicorn app.main:app --host 127.0.0.1 --port 8787"]);
  assert.deepEqual(readmeCommands(null), []);
});

test("finds the port a project publishes", () => {
  assert.equal(readPort("uvicorn app:app --port 8787"), 8787);
  assert.equal(readPort("EXPOSE 8787"), 8787);
  assert.equal(readPort('ports:\n  - "8787:8787"'), 8787);
  assert.equal(readPort("visit http://localhost:4000"), 4000);
  assert.equal(readPort("no port here"), null);
});

test("describes a Python project from what it declares", async () => {
  const root = await folder({
    "requirements.txt": "fastapi\nuvicorn\n",
    Dockerfile: 'FROM python:3.11\nEXPOSE 8787\nCMD ["python", "-m", "uvicorn", "app.main:app", "--port", "8787"]\n',
    "README.md": "## Quick Start\n```bash\nuvicorn app.main:app --host 127.0.0.1 --port 8787\n```\n"
  });
  try {
    const described = await describeForeignProject(root);
    assert.equal(described.kind, "Python");
    assert.equal(described.port, 8787);
    assert.ok(described.commands.some((entry) => entry.source === "README" && /uvicorn/.test(entry.command)));
    assert.ok(described.commands.some((entry) => entry.source === "Dockerfile"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("says nothing about a folder it does not recognise", async () => {
  const root = await folder({ "notes.txt": "hello" });
  try {
    assert.equal(await describeForeignProject(root), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("still helps when only a Procfile declares the command", async () => {
  const root = await folder({ Procfile: "web: bundle exec rails server -p 3000\n", Gemfile: "source 'x'\n" });
  try {
    const described = await describeForeignProject(root);
    assert.equal(described.kind, "Ruby");
    assert.equal(described.port, 3000);
    assert.equal(described.commands[0].source, "Procfile");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
