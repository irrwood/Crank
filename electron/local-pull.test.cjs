const assert = require("node:assert/strict");
const test = require("node:test");
const { mkdtemp, mkdir, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { buildPullPreview, buildSwiftCodeScreens, createSwiftPatchPlan, flattenEditableDom, patchCssRule, patchTailwindClassName } = require("./local-pull.cjs");

test("flattens editable DOM without treating transparent fills as changes", () => {
  const nodes = flattenEditableDom({
    id: "root", selector: ".app", kind: "element", width: 400, height: 300,
    style: { backgroundColor: "rgba(0, 0, 0, 0)", borderRadius: 0 },
    children: [{
      id: "root/text:0", selector: ".title", kind: "text", text: "Hello", width: 80, height: 24,
      style: { fontSize: 18, fontWeight: 600 }
    }]
  });
  assert.equal(nodes[0].backgroundColor, null);
  assert.equal(nodes[1].text, "Hello");
  assert.equal(nodes[1].fontWeight, 600);
});

test("builds a safe Figma-only pull and reports divergent conflicts", () => {
  const base = [{ id: "root", selector: ".card", kind: "element", width: 320, height: 180, backgroundColor: "rgb(255, 255, 255)", radius: 12, fontSize: null, fontWeight: null, text: null }];
  const safe = buildPullPreview({ screen: base }, { screen: base }, { screen: [{ ...base[0], radius: 24 }] });
  assert.equal(safe.changes.length, 1);
  assert.equal(safe.changes[0].property, "radius");
  const conflict = buildPullPreview({ screen: base }, { screen: [{ ...base[0], radius: 16 }] }, { screen: [{ ...base[0], radius: 24 }] });
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.changes.length, 0);
});

test("patches an exact CSS identity while preserving unrelated declarations", () => {
  const source = `.card {\n  display: flex;\n  border-radius: 12px;\n}\n\n.other { color: red; }\n`;
  const next = patchCssRule(source, ".card", "border-radius", "24px");
  assert.match(next, /display: flex;/);
  assert.match(next, /border-radius: 24px;/);
  assert.match(next, /\.other \{ color: red; \}/);
});

test("patches one static Tailwind identity without touching unrelated className values", () => {
  const source = `export function Card() { return <><article className="card w-80 rounded-xl bg-white">Hi</article><div className="rounded-xl" /></>; }`;
  const next = patchTailwindClassName(source, ".card", { property: "radius", figma: 24 });
  assert.match(next, /className="card w-80 rounded-\[24px\] bg-white"/);
  assert.match(next, /className="rounded-xl"/);
});

test("overlays current SwiftUI text semantics onto the last Figma baseline", () => {
  const base = [{ id: "swift/0123456789abcdef/text", selector: "Views/Home.swift#HomeView", kind: "text", width: 100, height: 24, backgroundColor: null, radius: null, fontSize: 17, fontWeight: 400, text: "Before" }];
  const screens = [{ id: "home", uiTree: { syncId: "swift/0123456789abcdef", sourceFile: "Views/Home.swift", sourceName: "HomeView", type: "text", text: "After", fontSize: 20, fontWeight: "bold" } }];
  const result = buildSwiftCodeScreens({ home: base }, screens);
  assert.equal(result.home[0].text, "After");
  assert.equal(result.home[0].fontSize, 20);
  assert.equal(result.home[0].fontWeight, 700);
});

test("creates a deterministic SwiftUI text and font patch in its mapped file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-swift-"));
  await mkdir(path.join(root, "Views"));
  await writeFile(path.join(root, "Views", "Home.swift"), `import SwiftUI\nstruct HomeView: View { var body: some View { Text("Before").font(.system(size: 17, weight: .regular)) } }\n`);
  const plan = await createSwiftPatchPlan(root, [
    { id: "text", selector: "Views/Home.swift#HomeView", property: "text", code: "Before", figma: "After", sourceText: "Before" },
    { id: "size", selector: "Views/Home.swift#HomeView", property: "fontSize", code: 17, figma: 20, sourceText: "After" }
  ]);
  assert.equal(plan.rejected.length, 0);
  assert.match(plan.changedFiles[0].next, /Text\("After"\)/);
  assert.match(plan.changedFiles[0].next, /size: 20/);
});
