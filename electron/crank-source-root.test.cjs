const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdir, mkdtemp, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { isCrankSourceRoot } = require("./crank-source-root.cjs");

test("the packaged runtime still recognises a Crank source checkout", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crank-source-root-"));
  await Promise.all([
    mkdir(path.join(root, "electron"), { recursive: true }),
    mkdir(path.join(root, "src"), { recursive: true }),
    mkdir(path.join(root, "dist"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "crank-desktop",
      productName: "Crank",
      main: "electron/main.cjs"
    })),
    writeFile(path.join(root, "electron", "self-scan-preload.cjs"), ""),
    writeFile(path.join(root, "src", "PageInventoryView.tsx"), ""),
    writeFile(path.join(root, "dist", "index.html"), "")
  ]);
  assert.equal(await isCrankSourceRoot(root), true);
});

test("an ordinary project is never treated as Crank itself", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ordinary-source-root-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "customer-app",
    productName: "Crank",
    main: "electron/main.cjs"
  }));
  assert.equal(await isCrankSourceRoot(root), false);
});
