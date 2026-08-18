const assert = require("node:assert/strict");
const test = require("node:test");
const { buildSwiftUiIr, uiNodeSchema } = require("./swiftui-ir.cjs");

test("normalizes SwiftUI navigation, lists, labels, and symbols into UI IR", () => {
  const tree = buildSwiftUiIr(`
    struct HomeView: View {
      var body: some View {
        NavigationStack {
          List { Label("Saved", systemImage: "bookmark") }
            .navigationTitle("Home")
        }
      }
    }
  `);
  assert.equal(tree.type, "navigation");
  assert.equal(tree.title, "Home");
  assert.equal(tree.children[0].type, "list");
  assert.deepEqual(tree.children[0].children[0], { type: "label", text: "Saved", symbol: "bookmark" });
  assert.doesNotThrow(() => uiNodeSchema.parse(tree));
});

test("captures layout and typography without retaining Swift source", () => {
  const tree = buildSwiftUiIr(`
    struct ProfileView: View {
      var body: some View {
        ScrollView {
          VStack { Text("Profile").font(.title).fontWeight(.bold) }.padding(20)
        }
      }
    }
  `);
  assert.equal(tree.type, "scroll");
  assert.deepEqual(tree.children[0].padding, { top: 20, right: 20, bottom: 20, left: 20 });
  assert.equal(tree.children[0].children[0].text, "Profile");
  assert.equal(tree.children[0].children[0].fontStyle, "title");
  assert.equal(tree.children[0].children[0].fontWeight, "bold");
  assert.equal(JSON.stringify(tree).includes("struct ProfileView"), false);
});

test("preserves directional padding, stack layout, button labels, and panel styling", () => {
  const tree = buildSwiftUiIr(`
    struct SettingsView: View {
      var body: some View {
        VStack(alignment: .leading, spacing: 18) {
          Button {} label: {
            HStack(spacing: 8) { Image(systemName: "arrow.clockwise"); Text("FETCH") }
              .padding(.horizontal, 14)
              .frame(height: 38)
              .background(Capsule().fill(Color.flowAccent))
          }
        }
        .padding(.horizontal, 22)
        .padding(.top, 12)
        .padding(.bottom, 32)
        .flowPanel()
      }
    }
  `);
  assert.equal(tree.alignment, "leading");
  assert.equal(tree.spacing, 18);
  assert.deepEqual(tree.padding, { top: 12, right: 22, bottom: 32, left: 22 });
  assert.equal(tree.backgroundColorToken, "flowPanel");
  assert.equal(tree.children[0].children[0].type, "hstack");
  assert.equal(tree.children[0].children[0].backgroundColorToken, "flowAccent");
  assert.equal(tree.children[0].children[0].backgroundShape, "capsule");
});

test("accepts SwiftUI negative padding used for visual bleed", () => {
  const tree = buildSwiftUiIr(`
    struct BleedView: View {
      var body: some View {
        VStack {
          Text("Bleed")
            .padding(.top, -150)
            .padding(.horizontal, -3)
        }
      }
    }
  `);
  assert.deepEqual(tree.children[0].padding, { top: -150, right: -3, bottom: 0, left: -3 });
});

test("selects the initial SwiftUI state and preserves layout-critical modifiers", () => {
  const tree = buildSwiftUiIr(`
    struct CaptureView: View {
      var body: some View {
        VStack {
          if isRecording { Text("Recording") }
          if !viewModel.hasTranscript {
            Text(transcriptPlaceholderTitle)
              .multilineTextAlignment(.center)
              .foregroundStyle(Color.flowMuted.opacity(0.55))
          }
          Spacer(minLength: 24)
          Circle()
            .stroke(viewModel.isRecording ? Color.flowAccent.opacity(0.72) : Color.flowBorder.opacity(0.36))
            .frame(width: viewModel.isRecording ? 304 : 292, height: viewModel.isRecording ? 304 : 292)
            .offset(y: 40)
        }
      }

      private var transcriptPlaceholderTitle: String {
        if isRecording { return "Listening" }
        return "Ready to record"
      }
    }
  `);

  assert.equal(tree.children.some((node) => node.text === "Recording"), false);
  assert.equal(tree.children[0].text, "Ready to record");
  assert.equal(tree.children[0].textAlignment, "center");
  assert.equal(tree.children[0].colorOpacity, 0.55);
  assert.equal(tree.children[1].minLength, 24);
  assert.equal(tree.children[2].width, 292);
  assert.equal(tree.children[2].borderOpacity, 0.36);
  assert.equal(tree.children[2].offsetY, 40);
});

test("renders the empty collection state and a representative current-item state", () => {
  const empty = buildSwiftUiIr(`
    struct SequenceView: View {
      var body: some View {
        VStack {
          if viewModel.tasks.isEmpty { Text("Empty queue") } else { Text("Checklist") }
        }
      }
    }
  `);
  assert.equal(empty.children[0].text, "Empty queue");

  const detail = buildSwiftUiIr(`
    struct TaskSheet: View {
      var body: some View {
        VStack {
          if let task = viewModel.currentTask { Text(task.title) }
        }
      }
    }
  `);
  assert.equal(detail.children[0].text, "Title");
});

test("recognizes SwiftUI material and liquid-glass button semantics", () => {
  const tree = buildSwiftUiIr(`
    struct GlassView: View {
      var body: some View {
        VStack {
          Button("Continue") { }
            .buttonStyle(.glassProminent)
            .controlSize(.large)
          Button("More") { }
            .glassEffect()
            .controlSize(.small)
            .disabled(true)
          Button("Delete", role: .destructive) { }
            .buttonStyle(.glass)
          Text("Material")
            .background(.regularMaterial)
        }
      }
    }
  `);
  assert.equal(tree.children[0].material, "glassProminent");
  assert.equal(tree.children[0].controlSize, "large");
  assert.equal(tree.children[1].material, "glass");
  assert.equal(tree.children[1].controlSize, "small");
  assert.equal(tree.children[1].isEnabled, false);
  assert.equal(tree.children[2].destructive, true);
  assert.equal(tree.children[2].material, "glass");
  assert.equal(tree.children[3].material, "regular");
});
