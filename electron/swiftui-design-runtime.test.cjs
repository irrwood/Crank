const assert = require("node:assert/strict");
const test = require("node:test");
const { prepareDesignNodes } = require("./project-scanner.cjs");
const { appleDesignKitForRuntime, createSwiftUiRuntimeServer, discoverSwiftUiPages, discoverSwiftUiPageViewNames, extractBuildDiagnostics, instrumentSwiftSource, instrumentUIKitSource, mergeRuntimeSnapshot, runtimeSnapshotSchema } = require("./swiftui-design-runtime.cjs");

test("matches Apple design chrome to the simulator runtime version", () => {
  assert.deepEqual(appleDesignKitForRuntime("com.apple.CoreSimulator.SimRuntime.iOS-26-5"), {
    designKit: "iOS 26",
    appearance: "liquid-glass"
  });
  assert.deepEqual(appleDesignKitForRuntime("com.apple.CoreSimulator.SimRuntime.iOS-18-6"), {
    designKit: "iOS 18",
    appearance: "classic"
  });
});

test("accepts an app-window PNG separately from runtime geometry", async () => {
  const server = createSwiftUiRuntimeServer({ port: 0 });
  await server.start();
  try {
    const session = server.beginSession("/tmp/sample");
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const response = await fetch(session.screenshotEndpoint, { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
    assert.equal(response.status, 200);
    assert.deepEqual(await server.waitForScreenshot(session.token), png);
    server.endSession(session.token);
  } finally {
    await server.stop();
  }
});

test("accepts a rendered PDF separately from runtime geometry", async () => {
  const server = createSwiftUiRuntimeServer({ port: 0 });
  await server.start();
  try {
    const session = server.beginSession("/tmp/sample");
    const pdf = Buffer.from("%PDF-1.7\nvector");
    const response = await fetch(session.vectorEndpoint, { method: "POST", headers: { "Content-Type": "application/pdf" }, body: pdf });
    assert.equal(response.status, 200);
    assert.deepEqual(await server.waitForVector(session.token), pdf);
    server.endSession(session.token);
  } finally {
    await server.stop();
  }
});

test("keeps tab page names with a rendered PDF", async () => {
  const server = createSwiftUiRuntimeServer({ port: 0 });
  await server.start();
  try {
    const session = server.beginSession("/tmp/sample");
    const pdf = Buffer.from("%PDF-1.7\nvector");
    const pageNames = ["录制", "任务清单", "勋章柜"];
    const response = await fetch(session.vectorEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-UI-Sync-Page-Names": Buffer.from(JSON.stringify(pageNames)).toString("base64"),
        "X-UI-Sync-Capture-Kind": "window-fallback",
        "X-UI-Sync-Page-Source-Names": Buffer.from(JSON.stringify(["CaptureView", "SequenceView", "BadgeGalleryView"])).toString("base64"),
        "X-UI-Sync-Page-Fallbacks": Buffer.from(JSON.stringify([false, false, true])).toString("base64"),
        "X-UI-Sync-Page-Frame": Buffer.from(JSON.stringify({ x: -9, y: 62, width: 420, height: 729 })).toString("base64")
      },
      body: pdf
    });
    assert.equal(response.status, 200);
    const captured = await server.waitForVector(session.token);
    assert.deepEqual(captured.pageNames, pageNames);
    assert.equal(captured.captureKind, "window-fallback");
    assert.deepEqual(captured.pageSourceNames, ["CaptureView", "SequenceView", "BadgeGalleryView"]);
    assert.deepEqual(captured.pageFallbacks, [false, false, true]);
    assert.deepEqual(captured.pageFrame, { x: -9, y: 62, width: 420, height: 729 });
    const selected = await server.waitForVectorSource(session.token, {
      sourceName: "SequenceView",
      captureKind: "window-fallback"
    });
    assert.equal(selected, captured);
    server.endSession(session.token);
  } finally {
    await server.stop();
  }
});

test("discovers direct TabView page views in visual order", () => {
  const views = [
    { name: "SampleApp", isAppEntry: true, designNodes: [{ kind: "RootView", startOffset: 0, endOffset: 10, expression: "RootView()" }] },
    {
      name: "RootView", isAppEntry: false, designNodes: [
        { kind: "TabView", startOffset: 100, endOffset: 500, expression: "TabView { CaptureView(); SequenceView() }" },
        { kind: "CaptureView", startOffset: 140, endOffset: 220, expression: "CaptureView()" },
        { kind: "SequenceView", startOffset: 260, endOffset: 340, expression: "SequenceView()" }
      ]
    },
    { name: "CaptureView", isAppEntry: false, designNodes: [] },
    { name: "SequenceView", isAppEntry: false, designNodes: [] }
  ];
  assert.deepEqual(discoverSwiftUiPageViewNames(views), ["CaptureView", "SequenceView"]);
});

test("discovers TabView labels and SF Symbols while excluding system chrome from PDF rendering", () => {
  const source = `import SwiftUI
enum HomeTab { case record, tasks }
struct RootView: View {
  @State private var selection = HomeTab.record
  @State private var showSettings = false
  var body: some View {
    ZStack {
      Color.blue
      TabView(selection: $selection) {
        CaptureView().tag(HomeTab.record).tabItem { Label("Record", systemImage: "mic") }
        SequenceView().tag(HomeTab.tasks).tabItem { Label("Tasks", systemImage: "checklist") }
      }
      .tint(.blue)
    }
    .sheet(isPresented: $showSettings) { SettingsView() }
  }
}
struct SettingsView: View { var body: some View { NavigationStack { ScrollView { VStack { Text("Settings") } } } } }
struct FocusModeView: View {
  @State private var showSteps = false
  var body: some View {
    VStack { Text("Focus") }
      .sheet(isPresented: $showSteps) { TaskStepsSheet() }
  }
}
struct TaskStepsSheet: View { var body: some View { Text("Steps") } }
@main struct TestApp: App {
  var body: some Scene { WindowGroup { RootView() } }
}
`;
  const tabExpression = `TabView(selection: $selection) {
        CaptureView().tag(HomeTab.record).tabItem { Label("Record", systemImage: "mic") }
        SequenceView().tag(HomeTab.tasks).tabItem { Label("Tasks", systemImage: "checklist") }
      }
      .tint(.blue)`;
  const rootExpression = `ZStack {
      Color.blue
      ${tabExpression}
    }
    .sheet(isPresented: $showSettings) { SettingsView() }`;
  const captureExpression = `CaptureView().tag(HomeTab.record).tabItem { Label("Record", systemImage: "mic") }`;
  const sequenceExpression = `SequenceView().tag(HomeTab.tasks).tabItem { Label("Tasks", systemImage: "checklist") }`;
  const labelOne = `Label("Record", systemImage: "mic")`;
  const labelTwo = `Label("Tasks", systemImage: "checklist")`;
  const settingsExpression = `SettingsView()`;
  const settingsNavigationExpression = `NavigationStack { ScrollView { VStack { Text("Settings") } } }`;
  const settingsScrollExpression = `ScrollView { VStack { Text("Settings") } }`;
  const settingsStackExpression = `VStack { Text("Settings") }`;
  const focusExpression = `VStack { Text("Focus") }
      .sheet(isPresented: $showSteps) { TaskStepsSheet() }`;
  const node = (kind, expression) => {
    const startOffset = Buffer.byteLength(source.slice(0, source.indexOf(expression)), "utf8");
    return { kind, expression, startOffset, endOffset: startOffset + Buffer.byteLength(expression, "utf8"), line: 1, column: 1 };
  };
  const views = [{
    name: "RootView", isAppEntry: false, designNodes: [
      node("ZStack", rootExpression),
      node("TabView", tabExpression),
      node("CaptureView", captureExpression), node("Label", labelOne),
      node("SequenceView", sequenceExpression), node("Label", labelTwo),
      node("SettingsView", settingsExpression)
    ]
  }, { name: "CaptureView", isAppEntry: false, designNodes: [] }, { name: "SequenceView", isAppEntry: false, designNodes: [] },
  { name: "SettingsView", isAppEntry: false, designNodes: [
    node("NavigationStack", settingsNavigationExpression), node("ScrollView", settingsScrollExpression), node("VStack", settingsStackExpression)
  ] }, {
    name: "FocusModeView", isAppEntry: false, designNodes: [
      node("VStack", focusExpression), node("TaskStepsSheet", "TaskStepsSheet()")
    ]
  }, { name: "TaskStepsSheet", isAppEntry: false, designNodes: [] }, {
    name: "TestApp", isAppEntry: true, designNodes: [node("RootView", "RootView()")]
  }];
  assert.deepEqual(discoverSwiftUiPages(views), [
    { sourceName: "CaptureView", pageName: "Record", systemImage: "mic" },
    { sourceName: "SequenceView", pageName: "Tasks", systemImage: "checklist" },
    { sourceName: "SettingsView", pageName: "Settings" }
  ]);
  const result = instrumentSwiftSource(
    source, "RootView.swift", views,
    "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes",
    "http://127.0.0.1:38458/v1/swiftui-runtime/test/vector",
    { pageViewNames: ["CaptureView", "SequenceView", "SettingsView"], renderFullTabPages: true }
  );
  assert.match(result.source, /TabView\(selection: \$selection\)/);
  assert.match(result.source, /case 0: selection = HomeTab\.record/);
  assert.match(result.source, /case 1: selection = HomeTab\.tasks/);
  assert.match(result.source, /\.tint\(\.blue\)/);
  assert.match(result.source, /_UISyncTabCaptureSwitch_[a-f0-9]{10}\(normal:/);
  assert.match(result.source, /if _uiSyncSelectedPageIndex_[a-f0-9]{10} == 0/);
  assert.match(result.source, /environment\(\\\._uiSyncFlattenTabView_[a-f0-9]{10}, true\)/);
  assert.match(result.source, /_uiSyncCaptureFullPage_[a-f0-9]{10}\(sourceName: "CaptureView"\)/);
  assert.match(result.source, /_uiSyncCaptureFullPage_[a-f0-9]{10}\(sourceName: "SequenceView"\)/);
  assert.doesNotMatch(result.source, /_uiSyncCaptureFullPage_[a-f0-9]{10}\(sourceName: "SettingsView"\)/);
  assert.doesNotMatch(result.source, /_uiSyncCaptureFullPage_[a-f0-9]{10}\(sourceName: "TaskStepsSheet"\)/);
  assert.match(result.source, /let requestedPageIndex = _uiSyncArgument_[a-f0-9]{10}\("-uiSyncPageIndex"\)\.flatMap\(Int\.init\)/);
  assert.match(result.source, /let pageIndexes = requestedPageIndex\.map/);
  assert.match(result.source, /_uiSyncActivePageSourceName_[a-f0-9]{10} == "SettingsView" \{ showSettings = true \}/);
  assert.match(result.source, /\[tabController\?\.selectedIndex \?\? 0\]/);
  assert.doesNotMatch(result.source, /let tabBarImage: UIImage\?/);
  assert.match(result.source, /tabBar\?\.layer\.opacity = 0/);
  assert.match(result.source, /renderer\.drawHierarchy\(in: renderer\.bounds, afterScreenUpdates: true\)/);
  assert.doesNotMatch(result.source, /window\.drawHierarchy\(in: window\.bounds, afterScreenUpdates: true\)/);
  assert.match(result.source, /window-fallback-clean/);
  assert.doesNotMatch(result.source, /_uiSyncDrawTabBar_[a-f0-9]{10}\(in: context, pageSize: renderedSize\)/);
});

test("discovers deterministic enum-backed split-view destinations and excludes unavailable or data-bound routes", () => {
  const contentSource = `
struct ContentView: View {
  @State private var selection: Panel? = Panel.truck
  var body: some View {
    NavigationSplitView {
      Sidebar(selection: $selection)
    } detail: {
      DetailColumn(selection: $selection)
    }
  }
}`;
  const detailSource = `
struct DetailColumn: View {
  @Binding var selection: Panel?
  var body: some View {
    switch selection ?? .truck {
    case .truck: TruckView()
    case .orders: OrdersView()
    case .socialFeed: SocialFeedView()
#if EXTENDED_ALL
    case .account: AccountView()
#endif
    case .salesHistory: SalesHistoryView()
    case .donuts: DonutGallery()
    case .donutEditor: DonutEditor()
    case .topFive: TopFiveDonutsView()
    case .city(let id): CityView(cityID: id)
    }
  }
}`;
  const detailNodes = ["TruckView", "OrdersView", "SocialFeedView", "AccountView", "SalesHistoryView", "DonutGallery", "DonutEditor", "TopFiveDonutsView", "CityView"]
    .map((kind) => ({ kind, expression: `${kind}()`, startOffset: 0, endOffset: kind.length + 2, line: 1, column: 1 }));
  const views = [
    { name: "ContentView", relativeFile: "ContentView.swift", source: contentSource, isAppEntry: false, designNodes: [] },
    { name: "DetailColumn", relativeFile: "DetailColumn.swift", source: detailSource, isAppEntry: false, designNodes: detailNodes },
    ...["TruckView", "OrdersView", "SocialFeedView", "AccountView", "SalesHistoryView", "DonutGallery", "DonutEditor", "TopFiveDonutsView", "CityView"]
      .map((name) => ({ name, relativeFile: `${name}.swift`, source: name === "OrdersView" ? `struct OrdersView: View { var body: some View { Text(\"Orders\") }.navigationTitle(\"Orders\") }` : "", isAppEntry: false, designNodes: [] }))
  ];
  const pages = discoverSwiftUiPages(views);
  assert.deepEqual(pages.map((page) => page.sourceName), [
    "TruckView", "OrdersView", "SocialFeedView", "SalesHistoryView", "DonutGallery", "DonutEditor", "TopFiveDonutsView"
  ]);
  assert.equal(pages[1].pageName, "Orders");
  assert.ok(pages.every((page) => page.preferWindowCapture));
  assert.ok(pages.every((page) => page.navigationRoute.hostSourceName === "ContentView"));
  assert.ok(!pages.some((page) => page.sourceName === "AccountView"));
  assert.ok(!pages.some((page) => page.sourceName === "CityView"));
});

test("instruments enum-backed navigation state with only discovered deterministic page routes", () => {
  const source = `import SwiftUI
struct ContentView: View {
  @State private var selection: Panel? = Panel.truck
  var body: some View { DetailColumn(selection: $selection) }
}`;
  const expression = "DetailColumn(selection: $selection)";
  const startOffset = source.indexOf(expression);
  const discoveredViews = [{
    name: "ContentView", relativeFile: "ContentView.swift", source, isAppEntry: false,
    designNodes: [{ kind: "DetailColumn", expression, startOffset, endOffset: startOffset + expression.length, line: 4, column: 25 }]
  }, { name: "DetailColumn", relativeFile: "DetailColumn.swift", source: "", isAppEntry: false, designNodes: [] }];
  const navigationRoutes = ["TruckView", "OrdersView"].map((sourceName, index) => ({
    sourceName,
    navigationRoute: {
      hostSourceName: "ContentView",
      hostRelativeFile: "ContentView.swift",
      stateName: "selection",
      enumType: "Panel",
      caseName: index === 0 ? "truck" : "orders"
    }
  }));
  const result = instrumentSwiftSource(
    source, "ContentView.swift", discoveredViews,
    "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes",
    "http://127.0.0.1:38458/v1/swiftui-runtime/test/vector",
    { navigationRoutes }
  );
  assert.match(result.source, /case "TruckView": return Panel\.truck/);
  assert.match(result.source, /case "OrdersView": return Panel\.orders/);
  assert.match(result.source, /default: return Panel\.truck/);
  assert.doesNotMatch(result.source, /Panel\.account|Panel\.city/);
});

test("builds stable source identities independently of literal values and line movement", () => {
  const before = prepareDesignNodes("Views/Card.swift", "Card", [{
    kind: "Text", expression: "Text(\"Before\").font(.headline)", startOffset: 40, endOffset: 54, line: 3, column: 5
  }]);
  const after = prepareDesignNodes("Views/Card.swift", "Card", [{
    kind: "Text", expression: "Text(\"After\").font(.headline)", startOffset: 140, endOffset: 153, line: 8, column: 5
  }]);
  assert.equal(before[0].syncId, after[0].syncId);
  assert.notDeepEqual(before[0].sourceRange, after[0].sourceRange);
});

test("instruments a temporary SwiftUI source with non-layout runtime probes", () => {
  const source = `import SwiftUI
struct Card: View {
  var body: some View {
    Text("Hello")
  }
}
`;
  const startOffset = source.indexOf("Text");
  const endOffset = startOffset + 'Text("Hello")'.length;
  const result = instrumentSwiftSource(source, "Views/Card.swift", [{
    name: "Card",
    isAppEntry: false,
    designNodes: [{ kind: "Text", expression: 'Text("Hello")', startOffset, endOffset, line: 4, column: 5 }]
  }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.equal(result.nodeCount, 1);
  assert.match(result.source, /Text\("Hello"\)\._uiSyncProbe_[a-f0-9]{10}\(/);
  assert.match(result.source, /text: String\(describing: \("Hello"\)\)/);
  assert.match(result.source, /hideCapturedText && kind == "Text" && text != nil/);
  assert.match(result.source, /GeometryReader/);
  assert.match(result.source, /@Environment\(\\\.colorScheme\)/);
  assert.match(result.source, /"environment": environment/);
  assert.match(result.source, /UIScreen\.main/);
  assert.match(result.source, /URLSession\.shared\.dataTask/);
});

test("captures the resolved original asset name for SwiftUI Image without treating SF Symbols as project files", () => {
  const source = `import SwiftUI
struct Header: View {
  let name: String
  var body: some View {
    VStack {
      Image("header/layer/\\(name)", bundle: .module)
      Image(systemName: "truck.box")
    }
  }
}`;
  const expressions = ['Image("header/layer/\\(name)", bundle: .module)', 'Image(systemName: "truck.box")'];
  const nodes = expressions.map((expression) => {
    const startOffset = source.indexOf(expression);
    return { kind: "Image", expression, startOffset, endOffset: startOffset + expression.length, line: 1, column: 1 };
  });
  const result = instrumentSwiftSource(source, "Header.swift", [{ name: "Header", isAppEntry: false, designNodes: nodes }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.match(result.source, /assetName: String\(describing: \("header\/layer\/\\\(name\)"\)\)/);
  assert.match(result.source, /Image\(systemName: "truck\.box"\)[\s\S]*?assetName: nil/);
  assert.match(result.source, /payload\["assetName"\]/);
});

test("instruments a page body with a page-level ImageRenderer capture", () => {
  const source = `import SwiftUI\nstruct CaptureView: View {\n  var body: some View {\n    VStack { Text("Capture") }\n  }\n}\n`;
  const rootExpression = 'VStack { Text("Capture") }';
  const rootStart = source.indexOf(rootExpression);
  const textExpression = 'Text("Capture")';
  const textStart = source.indexOf(textExpression);
  const result = instrumentSwiftSource(source, "CaptureView.swift", [{
    name: "CaptureView",
    isAppEntry: false,
    designNodes: [
      { kind: "VStack", expression: rootExpression, startOffset: rootStart, endOffset: rootStart + rootExpression.length, line: 4, column: 5 },
      { kind: "Text", expression: textExpression, startOffset: textStart, endOffset: textStart + textExpression.length, line: 4, column: 14 }
    ]
  }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes", "http://127.0.0.1:38458/v1/swiftui-runtime/test/vector", {
    pageViewNames: ["CaptureView"]
  });
  assert.match(result.source, /VStack \{ Text\("Capture"\)[^\n]*_uiSyncCapturePage_[a-f0-9]{10}\(sourceName: "CaptureView"\)/);
  assert.match(result.source, /ImageRenderer\(content: renderedContent\)/);
  assert.match(result.source, /image-renderer-page/);
});

test("does not rewrite native SwiftUI text controls during PDF capture", () => {
  const source = `import SwiftUI
struct FormView: View {
  @State private var value = ""
  var body: some View {
    VStack {
      TextField("Name", text: $value).frame(height: 48)
      SecureField("Password", text: $value).frame(height: 48)
    }
  }
}
`;
  const field = 'TextField("Name", text: $value).frame(height: 48)';
  const secure = 'SecureField("Password", text: $value).frame(height: 48)';
  const node = (kind, expression) => {
    const startOffset = source.indexOf(expression);
    return { kind, expression, startOffset, endOffset: startOffset + expression.length, line: 1, column: 1 };
  };
  const result = instrumentSwiftSource(source, "FormView.swift", [{
    name: "FormView", isAppEntry: false,
    designNodes: [node("TextField", field), node("SecureField", secure)]
  }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.match(result.source, /TextField\("Name", text: \$value\)\.frame\(height: 48\)/);
  assert.match(result.source, /SecureField\("Password", text: \$value\)\.frame\(height: 48\)/);
  assert.doesNotMatch(result.source, /wrappedValue|••••••••/);
});

test("preserves source effects for normal rendering and disables them in a clean PDF capture", () => {
  const source = `import SwiftUI
struct OrbView: View {
  var body: some View {
    Circle().fill(.blue).blur(radius: 2).shadow(color: .blue.opacity(0.2), radius: 12, x: 0, y: 6)
  }
}
`;
  const expression = "Circle().fill(.blue).blur(radius: 2).shadow(color: .blue.opacity(0.2), radius: 12, x: 0, y: 6)";
  const startOffset = source.indexOf(expression);
  const result = instrumentSwiftSource(source, "OrbView.swift", [{
    name: "OrbView",
    isAppEntry: false,
    designNodes: [{ kind: "Circle", expression, startOffset, endOffset: startOffset + expression.length, line: 4, column: 5 }]
  }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes", "http://127.0.0.1:38458/v1/swiftui-runtime/test/vector", {
    pageViewNames: ["OrbView"]
  });

  assert.match(result.source, /\._uiSyncBlur_[a-f0-9]{10}\(id: "swift\/[a-f0-9]{16}", sourceFile: "OrbView\.swift", sourceName: "OrbView", radius: 2\)/);
  assert.match(result.source, /\._uiSyncShadow_[a-f0-9]{10}\(id: "swift\/[a-f0-9]{16}", sourceFile: "OrbView\.swift", sourceName: "OrbView", color: \.blue\.opacity\(0\.2\), radius: 12, x: 0, y: 6\)/);
  assert.match(result.source, /UserDefaults\.standard\.set\(true, forKey: _uiSyncDisableNativeEffectsKey_[a-f0-9]{10}\)/);
  assert.match(result.source, /UserDefaults\.standard\.set\(false, forKey: _uiSyncDisableNativeEffectsKey_[a-f0-9]{10}\)/);
  assert.match(result.source, /image-renderer-page-clean/);
  assert.match(result.source, /UI_SYNC_PAGE_SOURCE_NAME/);
  assert.equal(result.nativeEffectIds.length, 2);
  assert.ok(result.nativeEffectIds.some((id) => id.endsWith("/shadow")));
  assert.ok(result.nativeEffectIds.some((id) => id.endsWith("/blur")));
  assert.deepEqual(result.nativeEffects.map((effect) => ({ type: effect.type, radius: effect.radius })), [
    { type: "LAYER_BLUR", radius: 2 },
    { type: "DROP_SHADOW", radius: 12 }
  ]);
  const shadow = result.nativeEffects.find((effect) => effect.type === "DROP_SHADOW");
  assert.equal(shadow.colorToken, "blue");
  assert.equal(shadow.opacity, 0.2);
  assert.deepEqual(shadow.offset, { x: 0, y: 6 });
});

test("does not replace VisualEffect protocol modifiers with View-only wrappers", () => {
  const source = `import SwiftUI
struct Ripple: View {
  var body: some View {
    Circle().visualEffect { content, proxy in
      content.blur(radius: proxy.size.width * 0.01)
    }
  }
}
`;
  const expression = `Circle().visualEffect { content, proxy in
      content.blur(radius: proxy.size.width * 0.01)
    }`;
  const startOffset = source.indexOf(expression);
  const result = instrumentSwiftSource(source, "Ripple.swift", [{
    name: "Ripple",
    isAppEntry: false,
    designNodes: [{ kind: "Circle", expression, startOffset, endOffset: startOffset + expression.length, line: 4, column: 5 }]
  }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.match(result.source, /content\.blur\(radius:/);
  assert.doesNotMatch(result.source, /content\._uiSyncBlur_/);
  assert.deepEqual(result.nativeEffectIds, []);
  assert.deepEqual(result.nativeEffects, []);
});

test("instruments the App root with one ImageRenderer PDF capture", () => {
  const source = `import SwiftUI
@main struct SampleApp: App {
  var body: some Scene { WindowGroup { HomeView() } }
}
struct HomeView: View { var body: some View { Text("Home") } }
`;
  const appExpression = "HomeView()";
  const appStart = source.indexOf(appExpression);
  const textExpression = 'Text("Home")';
  const textStart = source.indexOf(textExpression);
  const result = instrumentSwiftSource(source, "SampleApp.swift", [
    { name: "SampleApp", isAppEntry: true, designNodes: [{ kind: "HomeView", expression: appExpression, startOffset: appStart, endOffset: appStart + appExpression.length, line: 3, column: 40 }] },
    { name: "HomeView", isAppEntry: false, designNodes: [{ kind: "Text", expression: textExpression, startOffset: textStart, endOffset: textStart + textExpression.length, line: 5, column: 52 }] }
  ], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes", "http://127.0.0.1:38458/v1/swiftui-runtime/test/vector");
  assert.match(result.source, /_UISyncVectorCaptureHost_[a-f0-9]{10}\(content: HomeView\(\), renderRoot: true\)/);
  assert.match(result.source, /ImageRenderer\(content: renderedContent\)/);
  assert.match(result.source, /application\/pdf/);
  assert.match(result.source, /test\/vector/);
  assert.match(result.source, /captureKind: "window-fallback-clean"/);
});

test("instruments a UIKit application delegate with PDF window capture", () => {
  const source = `import UIKit
@main final class AppDelegate: UIResponder, UIApplicationDelegate {
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool { true }
}`;
  const result = instrumentUIKitSource(source, "http://127.0.0.1:38458/v1/swiftui-runtime/test/vector");
  assert.equal(result.nodeCount, 1);
  assert.match(result.source, /_uiSyncScheduleUIKitPdfCapture\(\)/);
  assert.match(result.source, /CGContext\(consumer:/);
  assert.match(result.source, /UITabBarController/);
  assert.match(result.source, /X-UI-Sync-Page-Names/);
  assert.match(result.source, /containsOpaqueRenderer/);
  assert.match(result.source, /application\/pdf/);
});

test("extracts actionable Swift diagnostics from noisy xcodebuild output", () => {
  const output = `SwiftCompile normal x86_64\n/Build/SegmentedGauge.swift:255:34: error: 'shared' is unavailable in application extensions for iOS\n      let window = UIApplication.shared.connectedScenes\n                                 ^~~~~~\n** BUILD FAILED **`;
  assert.deepEqual(extractBuildDiagnostics(output), [
    "/Build/SegmentedGauge.swift:255:34: error: 'shared' is unavailable in application extensions for iOS",
    "let window = UIApplication.shared.connectedScenes",
    "^~~~~~"
  ]);
});

test("prefers explicit designNode identities and declared property snapshots", () => {
  const source = `import SwiftUI\nstruct Card: View {\n  var body: some View {\n    Text("Hotel").designNode("hotel-card", cornerRadius: 16, backgroundColor: "#FFFFFF", fontSize: 17)\n  }\n}\n`;
  const expression = 'Text("Hotel").designNode("hotel-card", cornerRadius: 16, backgroundColor: "#FFFFFF", fontSize: 17)';
  const startOffset = source.indexOf(expression);
  const result = instrumentSwiftSource(source, "Views/Card.swift", [{
    name: "Card", isAppEntry: false,
    designNodes: [{ kind: "Text", expression, startOffset, endOffset: startOffset + expression.length, line: 4, column: 5 }]
  }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.match(result.source, /id: "hotel-card"/);
  assert.match(result.source, /cornerRadius: 16/);
  assert.match(result.source, /backgroundColor: "#FFFFFF"/);
  assert.match(result.source, /fontSize: 17/);
  assert.match(result.source, /sourceHint: "Views\/Card.swift:4"/);
});

test("does not append a modifier after a conditional compilation directive", () => {
  const source = `import SwiftUI\nstruct Card: View {\n  var body: some View {\n    Group {\n#if os(iOS)\n      Text("Phone")\n#else\n      Text("Other")\n#endif\n    }\n  }\n}\n`;
  const expressionStart = source.indexOf("Group");
  const expressionEnd = source.indexOf("\n    }", expressionStart) + "\n    }".length;
  const result = instrumentSwiftSource(source, "Views/Card.swift", [{
    name: "Card", isAppEntry: false,
    designNodes: [{ kind: "Group", expression: source.slice(expressionStart, expressionEnd), startOffset: expressionStart, endOffset: expressionEnd, line: 4, column: 5 }]
  }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.equal(result.nodeCount, 0);
  assert.doesNotMatch(result.source, /#endif\._uiSyncProbe/);
});

test("limits fallback probes to ViewBuilder bodies and preserves concrete property types", () => {
  const source = `import SwiftUI\nstruct Card: View {\n  static var backgroundColor: Color { Color.red }\n  static var backgroundShape: some InsettableShape { RoundedRectangle(cornerRadius: 16) }\n  var body: some View { Text("Card") }\n}\n`;
  const expressions = [
    { kind: "Color", expression: "Color.red" },
    { kind: "RoundedRectangle", expression: "RoundedRectangle(cornerRadius: 16)" },
    { kind: "Text", expression: 'Text("Card")' }
  ].map((node) => {
    const characterStart = source.indexOf(node.expression);
    const startOffset = Buffer.byteLength(source.slice(0, characterStart), "utf8");
    return { ...node, startOffset, endOffset: startOffset + Buffer.byteLength(node.expression, "utf8"), line: 1, column: 1 };
  });
  const result = instrumentSwiftSource(source, "Views/Card.swift", [{ name: "Card", isAppEntry: false, designNodes: expressions }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.equal(result.nodeCount, 1);
  assert.match(result.source, /Color\.red\s*\}/);
  assert.match(result.source, /RoundedRectangle\(cornerRadius: 16\)\s*\}/);
  assert.match(result.source, /Text\("Card"\)\._uiSyncProbe/);
});

test("does not erase ambiguous TableRowContent containers to some View", () => {
  const source = `import SwiftUI\nstruct Orders: View {\n  var body: some View {\n    Table([] as [String]) {\n      TableColumn("Name") { Text($0) }\n    } rows: {\n      Section { ForEach([] as [String], id: \\.self) { _ in TableRow(\"\") } }\n    }\n  }\n}\n`;
  const expressions = ["Section { ForEach", "ForEach([] as [String]"].map((needle, index) => {
    const characterStart = source.indexOf(needle);
    const expression = index === 0 ? "Section" : "ForEach";
    const startOffset = Buffer.byteLength(source.slice(0, characterStart), "utf8");
    return { kind: expression, expression: needle, startOffset, endOffset: startOffset + Buffer.byteLength(needle, "utf8"), line: 1, column: 1 };
  });
  const result = instrumentSwiftSource(source, "Orders.swift", [{ name: "Orders", isAppEntry: false, designNodes: expressions }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.equal(result.nodeCount, 0);
  assert.doesNotMatch(result.source, /Section\._uiSyncProbe|ForEach\._uiSyncProbe/);
});

test("uses SwiftSyntax UTF-8 offsets when source contains non-ASCII text", () => {
  const source = `import SwiftUI\nstruct Card: View {\n  var body: some View {\n    Text("坏猫任务")\n  }\n}\n`;
  const expression = 'Text("坏猫任务")';
  const characterStart = source.indexOf(expression);
  const byteStart = Buffer.byteLength(source.slice(0, characterStart), "utf8");
  const byteEnd = byteStart + Buffer.byteLength(expression, "utf8");
  const result = instrumentSwiftSource(source, "Views/Card.swift", [{
    name: "Card",
    isAppEntry: false,
    designNodes: [{ kind: "Text", expression, startOffset: byteStart, endOffset: byteEnd, line: 4, column: 5 }]
  }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.match(result.source, /Text\("坏猫任务"\)\._uiSyncProbe_[a-f0-9]{10}\(/);
  assert.match(result.source, /text: String\(describing: \("坏猫任务"\)\)/);
});

test("captures only the first rendered Text argument and ignores unsupported temporal text", () => {
  const source = `import SwiftUI\nstruct Card: View {\n  let title = "Truck"\n  var body: some View {\n    VStack {\n      Text(title, comment: "Title")\n      Text(timerInterval: Date.now...Date.now)\n    }\n  }\n}\n`;
  const expressions = ['Text(title, comment: "Title")', "Text(timerInterval: Date.now...Date.now)"].map((expression) => {
    const characterStart = source.indexOf(expression);
    const startOffset = Buffer.byteLength(source.slice(0, characterStart), "utf8");
    return { kind: "Text", expression, startOffset, endOffset: startOffset + Buffer.byteLength(expression, "utf8"), line: 1, column: 1 };
  });
  const result = instrumentSwiftSource(source, "Views/Card.swift", [{ name: "Card", isAppEntry: false, designNodes: expressions }], "http://127.0.0.1:38458/v1/swiftui-runtime/test/nodes");
  assert.match(result.source, /Text\(title, comment: "Title"\)\._uiSyncProbe_[a-f0-9]{10}\([^\n]*text: String\(describing: \(title\)\)/);
  assert.match(result.source, /Text\(timerInterval: Date\.now\.\.\.Date\.now\)\._uiSyncProbe_[a-f0-9]{10}\([^\n]*text: nil/);
});

test("merges real runtime frames while retaining source semantics", () => {
  const screen = {
    id: "home",
    name: "Home",
    sourceType: "screen",
    uiTree: {
      type: "vstack",
      syncId: "swift/1111111111111111",
      sourceFile: "Home.swift",
      sourceName: "Home",
      sourceExpression: "VStack(spacing: theme.gap)",
      spacing: 12,
      children: [{
        type: "text",
        syncId: "swift/2222222222222222",
        sourceFile: "Home.swift",
        sourceName: "Home",
        text: "Static fallback"
      }]
    }
  };
  const snapshot = runtimeSnapshotSchema.parse({
    version: 1,
    capturedAt: "2026-08-13T12:00:00.000Z",
    deviceName: "iPhone 16",
    nodes: [
      { syncId: "swift/1111111111111111", sourceFile: "Home.swift", sourceName: "Home", kind: "VStack", frame: { x: 16, y: 90, width: 361, height: 120 } },
      { syncId: "swift/2222222222222222", sourceFile: "Home.swift", sourceName: "Home", kind: "Text", frame: { x: 32, y: 106, width: 100, height: 22 }, text: "Runtime value" }
    ]
  });
  const merged = mergeRuntimeSnapshot([screen], snapshot);
  assert.equal(merged.coverage.capturedNodeCount, 2);
  assert.equal(merged.screens[0].uiTree.sourceExpression, "VStack(spacing: theme.gap)");
  assert.deepEqual(merged.screens[0].uiTree.runtimeFrame, { x: 0, y: 0, width: 361, height: 120 });
  assert.equal(merged.screens[0].runtimeCapture.isVisualReference, true);
  assert.equal(merged.screens[0].uiTree.children[0].text, "Runtime value");
  assert.equal(merged.screens[0].uiTree.children[0].runtimeTextCaptured, true);
  assert.deepEqual(merged.screens[0].uiTree.children[0].runtimeFrame, { x: 16, y: 16, width: 100, height: 22 });
});

test("keeps repeated runtime instances for one stable source node", () => {
  const screens = [{
    id: "list", name: "List", sourceType: "screen",
    uiTree: { type: "text", syncId: "swift/3333333333333333", sourceFile: "List.swift", sourceName: "List", text: "Row" }
  }];
  const snapshot = {
    version: 1,
    capturedAt: "2026-08-13T12:00:00.000Z",
    nodes: [
      { syncId: "swift/3333333333333333", instanceId: "row-1", sourceFile: "List.swift", sourceName: "List", kind: "Text", frame: { x: 20, y: 100, width: 80, height: 20 } },
      { syncId: "swift/3333333333333333", instanceId: "row-2", sourceFile: "List.swift", sourceName: "List", kind: "Text", frame: { x: 20, y: 140, width: 80, height: 20 } }
    ]
  };
  const merged = mergeRuntimeSnapshot(screens, snapshot);
  assert.equal(merged.screens[0].uiTree.runtimeInstances.length, 2);
  assert.deepEqual(merged.screens[0].uiTree.runtimeInstances.map((instance) => instance.instanceId), ["row-1", "row-2"]);
});

test("anchors runtime geometry to the captured viewport instead of the first SwiftUI node", () => {
  const screens = [{
    id: "runtime-home",
    name: "Runtime Home",
    sourceType: "screen",
    uiTree: {
      type: "vstack",
      syncId: "swift/4444444444444444",
      sourceFile: "Home.swift",
      sourceName: "Home",
      children: [{
        type: "text",
        syncId: "swift/5555555555555555",
        sourceFile: "Home.swift",
        sourceName: "Home",
        text: "Runtime"
      }]
    }
  }];
  const environment = {
    viewport: { x: 0, y: 0, width: 393, height: 852 },
    displayScale: 3,
    colorScheme: "light",
    dynamicTypeSize: "large",
    layoutDirection: "leftToRight"
  };
  const merged = mergeRuntimeSnapshot(screens, {
    version: 2,
    capturedAt: "2026-08-13T12:00:00.000Z",
    environment,
    nodes: [
      { syncId: "swift/4444444444444444", sourceFile: "Home.swift", sourceName: "Home", kind: "VStack", frame: { x: 16, y: 90, width: 361, height: 120 } },
      { syncId: "swift/5555555555555555", sourceFile: "Home.swift", sourceName: "Home", kind: "Text", frame: { x: 32, y: 106, width: 100, height: 22 } }
    ]
  });
  assert.deepEqual(merged.screens[0].uiTree.runtimeFrame, { x: 16, y: 90, width: 361, height: 120 });
  assert.deepEqual(merged.screens[0].uiTree.children[0].runtimeFrame, { x: 32, y: 106, width: 100, height: 22 });
  assert.deepEqual(merged.screens[0].uiTree.runtimeEnvironment, environment);
});
