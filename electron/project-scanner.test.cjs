const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdir, mkdtemp, rm, writeFile } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { discoverJavascriptProjectRoots, discoverSwiftUiProjectRoots, extractSwiftUiViews, omitWorkspaceContainers, scanJavascriptProject, scanSwiftUiProject } = require("./project-scanner.cjs");

test("extracts SwiftUI views and ignores previews", () => {
  const views = extractSwiftUiViews(`
    import SwiftUI
    struct LibraryView: View {
      var body: some View { NavigationStack { List { Text("Books") } } }
    }
    struct LibraryView_Previews: PreviewProvider { static var previews: some View { LibraryView() } }
  `);
  assert.equal(views.length, 1);
  assert.equal(views[0].name, "Library");
  assert.deepEqual(views[0].patterns, ["Navigation", "List"]);
});

test("discovers SwiftUI project screens and semantic features", async () => {
  const root = path.resolve(__dirname, "..", "test-fixtures", "SwiftSample");
  const result = await scanSwiftUiProject(root);
  assert.ok(result);
  assert.equal(result.kind, "swiftui");
  assert.match(result.screens[0].uiTree.syncId, /^swift\/[a-f0-9]{16}/);
  assert.match(result.screens[0].uiTree.sourceFile, /\.swift$/);
  assert.equal(result.detectedName, "SwiftSample");
  assert.equal(result.screens.length, 3);
  assert.equal(result.screens[0].name, "Home");
  assert.equal(result.screens[0].sfSymbolCount, 1);
  assert.equal(result.screens[1].sourceType, "screen");
  assert.equal(result.screens[2].sourceType, "component");
});

test("recognizes this repository itself as Electron and ignores nested Swift fixtures", async () => {
  const root = path.resolve(__dirname, "..");
  const result = await scanJavascriptProject(root);
  assert.ok(result);
  assert.equal(result.kind, "desktop");
  assert.equal(result.detectedName, "Crank");
  assert.match(result.framework, /Electron \+ React/);
  assert.equal(result.analysisEngine, "Electron Chromium DOM capture");
  assert.deepEqual(result.screens.map((screen) => screen.name), ["Project"]);
});

test("discovers every runnable app in a selected monorepo folder", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-projects-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, "apps", "desktop", "dist"), { recursive: true }),
    mkdir(path.join(root, "apps", "website"), { recursive: true }),
    mkdir(path.join(root, "packages", "ui"), { recursive: true }),
    writeFile(path.join(root, "package.json"), JSON.stringify({ name: "workspace", private: true }))
  ]);
  await Promise.all([
    writeFile(path.join(root, "apps", "desktop", "package.json"), JSON.stringify({
      name: "desktop-app",
      productName: "Desktop App",
      main: "main.js",
      scripts: { start: "electron ." },
      devDependencies: { electron: "latest" }
    })),
    writeFile(path.join(root, "apps", "desktop", "dist", "index.html"), "<main>Desktop</main>"),
    writeFile(path.join(root, "apps", "website", "package.json"), JSON.stringify({
      name: "website",
      scripts: { dev: "vite" },
      dependencies: { react: "latest", vite: "latest" }
    })),
    writeFile(path.join(root, "packages", "ui", "package.json"), JSON.stringify({
      name: "ui-library",
      dependencies: { react: "latest" }
    }))
  ]);

  const discovered = await discoverJavascriptProjectRoots(root);
  assert.deepEqual(discovered.map((entry) => path.relative(root, entry)), ["apps/desktop", "apps/website"]);

  const desktop = await scanJavascriptProject(path.join(root, "apps", "desktop"));
  assert.equal(desktop.kind, "desktop");
  assert.equal(desktop.framework, "Electron + Chromium renderer");
  assert.equal(desktop.screens[0].captureEntry, "dist/index.html");
});

test("hides a zero-screen workspace container when runnable child projects exist", () => {
  const projects = [
    { root: "/workspace", name: "Workspace", screens: [] },
    { root: "/workspace/apps/desktop", name: "Desktop", screens: [{ id: "app" }] },
    { root: "/standalone", name: "Needs build", screens: [] }
  ];
  assert.deepEqual(
    omitWorkspaceContainers(projects).map((project) => project.name),
    ["Desktop", "Needs build"]
  );
});

test("discovers React routes and query-selected Electron windows", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-react-pages-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "dist"), { recursive: true });
  await writeFile(path.join(root, "package.json"), JSON.stringify({
    name: "multi-window",
    scripts: { start: "electron ." },
    dependencies: { react: "latest", "react-router-dom": "latest" },
    devDependencies: { electron: "latest" }
  }));
  await writeFile(path.join(root, "dist", "index.html"), "<main id=\"root\"></main>");
  await writeFile(path.join(root, "main.tsx"), `
    const view = new URLSearchParams(window.location.search).get("view");
    const Root = view === "settings" ? Settings : view === "command-fan" ? CommandFan : App;
    export const routes = <><Route path="/projects" element={<Projects />} /><Route path="/settings" element={<Settings />} /></>;
  `);
  const project = await scanJavascriptProject(root);
  assert.deepEqual(project.screens.map((screen) => [screen.name, screen.capturePath]), [
    ["Home", "/"],
    ["Projects", "/projects"],
    ["Settings", "/settings"],
    ["Settings", "?view=settings"],
    ["Command Fan", "?view=command-fan"]
  ]);
});

test("discovers independently runnable SwiftUI apps in a selected workspace", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-swift-workspace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, "apps", "Trips", "Trips.xcodeproj"), { recursive: true }),
    mkdir(path.join(root, "apps", "Weather", "Weather.xcodeproj"), { recursive: true }),
    mkdir(path.join(root, "packages", "UIComponents"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(path.join(root, "apps", "Trips", "Home.swift"), "import SwiftUI\nstruct Home: View { var body: some View { Text(\"Trips\") } }"),
    writeFile(path.join(root, "apps", "Weather", "Home.swift"), "import SwiftUI\nstruct Home: View { var body: some View { Text(\"Weather\") } }"),
    writeFile(path.join(root, "packages", "UIComponents", "Card.swift"), "import SwiftUI\nstruct Card: View { var body: some View { Text(\"Card\") } }")
  ]);

  const discovered = await discoverSwiftUiProjectRoots(root);
  assert.deepEqual(discovered.map((entry) => path.relative(root, entry)), ["apps/Trips", "apps/Weather"]);
});

test("recognizes a Swift UIKit application as a native iOS project", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-uikit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "UIKitSample.xcodeproj"));
  await writeFile(path.join(root, "AppDelegate.swift"), `import UIKit
@main final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { true }
}`);
  const project = await scanSwiftUiProject(root);
  assert.equal(project.kind, "swiftui");
  assert.equal(project.framework, "UIKit · iOS");
  assert.equal(project.screens[0].uiTree.syncId, "uikit/root");
});

test("discovers App Router pages in Next-compatible frameworks without the next package", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ui-sync-vinext-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({
      name: "vinext-site",
      dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" },
      devDependencies: { vinext: "1.0.0", vite: "^6.0.0" },
      scripts: { dev: "vinext dev" }
    }));
    await writeFile(path.join(root, "next.config.ts"), "export default {};\n");
    await mkdir(path.join(root, "app/api/notes"), { recursive: true });
    await writeFile(path.join(root, "app/api/notes/route.ts"), "export function GET() { return new Response(); }\n");
    for (const relative of ["app/page.tsx", "app/pricing/page.tsx", "app/docs/intro/page.tsx", "app/_internal/page.tsx"]) {
      await mkdir(path.join(root, path.dirname(relative)), { recursive: true });
      await writeFile(path.join(root, relative), "export default function Page() { return null; }\n");
    }
    const result = await scanJavascriptProject(root);
    const routes = result.screens.map((screen) => screen.capturePath).sort();
    assert.deepEqual(routes, ["/", "/docs/intro", "/pricing"], "private _folders and api route handlers must not become pages");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
