const assert = require("node:assert/strict");
const test = require("node:test");
const {
  collectSwiftNativeButtons,
  placeSwiftNativeButtons,
  toolbarRanges
} = require("./swift-native-buttons.cjs");

// The expressions are real ones, taken from projects this was built against.
const closeInToolbar = `Button("CLOSE") {
                        dismiss()
                    }
                    .font(.system(size: 13, weight: .bold))
                    .tracking(1.8)
                    .foregroundStyle(Color.flowInk)`;
const designedButton = `Button("去录音") {
                viewModel.switchToRecordTab()
            }
            .frame(height: 42)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(palette.blue)
            )`;
const iconButton = `Button { isShowingSettings = true } label: { Image(systemName: "gearshape").font(.system(size: 18)) }`;

const settingsSource = `struct SettingsView: View {
  var body: some View {
    NavigationStack {
      List { Text("hello") }
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          ${closeInToolbar}
        }
      }
    }
  }
}`;

function screenOf(nodes) {
  return { type: "vstack", children: nodes };
}

test("finds a toolbar button, which is the system's however plainly it is written", () => {
  const offset = settingsSource.indexOf('Button("CLOSE")');
  const ranges = new Map([["SettingsView.swift", toolbarRanges(settingsSource)]]);
  const buttons = collectSwiftNativeButtons(screenOf([{
    type: "button",
    syncId: "swift/aaaa",
    sourceFile: "SettingsView.swift",
    sourceExpression: closeInToolbar,
    sourceRange: { startOffset: offset }
  }]), ranges);
  assert.deepEqual(buttons, [{ syncId: "swift/aaaa", label: "CLOSE", material: "glass", reason: "toolbar" }]);
});

test("leaves a button that draws its own background exactly as it was exported", () => {
  const buttons = collectSwiftNativeButtons(screenOf([{
    type: "button",
    syncId: "swift/bbbb",
    sourceFile: "SequenceView.swift",
    sourceExpression: designedButton,
    sourceRange: { startOffset: 0 }
  }]), new Map([["SequenceView.swift", [[0, 10_000]]]]));
  assert.deepEqual(buttons, []);
});

test("leaves an icon-only button alone: the component being filled has words in it", () => {
  const buttons = collectSwiftNativeButtons(screenOf([{
    type: "button",
    syncId: "swift/cccc",
    sourceFile: "RootView.swift",
    sourceExpression: iconButton,
    sourceRange: { startOffset: 0 }
  }]), new Map([["RootView.swift", [[0, 10_000]]]]));
  assert.deepEqual(buttons, []);
});

test("reads the style when the project names one, wherever the button sits", () => {
  const buttons = collectSwiftNativeButtons(screenOf([
    {
      type: "button",
      syncId: "swift/dddd",
      sourceFile: "HomeView.swift",
      sourceExpression: `Button("Get Started") { start() }.buttonStyle(.glassProminent).controlSize(.large)`,
      sourceRange: { startOffset: 0 }
    },
    {
      type: "button",
      syncId: "swift/eeee",
      sourceFile: "HomeView.swift",
      sourceExpression: `Button("Later") { }.buttonStyle(.bordered)`,
      sourceRange: { startOffset: 0 }
    }
  ]), new Map());
  assert.deepEqual(buttons, [
    { syncId: "swift/dddd", label: "Get Started", material: "glassProminent", reason: "buttonStyle", controlSize: "large" },
    { syncId: "swift/eeee", label: "Later", material: "glass", reason: "buttonStyle" }
  ]);
});

test("a plain button in the body of a screen is not a glass button", () => {
  const buttons = collectSwiftNativeButtons(screenOf([{
    type: "button",
    syncId: "swift/ffff",
    sourceFile: "HomeView.swift",
    sourceExpression: `Button("Skip") { skip() }.foregroundStyle(.secondary)`,
    sourceRange: { startOffset: 0 }
  }]), new Map([["HomeView.swift", []]]));
  assert.deepEqual(buttons, [], "SwiftUI draws that one as plain text, not as a capsule");
});

test("places each button where the run drew it, in the page's own coordinates", () => {
  const placed = placeSwiftNativeButtons(
    [{ syncId: "swift/aaaa", label: "CLOSE", material: "glass", reason: "toolbar" }],
    {
      environment: { viewport: { x: 0, y: 0, width: 402, height: 874 } },
      nodes: [{ syncId: "swift/aaaa", pageSourceName: "SettingsView", frame: { x: 20, y: 60, width: 60, height: 30 } }]
    },
    "SettingsView",
    { x: 0, y: 0, width: 402, height: 874, outputWidth: 804, outputHeight: 1748 }
  );
  assert.deepEqual(placed[0].frame, { x: 40, y: 120, width: 120, height: 60 });
});

test("drops a button the run never reached rather than guessing where it is", () => {
  const placed = placeSwiftNativeButtons(
    [{ syncId: "swift/aaaa", label: "CLOSE", material: "glass", reason: "toolbar" }],
    { nodes: [] },
    "SettingsView"
  );
  assert.deepEqual(placed, []);
});

test("reads nested toolbar blocks without swallowing the rest of the file", () => {
  const ranges = toolbarRanges(settingsSource);
  assert.equal(ranges.length, 1);
  const [start, end] = ranges[0];
  assert.ok(start < settingsSource.indexOf('Button("CLOSE")'));
  assert.ok(end > settingsSource.indexOf('Button("CLOSE")'));
  assert.ok(end < settingsSource.length - 1, "the block ends before the file does");
});
