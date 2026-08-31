const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { projectsInside } = require("./folder-projects.cjs");

const temporary = () => mkdtemp(path.join(os.tmpdir(), "crank-folder-projects-"));

async function javascriptApp(root, name) {
  await mkdir(path.join(root, name), { recursive: true });
  await writeFile(
    path.join(root, name, "package.json"),
    // A runnable script and a UI runtime, which is what makes a folder a
    // project the scanner will start.
    JSON.stringify({ name, scripts: { dev: "vite" }, dependencies: { react: "^18" } })
  );
}

async function xcodeApp(root, name) {
  await mkdir(path.join(root, name, `${name}.xcodeproj`), { recursive: true });
  await writeFile(path.join(root, name, `${name}.xcodeproj`, "project.pbxproj"), "// fixture");
}

test("both kinds of project in one folder are found", async () => {
  // A Python service with an iOS client beside it is one repository, and only
  // looking for JavaScript is how the client ended up with nowhere to appear.
  const root = await temporary();
  await writeFile(path.join(root, "requirements.txt"), "flask");
  await javascriptApp(root, "site");
  await xcodeApp(root, "MobileClient");

  assert.deepEqual(await projectsInside(root), [
    path.join(root, "MobileClient"),
    path.join(root, "site")
  ]);
});

test("a folder that is itself an Xcode project holds nothing to list", async () => {
  const root = await temporary();
  await mkdir(path.join(root, "App.xcodeproj"), { recursive: true });
  await writeFile(path.join(root, "App.xcodeproj", "project.pbxproj"), "// fixture");
  assert.deepEqual(await projectsInside(root), []);
});

test("the folder never lists itself", async () => {
  const root = await temporary();
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "top", scripts: { dev: "vite" }, dependencies: { react: "^18" } }));
  await javascriptApp(root, "packages-web");
  const found = await projectsInside(root);
  assert.ok(!found.includes(path.resolve(root)));
  assert.deepEqual(found, [path.join(root, "packages-web")]);
});

test("an empty folder holds no projects", async () => {
  assert.deepEqual(await projectsInside(await temporary()), []);
});
