const test = require("node:test");
const assert = require("node:assert/strict");
const { attachDisplayListAgent, shimSource, startDisplayListCapture } = require("./swift-display-list-agent.cjs");

const APP = `import SwiftUI

@main
struct SampleApp: App {
  var body: some Scene { WindowGroup { HomeView() } }
}
`;

test("the capture is started from the app's own entry point", () => {
  const { source, started } = startDisplayListCapture(APP, "a1b2c3");
  assert.equal(started, true);
  assert.match(source, /init\(\) \{ Task \{ @MainActor in _CrankDisplayListShim_a1b2c3\.start\(\) \} \}/);
  // Inserted inside the type, not before it, or it would not compile.
  assert.ok(source.indexOf("init()") > source.indexOf("struct SampleApp: App {"));
  assert.ok(source.indexOf("init()") < source.indexOf("var body"));
});

test("a file with no entry point is handed back untouched", () => {
  const other = "import SwiftUI\n\nstruct HomeView: View { var body: some View { Text(\"hi\") } }\n";
  const { source, started } = startDisplayListCapture(other, "a1b2c3");
  assert.equal(started, false);
  assert.equal(source, other);
});

test("every symbol carries the suffix, so two scans cannot collide", () => {
  const shim = shimSource({ endpoint: "http://127.0.0.1:1/x", suffix: "deadbe", screenName: "Home" });
  assert.match(shim, /_CrankDisplayListShim_deadbe/);
  assert.doesNotMatch(shim, /_CrankDisplayListShim_(?!deadbe)/);
});

test("the endpoint and screen name are quoted as Swift, not pasted in", () => {
  const shim = shimSource({
    endpoint: 'http://127.0.0.1:1/x"; system("rm -rf /"); //',
    suffix: "deadbe",
    screenName: 'A "quoted" name'
  });
  // The quotes are what matter: an endpoint that could close the Swift string
  // literal early would be arbitrary code in someone's build.
  assert.ok(shim.includes('URL(string: "http://127.0.0.1:1/x\\"; system(\\"rm -rf /\\"); //")'));
  assert.ok(shim.includes('"A \\"quoted\\" name"'));
});

test("a suffix that is not the instrumentation's own is refused", async () => {
  await assert.rejects(
    () => attachDisplayListAgent("import SwiftUI\n", { endpoint: "http://127.0.0.1:1/x", suffix: "not hex" }),
    /hex suffix/
  );
});

test("the agent and the shim both arrive in the file", async () => {
  const source = await attachDisplayListAgent(APP, {
    endpoint: "http://127.0.0.1:1/x",
    suffix: "a1b2c3",
    screenName: "Home"
  });
  assert.match(source, /enum CrankDisplayList \{/);
  assert.match(source, /enum _CrankDisplayListShim_a1b2c3 \{/);
  // The app's own source is still the first thing in the file.
  assert.ok(source.startsWith(APP));
});

test("nothing the agent adds compiles into a release build", async () => {
  const source = await attachDisplayListAgent(APP, { endpoint: "http://127.0.0.1:1/x", suffix: "a1b2c3" });
  const added = source.slice(APP.length);
  // Every added region opens with a DEBUG guard, so a project scanned once does
  // not carry a reflection-based capture into anything it ships.
  assert.equal((added.match(/#if DEBUG/g) ?? []).length, 2);
  assert.equal((added.match(/#endif/g) ?? []).length, added.match(/#if/g).length);
});
