const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const { findAppIconSet, largestDeclaredIcon, readXcodeAppIcon } = require("./xcode-app-icon.cjs");

async function project({ icons = ["Icon-40@2x.png", "Icon-1024.png"], contents = null, nested = "FocusFlow/Assets.xcassets" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-xcode-icon-"));
  await mkdir(path.join(root, "FocusFlow.xcodeproj"), { recursive: true });
  const set = path.join(root, nested, "AppIcon.appiconset");
  await mkdir(set, { recursive: true });
  for (const icon of icons) await writeFile(path.join(set, icon), "not really a png");
  if (contents) await writeFile(path.join(set, "Contents.json"), JSON.stringify(contents));
  return { root, set };
}

test("finds the icon set wherever in the project it was put", async () => {
  const { root, set } = await project();
  assert.equal(await findAppIconSet(root), set);
});

test("says nothing rather than something approximate when a project has no icon", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-xcode-noicon-"));
  await mkdir(path.join(root, "FocusFlow.xcodeproj"), { recursive: true });
  assert.equal(await readXcodeAppIcon(root), null);
});

test("takes the largest picture the catalog declares", () => {
  const filename = largestDeclaredIcon({
    images: [
      { filename: "Icon-40@2x.png", size: "40x40", scale: "2x" },
      { filename: "Icon-1024.png", size: "1024x1024", scale: "1x" },
      { filename: "Icon-60@3x.png", size: "60x60", scale: "3x" },
      { size: "20x20", scale: "1x" }
    ]
  });
  assert.equal(filename, "Icon-1024.png");
});

test("reads the declared icon and hands it over as something a row can draw", async () => {
  const { root } = await project({
    contents: { images: [{ filename: "Icon-1024.png", size: "1024x1024", scale: "1x" }] }
  });
  const icon = await readXcodeAppIcon(root, {
    resize: async (source, target) => {
      assert.match(source, /Icon-1024\.png$/);
      await writeFile(target, Buffer.from([137, 80, 78, 71]));
      return target;
    }
  });
  assert.match(icon, /^data:image\/png;base64,/);
});

test("tries another picture when the catalog names one it does not hold", async () => {
  const { root } = await project({
    icons: ["Icon-60@3x.png"],
    contents: { images: [{ filename: "Missing.png", size: "1024x1024", scale: "1x" }] }
  });
  const seen = [];
  const icon = await readXcodeAppIcon(root, {
    resize: async (source, target) => {
      seen.push(path.basename(source));
      if (seen.length === 1) throw new Error("no such file");
      await writeFile(target, Buffer.from([137, 80, 78, 71]));
      return target;
    }
  });
  assert.deepEqual(seen, ["Missing.png", "Icon-60@3x.png"]);
  assert.match(icon, /^data:image\/png;base64,/);
});
