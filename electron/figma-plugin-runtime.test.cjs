const assert = require("node:assert/strict");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createFigmaMock() {
  let nextId = 1;
  const clientValues = new Map();
  const messages = [];
  const page = createNode("PAGE", "Page 1");
  const document = createNode("DOCUMENT", "Sample Design");
  document.children = [page];
  page.parent = document;

  function createNode(type, name = type) {
    const shared = new Map();
    const plugin = new Map();
    const node = {
      id: `${nextId++}:1`, type, name, children: [], parent: null, removed: false,
      width: 100, height: 100, x: 0, y: 0, cornerRadius: 0, opacity: 1, fills: [], strokes: [], effects: [],
      appendChild(child) {
        if (child.parent) child.parent.children = child.parent.children.filter((item) => item !== child);
        child.parent = node;
        node.children.push(child);
      },
      remove() {
        node.removed = true;
        if (node.parent) node.parent.children = node.parent.children.filter((item) => item !== node);
      },
      resize(width, height) { node.width = width; node.height = height; },
      clone() {
        const cloned = createNode(type, name);
        for (const key of ["width", "height", "x", "y", "cornerRadius", "opacity", "fills", "strokes", "layoutMode", "layoutPositioning", "layoutSizingHorizontal", "layoutSizingVertical", "textAutoResize", "fontName", "fontSize", "characters"]) {
          if (node[key] !== undefined) cloned[key] = node[key];
        }
        if (node.componentProperties) cloned.componentProperties = structuredClone(node.componentProperties);
        if (node.variantProperties) cloned.variantProperties = structuredClone(node.variantProperties);
        for (const [key, value] of shared) cloned.setSharedPluginData(...key.split(":"), value);
        for (const child of node.children) cloned.appendChild(child.clone());
        return cloned;
      },
      setProperties(properties) {
        node.componentProperties ||= {};
        for (const [key, value] of Object.entries(properties)) {
          const current = node.componentProperties[key];
          node.componentProperties[key] = current ? { ...current, value } : { type: "VARIANT", value };
        }
      },
      setRangeFontName(start, end, fontName) {
        node.fontRanges = [...(node.fontRanges || []), { start, end, fontName }];
      },
      setSharedPluginData(namespace, key, value) { shared.set(`${namespace}:${key}`, value); },
      getSharedPluginData(namespace, key) { return shared.get(`${namespace}:${key}`) || ""; },
      setPluginData(key, value) { plugin.set(key, value); },
      findAll(predicate) {
        const result = [];
        const visit = (parent) => parent.children.forEach((child) => {
          if (predicate(child)) result.push(child);
          visit(child);
        });
        visit(node);
        return result;
      },
      findAllWithCriteria(criteria) {
        return node.findAll((child) => {
          if (criteria.types && !criteria.types.includes(child.type)) return false;
          const sharedCriteria = criteria.sharedPluginData;
          if (!sharedCriteria) return true;
          return sharedCriteria.keys.some((key) => child.getSharedPluginData(sharedCriteria.namespace, key));
        });
      }
    };
    Object.defineProperty(node, "absoluteBoundingBox", {
      get() {
        let absoluteX = node.x;
        let absoluteY = node.y;
        let parent = node.parent;
        while (parent && parent.type !== "PAGE" && parent.type !== "DOCUMENT") {
          absoluteX += parent.x;
          absoluteY += parent.y;
          parent = parent.parent;
        }
        return { x: absoluteX, y: absoluteY, width: node.width, height: node.height };
      }
    });
    if (type !== "PAGE" && type !== "DOCUMENT") page.appendChild(node);
    return node;
  }

  const figma = {
    root: document,
    currentPage: page,
    ui: { postMessage(message) { messages.push(message); }, onmessage: null },
    clientStorage: {
      async getAsync(key) { return clientValues.get(key); },
      async setAsync(key, value) { clientValues.set(key, value); }
    },
    viewport: { scrollAndZoomIntoView() {} },
    showUI() {},
    closePlugin() {},
    async loadAllPagesAsync() {},
    async getNodeByIdAsync(id) { return document.findAll(() => true).find((node) => node.id === id) || null; },
    async listAvailableFontsAsync() { return [
      { fontName: { family: "SF Pro", style: "Regular" } },
      { fontName: { family: "SF Pro", style: "Bold" } },
      { fontName: { family: "SF Pro", style: "Semibold" } },
      { fontName: { family: "Inter", style: "Regular" } },
      { fontName: { family: "Inter", style: "Bold" } },
      { fontName: { family: "PingFang SC", style: "Regular" } },
      { fontName: { family: "PingFang SC", style: "Medium" } },
      { fontName: { family: "PingFang SC", style: "Semibold" } }
    ]; },
    async loadFontAsync() {},
    createFrame: () => createNode("FRAME"),
    createText: () => createNode("TEXT"),
    createRectangle: () => createNode("RECTANGLE"),
    createEllipse: () => createNode("ELLIPSE"),
    createNodeFromSvg: (svg) => {
      const root = createNode("FRAME", "SVG");
      root.sourceSvg = svg;
      const svgSize = String(svg).match(/<svg\b[^>]*\bwidth=["']([\d.]+)["'][^>]*\bheight=["']([\d.]+)["']/i);
      if (svgSize) root.resize(Number(svgSize[1]), Number(svgSize[2]));
      for (const marker of String(svg).matchAll(/\bid=["'](ui-sync-shadow-\d+)["']/g)) {
        root.appendChild(createNode("VECTOR", marker[1]));
      }
      for (const rectangle of String(svg).matchAll(/<rect\b([^>]*)\/?\s*>/gi)) {
        const attributes = Object.fromEntries([...rectangle[1].matchAll(/([\w:-]+)=["']([^"']+)["']/g)].map((match) => [match[1], match[2]]));
        if (attributes.id?.startsWith("ui-sync-shadow-")) continue;
        const child = createNode("VECTOR", attributes.id || "SVG Rectangle");
        child.x = Number(attributes.x || 0);
        child.y = Number(attributes.y || 0);
        child.resize(Number(attributes.width || 0), Number(attributes.height || 0));
        root.appendChild(child);
      }
      return root;
    },
    group: (nodes, parent) => {
      const bounds = nodes.map((node) => node.absoluteBoundingBox);
      const parentBounds = parent.absoluteBoundingBox;
      const minimumX = Math.min(...bounds.map((item) => item.x));
      const minimumY = Math.min(...bounds.map((item) => item.y));
      const maximumX = Math.max(...bounds.map((item) => item.x + item.width));
      const maximumY = Math.max(...bounds.map((item) => item.y + item.height));
      const group = createNode("GROUP");
      parent.appendChild(group);
      group.x = minimumX - parentBounds.x;
      group.y = minimumY - parentBounds.y;
      group.resize(maximumX - minimumX, maximumY - minimumY);
      for (const node of nodes) {
        const absolute = node.absoluteBoundingBox;
        group.appendChild(node);
        node.x = absolute.x - minimumX;
        node.y = absolute.y - minimumY;
      }
      return group;
    },
    createImage: () => ({ hash: "image-hash" }),
    base64Decode: (value) => Buffer.from(value, "base64"),
    util: {
      getSfSymbolCharacter() { return null; }
    }
  };
  return { figma, page, messages, createNode };
}

test("Figma bridge plugin renders normalized SwiftUI content into a native frame", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  let completion = null;
  let job = {
    projectId: "0123456789abcdef01234567",
    projectName: "Sample",
    figmaFileName: "Sample Design",
    screens: [{
      id: "screen-one",
      name: "Home",
      sourceType: "screen",
      currentNodeId: null,
      renderMode: "structured",
      uiTree: { type: "navigation", title: "Home", children: [{ type: "list", children: [{ type: "label", text: "Saved", symbol: "bookmark" }] }] }
    }]
  };
  const fetch = async (url, options) => {
    if (options?.method === "POST") {
      completion = JSON.parse(options.body);
      return { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) };
    }
    return { ok: true, json: async () => job };
  };

  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  assert.equal(completion.mappings[0].contentDisposition, "rendered");
  const screen = page.children.find((node) => node.name === "Home");
  assert.ok(screen);
  assert.equal(screen.children.length, 1);
  assert.ok(screen.findAll((node) => node.type === "TEXT").some((node) => node.characters === "Home"));
  assert.ok(screen.findAll((node) => node.type === "TEXT").some((node) => node.characters === "Saved"));
});

test("Figma bridge redraws SwiftUI TabView chrome as editable SF Symbols and labels", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const job = {
    projectId: "1123456789abcdef01234567",
    projectName: "Tabs",
    figmaFileName: "Sample Design",
    screens: [{
      id: "screen-tabs",
      name: "Record",
      sourceType: "screen",
      currentNodeId: null,
      renderMode: "structured",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874"><rect width="402" height="874"/></svg>',
      vectorTextMode: "pdf-glyphs",
      systemTabBar: {
        designKit: "iOS 26",
        appearance: "liquid-glass",
        selectedIndex: 0,
        items: [
          { title: "录制", systemImage: "mic.fill" },
          { title: "任务清单", systemImage: "checklist" },
          { title: "勋章柜", systemImage: "circle" }
        ]
      },
      uiTree: {
        type: "vstack", runtimeStatus: "captured",
        runtimeFrame: { x: 0, y: 0, width: 402, height: 874 },
        runtimeEnvironment: { viewport: { x: 0, y: 0, width: 402, height: 874 }, displayScale: 3, colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight" },
        children: []
      }
    }]
  };
  const fetch = async (url, options) => options?.method === "POST"
    ? ({ ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) })
    : ({ ok: true, json: async () => job });
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });
  const screen = page.children.find((node) => node.name === "Record");
  const tabBar = screen.findAll((node) => node.name === "Tab Bar · Apple iOS 26")[0];
  assert.ok(tabBar);
  assert.deepEqual(
    tabBar.findAll((node) => node.type === "TEXT" && !node.name.startsWith("SF Symbol ·")).map((node) => node.characters),
    ["录制", "任务清单", "勋章柜"]
  );
  const glass = tabBar.findAll((node) => node.name === "Tab Bar · Liquid Glass")[0];
  assert.ok(glass);
  assert.equal(glass.cornerRadius, 32);
  assert.equal(glass.effects[0].type, "BACKGROUND_BLUR");
  assert.equal(tabBar.getSharedPluginData("ui_sync", "apple_design_kit"), "iOS 26");
});

test("Figma bridge clones the user-selected Apple Tab Bar template and applies SwiftUI tabs", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page, createNode } = createFigmaMock();
  const template = createNode("INSTANCE", "Tab Bar - iPhone");
  template.resize(402, 95);
  template.componentProperties = {
    Minimized: { value: "False", type: "VARIANT" },
    Tabs: { value: "2", type: "VARIANT" },
    Type: { value: "Default", type: "VARIANT" }
  };
  template.setSharedPluginData("ui_sync", "template_design_kit", "iOS 27");
  const symbolMap = createNode("FRAME", "UI Sync · SF Symbol Map");
  symbolMap.appendChild(createNode("FRAME", "mic.fill=mic-glyph"));
  symbolMap.appendChild(createNode("FRAME", "checklist=checklist-glyph"));
  symbolMap.appendChild(createNode("FRAME", "circle=circle-glyph"));
  for (let index = 0; index < 3; index += 1) {
    const tab = createNode("INSTANCE", "Tab");
    tab.componentProperties = {
      "Label#1:1": { type: "TEXT", value: `Tab ${index + 1}` },
      "Symbol#1:2": { type: "TEXT", value: "symbol" },
      Selected: { type: "VARIANT", value: index === 0 ? "True" : "False" },
      Mode: { type: "VARIANT", value: "Light" }
    };
    template.appendChild(tab);
  }
  const background = createNode("INSTANCE", "BG");
  background.componentProperties = { Mode: { type: "VARIANT", value: "Light" } };
  template.appendChild(background);

  const job = {
    projectId: "2123456789abcdef01234567",
    projectName: "Tabs from template",
    figmaFileName: "Sample Design",
    screens: [{
      id: "screen-tabs-template",
      name: "Record",
      sourceType: "screen",
      currentNodeId: null,
      renderMode: "structured",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874"><rect width="402" height="874"/></svg>',
      vectorTextMode: "pdf-glyphs",
      systemTabBar: {
        designKit: "iOS 26",
        appearance: "liquid-glass",
        selectedIndex: 1,
        items: [
          { title: "录制", systemImage: "mic.fill" },
          { title: "任务清单", systemImage: "checklist" },
          { title: "勋章柜", systemImage: "circle" }
        ]
      },
      uiTree: {
        type: "vstack", runtimeStatus: "captured",
        runtimeFrame: { x: 0, y: 0, width: 402, height: 874 },
        runtimeEnvironment: { viewport: { x: 0, y: 0, width: 402, height: 874 }, displayScale: 3, colorScheme: "dark", dynamicTypeSize: "large", layoutDirection: "leftToRight" },
        children: []
      }
    }]
  };
  const fetch = async (url, options) => options?.method === "POST"
    ? ({ ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) })
    : ({ ok: true, json: async () => job });
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Record");
  const tabBar = screen.findAll((node) => node.name === "Tab Bar · Apple iOS 27 Kit")[0];
  assert.ok(tabBar);
  assert.equal(tabBar.height, 95);
  assert.equal(tabBar.getSharedPluginData("ui_sync", "apple_kit_status"), "user-selected-template");
  assert.equal(tabBar.getSharedPluginData("ui_sync", "apple_design_kit"), "iOS 27");
  assert.equal(tabBar.getSharedPluginData("ui_sync", "source_design_kit"), "iOS 26");
  assert.equal(tabBar.getSharedPluginData("ui_sync", "system_template"), "");
  assert.equal(tabBar.getSharedPluginData("ui_sync", "engine_version"), "2026-08-14-system-templates-v4");
  const tabs = tabBar.findAll((node) => node.type === "INSTANCE" && node.name === "Tab");
  assert.deepEqual(tabs.map((tab) => tab.componentProperties["Label#1:1"].value), ["录制", "任务清单", "勋章柜"]);
  assert.deepEqual(tabs.map((tab) => tab.componentProperties.Selected.value), ["False", "True", "False"]);
  assert.deepEqual(tabs.map((tab) => tab.componentProperties.Mode.value), ["Dark", "Dark", "Dark"]);
  assert.deepEqual(tabs.map((tab) => tab.componentProperties["Symbol#1:2"].value), ["mic-glyph", "checklist-glyph", "circle-glyph"]);
});

test("Figma bridge clones the user-selected Apple liquid-glass Button template", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page, createNode } = createFigmaMock();
  const template = createNode("INSTANCE", "Button - Liquid Glass - Text");
  template.resize(85, 50);
  template.componentProperties = {
    Size: { value: "Large", type: "VARIANT" },
    Style: { value: "Glass Prominent", type: "VARIANT" },
    "Is Enabled": { value: "True", type: "VARIANT" },
    Destructive: { value: "False", type: "VARIANT" }
  };
  template.setSharedPluginData("ui_sync", "system_template", "Button");
  template.setSharedPluginData("ui_sync", "template_design_kit", "iOS 27");
  const background = createNode("INSTANCE", "BG");
  background.componentProperties = { Mode: { value: "Light", type: "VARIANT" } };
  template.appendChild(background);
  const label = createNode("INSTANCE", "Text");
  label.componentProperties = {
    "Label#10462:47": { value: "Label", type: "TEXT" },
    Mode: { value: "Light", type: "VARIANT" }
  };
  template.appendChild(label);

  const job = {
    projectId: "3123456789abcdef01234567",
    projectName: "Buttons from template",
    figmaFileName: "Sample Design",
    screens: [{
      id: "screen-button-template",
      name: "Buttons",
      sourceType: "screen",
      currentNodeId: null,
      renderMode: "structured",
      uiTree: {
        type: "vstack",
        runtimeEnvironment: { viewport: { x: 0, y: 0, width: 402, height: 874 }, displayScale: 3, colorScheme: "dark", dynamicTypeSize: "large", layoutDirection: "leftToRight" },
        children: [{ type: "button", text: "Continue", material: "glassProminent", controlSize: "small", isEnabled: false, destructive: true }]
      }
    }]
  };
  const fetch = async (url, options) => options?.method === "POST"
    ? ({ ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) })
    : ({ ok: true, json: async () => job });
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Buttons");
  const button = screen.findAll((node) => node.name === "Button · Apple iOS 27 Kit")[0];
  assert.ok(button);
  assert.equal(button.componentProperties.Size.value, "Small");
  assert.equal(button.componentProperties.Style.value, "Glass Prominent");
  assert.equal(button.componentProperties["Is Enabled"].value, "False");
  assert.equal(button.componentProperties.Destructive.value, "True");
  const buttonLabel = button.findAll((node) => node.type === "INSTANCE" && node.name === "Text")[0];
  assert.equal(buttonLabel.componentProperties["Label#10462:47"].value, "Continue");
  assert.equal(buttonLabel.componentProperties.Mode.value, "Dark");
  assert.equal(button.getSharedPluginData("ui_sync", "system_component"), "Button");
  assert.equal(button.getSharedPluginData("ui_sync", "engine_version"), "2026-08-14-system-templates-v4");
});

test("Figma bridge preserves SwiftUI layout styling and refreshes managed layers", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  let job = {
    connectionToken: "b".repeat(64),
    projectId: "fedcba987654321001234567",
    projectName: "Focus Flow",
    figmaFileName: "Sample Design",
    screens: [{
      id: "capture-screen",
      name: "Capture",
      sourceType: "screen",
      currentNodeId: null,
      renderMode: "structured",
      uiTree: {
        type: "vstack",
        alignment: "leading",
        spacing: 18,
        padding: { top: 12, right: 22, bottom: 32, left: 22 },
        children: [{
          type: "hstack",
          backgroundColorToken: "flowPanel",
          borderColorToken: "flowBorder",
          backgroundShape: "roundedRectangle",
          cornerRadius: 22,
          padding: { top: 18, right: 18, bottom: 18, left: 18 },
          children: [{ type: "symbol", symbol: "gearshape" }, { type: "text", text: "Use `gpt-5-mini`" }]
        }]
      }
    }]
  };
  const fetch = async (url, options) => {
    if (options?.method === "POST") return { ok: true, json: async () => ({ createdCount: 0, reusedCount: 1, renderedCount: 1 }) };
    return { ok: true, json: async () => job };
  };

  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Capture");
  const safeArea = screen.findAll((node) => node.name === "iPhone safe area")[0];
  assert.ok(safeArea);
  assert.equal(safeArea.paddingTop, 59);
  const panel = screen.findAll((node) => node.cornerRadius === 22)[0];
  assert.ok(panel);
  assert.equal(panel.paddingLeft, 18);
  assert.equal(panel.cornerRadius, 22);
  assert.ok(screen.findAll((node) => node.name === "SF Symbol · gearshape").length > 0);
  const markdownText = screen.findAll((node) => node.characters === "Use gpt-5-mini")[0];
  assert.equal(markdownText.textAutoResize, "WIDTH_AND_HEIGHT");
  assert.deepEqual(markdownText.fontRanges.map(({ start, end }) => ({ start, end })), [{ start: 4, end: 14 }]);

  job = {
    ...job,
    pairingCode: "654321",
    screens: [{ ...job.screens[0], currentNodeId: screen.id, uiTree: { type: "text", text: "Updated" } }]
  };
  await figma.ui.onmessage({ type: "resume" });
  const values = screen.findAll((node) => node.type === "TEXT").map((node) => node.characters);
  assert.ok(values.includes("Updated"));
  assert.equal(values.includes("Use gpt-5-mini"), false);
});

test("Figma bridge preserves negative SwiftUI padding metadata without writing invalid Auto Layout values", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const job = {
    projectId: "999999999999999999999999", projectName: "Bleed", figmaFileName: "Sample Design",
    screens: [{
      id: "bleed-screen", name: "Bleed", sourceType: "screen", currentNodeId: null, renderMode: "structured",
      uiTree: {
        type: "text", text: "Bleed", syncId: "swift/9999999999999999", sourceFile: "CityView.swift", sourceName: "CityView",
        padding: { top: -150, right: -3, bottom: 0, left: -3 }
      }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math, Object });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });
  const screen = page.children.find((node) => node.name === "Bleed");
  const container = screen.findAll((node) => node.getSharedPluginData("ui_sync", "dom_id") === "swift/9999999999999999")[0];
  assert.equal(container.paddingTop, 0);
  assert.equal(container.paddingLeft, 0);
  assert.equal(container.getSharedPluginData("ui_sync", "swift_negative_padding"), JSON.stringify({ top: -150, right: -3, bottom: 0, left: -3 }));
});

test("Figma bridge uses captured SwiftUI viewport and absolute runtime geometry", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 393, height: 852 },
    displayScale: 3,
    colorScheme: "light",
    dynamicTypeSize: "large",
    layoutDirection: "leftToRight"
  };
  const job = {
    connectionToken: "c".repeat(64),
    projectId: "1234567890abcdef12345678",
    projectName: "Runtime App",
    figmaFileName: "Sample Design",
    screens: [{
      id: "runtime-screen",
      name: "Runtime Screen",
      sourceType: "screen",
      currentNodeId: null,
      renderMode: "structured",
      uiTree: {
        type: "vstack",
        syncId: "swift/4444444444444444",
        sourceFile: "Home.swift",
        sourceName: "Home",
        runtimeStatus: "captured",
        runtimeFrame: { x: 16, y: 90, width: 361, height: 120 },
        runtimeEnvironment: environment,
        children: [{
          type: "text",
          syncId: "swift/5555555555555555",
          sourceFile: "Home.swift",
          sourceName: "Home",
          text: "Runtime value",
          runtimeStatus: "captured",
          runtimeFrame: { x: 32, y: 106, width: 100, height: 22 },
          runtimeInstances: [
            { instanceId: "row-1", x: 32, y: 106, width: 100, height: 22 },
            { instanceId: "row-2", x: 32, y: 146, width: 100, height: 22 }
          ]
        }]
      }
    }]
  };
  const fetch = async (_url, options) => {
    if (options?.method === "POST") return { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) };
    return { ok: true, json: async () => job };
  };

  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Runtime Screen");
  assert.ok(screen, `runtime screen was not created; page children: ${page.children.map((node) => node.name).join(", ")}`);
  const canvas = screen.children.find((node) => node.name === "UI Sync · Runtime Visual IR");
  const stack = canvas.children.find((node) => node.name === "Editable Content · vstack");
  const texts = stack.children.filter((node) => node.type === "TEXT");
  const text = texts[0];
  assert.equal(screen.width, 393);
  assert.equal(screen.height, 852);
  assert.equal(canvas.layoutMode, "NONE");
  assert.deepEqual({ x: stack.x, y: stack.y, width: stack.width, height: stack.height }, { x: 16, y: 90, width: 361, height: 120 });
  assert.deepEqual({ x: text.x, y: text.y, width: text.width, height: text.height }, { x: 16, y: 16, width: 100, height: 22 });
  assert.equal(text.layoutPositioning, "ABSOLUTE");
  assert.equal(texts.length, 2);
  assert.deepEqual({ x: texts[1].x, y: texts[1].y, width: texts[1].width, height: texts[1].height }, { x: 16, y: 56, width: 100, height: 22 });
  assert.equal(texts[1].getSharedPluginData("ui_sync", "runtime_instance_id"), "row-2");
});

test("Figma bridge overlays only text captured from the running app", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 393, height: 852 }, displayScale: 3,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "777777777777777777777777", projectName: "Rendered", figmaFileName: "Sample Design",
    screens: [{
      id: "rendered-screen", name: "Rendered Screen", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "editable-runtime",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="393" height="852"><path d="M0 0h393v852H0z" fill="#fff"/></svg>',
      uiTree: {
        type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 393, height: 852 }, runtimeEnvironment: environment,
        children: [{
          type: "text", text: "Editable title", runtimeTextCaptured: true, fontSize: 24, fontWeight: "bold", syncId: "swift/7777777777777777",
          sourceFile: "Home.swift", sourceName: "Home", runtimeStatus: "captured", runtimeFrame: { x: 24, y: 88, width: 180, height: 34 }
        }, {
          type: "text", text: "Source-only guess", fontSize: 17, syncId: "swift/7676767676767676",
          sourceFile: "Home.swift", sourceName: "Home", runtimeStatus: "inferred", runtimeFrame: { x: 24, y: 140, width: 180, height: 24 }
        }]
      }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };

  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Rendered Screen");
  const rendered = screen.children.find((node) => node.name === "Crank · SwiftUI PDF + Captured Runtime Text");
  assert.ok(rendered, `screen children: ${screen.children.map((node) => node.name).join(", ")}`);
  assert.equal(rendered.children.length, 2);
  assert.equal(rendered.children[0].name, "Rendered Vector · SwiftUI");
  assert.equal(rendered.children[1].name, "Editable Text");
  const title = rendered.findAll((node) => node.type === "TEXT" && node.characters === "Editable title")[0];
  assert.deepEqual({ x: title.x, y: title.y, width: title.width, height: title.height }, { x: 24, y: 88, width: 180, height: 34 });
  assert.equal(title.getSharedPluginData("ui_sync", "rendered_text"), "1");
  assert.equal(rendered.findAll((node) => node.type === "TEXT" && node.characters === "Source-only guess").length, 0);
  assert.equal(screen.getSharedPluginData("ui_sync", "swift_runtime_layout"), "3");
  assert.equal(screen.findAll((node) => node.name === "Visual Reference · Simulator").length, 0);
});

test("Figma bridge preserves PDF glyphs without duplicating source-derived text", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 393, height: 852 }, displayScale: 3,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "888888888888888888888888", projectName: "PDF", figmaFileName: "Sample Design",
    screens: [{
      id: "pdf-screen", name: "PDF Screen", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "pdf-glyphs",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="393" height="852"><use href="#glyph-0-1"/></svg>',
      uiTree: {
        type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 393, height: 852 }, runtimeEnvironment: environment,
        children: [{
          type: "text", text: "Do not duplicate", syncId: "swift/8888888888888888", sourceFile: "Home.swift", sourceName: "Home",
          runtimeStatus: "captured", runtimeFrame: { x: 24, y: 88, width: 180, height: 34 }
        }]
      }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });
  const screen = page.children.find((node) => node.name === "PDF Screen");
  const rendered = screen.children.find((node) => node.name === "Crank · Rendered SwiftUI PDF");
  assert.ok(rendered);
  assert.equal(rendered.children.length, 1);
  assert.equal(rendered.findAll((node) => node.type === "TEXT" && node.characters === "Do not duplicate").length, 0);
});

test("Figma bridge imports a PDF vector even when Swift runtime root matching is unavailable", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const job = {
    projectId: "898989898989898989898989", projectName: "Food Truck", figmaFileName: "Sample Design",
    screens: [{
      id: "food-truck-pdf", name: "Food Truck PDF", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "pdf-glyphs",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874"><path d="M0 0h402v874H0z" fill="#7bb5e7"/></svg>',
      uiTree: { type: "navigation", children: [{ type: "custom", name: "Sidebar", width: 1, height: 1 }] }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Food Truck PDF");
  assert.equal(screen.width, 402);
  assert.equal(screen.height, 874);
  const rendered = screen.children.find((node) => node.name === "Crank · Rendered SwiftUI PDF");
  assert.ok(rendered, `screen children: ${screen.children.map((node) => node.name).join(", ")}`);
  assert.equal(rendered.children[0].name, "Rendered Vector · SwiftUI");
  assert.match(rendered.children[0].sourceSvg, /fill="#7bb5e7"/);
  assert.equal(screen.findAll((node) => node.name === "Sidebar").length, 0);
});

test("Figma bridge creates editable text nodes from complete PDF text geometry", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 402, height: 874 }, displayScale: 3,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "999999999999999999999999", projectName: "Editable PDF", figmaFileName: "Sample Design",
    screens: [{
      id: "editable-pdf-screen", name: "Editable PDF Screen", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "editable-pdf",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874"><path d="M0 0h402v874H0z"/></svg>',
      vectorTextRuns: [{
        text: "脑子里在想什么？", x: 72, y: 122, width: 258, height: 34, fontSize: 34, fontWeight: "bold",
        color: { r: 23 / 255, g: 33 / 255, b: 48 / 255 }
      }],
      uiTree: { type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 402, height: 874 }, runtimeEnvironment: environment, children: [] }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });
  const screen = page.children.find((node) => node.name === "Editable PDF Screen");
  const rendered = screen.children.find((node) => node.name === "Crank · SwiftUI PDF + Editable Text");
  assert.ok(rendered, `screen children: ${screen.children.map((node) => node.name).join(", ")}`);
  const title = rendered.findAll((node) => node.type === "TEXT" && node.characters === "脑子里在想什么？")[0];
  assert.ok(title);
  assert.deepEqual({ x: title.x, y: title.y, width: title.width, height: title.height }, { x: 72, y: 122, width: 258, height: 34 });
  assert.equal(title.getSharedPluginData("ui_sync", "pdf_text"), "1");
});

test("Figma bridge tightens editable PDF text to preserve a narrow single-line glyph box", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 402, height: 874 }, displayScale: 3,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "989898989898989898989898", projectName: "PDF Text Width", figmaFileName: "Sample Design",
    screens: [{
      id: "pdf-text-width", name: "PDF Text Width", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "editable-pdf",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874"></svg>',
      vectorTextRuns: [{
        text: "坏猫很闲", x: 159, y: 500, width: 80, height: 22, fontSize: 22, fontWeight: "bold",
        color: { r: 0.1, g: 0.1, b: 0.1 }
      }],
      uiTree: { type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 402, height: 874 }, runtimeEnvironment: environment, children: [] }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });
  const screen = page.children.find((node) => node.name === "PDF Text Width");
  const title = screen.findAll((node) => node.type === "TEXT" && node.characters === "坏猫很闲")[0];
  assert.ok(title);
  assert.deepEqual({ x: title.x, y: title.y, width: title.width, height: title.height }, { x: 148.5, y: 500, width: 101, height: 22 });
  assert.equal(title.textAlignHorizontal, "CENTER");
  assert.equal(title.letterSpacing.unit, "PIXELS");
  assert.equal(title.letterSpacing.value, -20 / 3);
  assert.equal(title.getSharedPluginData("ui_sync", "pdf_width_calibration"), String(-20 / 3));
});

test("Figma bridge converts prepared SVG shadows into editable native effects", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 128, height: 128 }, displayScale: 2,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "aaaaaaaaaaaaaaaaaaaaaaaa", projectName: "Native Shadow", figmaFileName: "Sample Design",
    screens: [{
      id: "native-shadow-screen", name: "Native Shadow Screen", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "pdf-glyphs",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect id="ui-sync-shadow-0" width="88" height="88"/></svg>',
      vectorFallbackSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="88" height="88" filter="url(#shadow)"/></svg>',
      vectorNativeShadows: [{
        marker: "ui-sync-shadow-0", color: { r: 0, g: 0, b: 0, a: 0.25 },
        offset: { x: 0, y: 6 }, radius: 10, spread: 0
      }],
      uiTree: { type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 128, height: 128 }, runtimeEnvironment: environment, children: [] }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Native Shadow Screen");
  const target = screen.findAll((node) => node.name === "ui-sync-shadow-0")[0];
  assert.ok(target);
  assert.equal(target.effects.length, 1);
  assert.equal(target.effects[0].type, "DROP_SHADOW");
  assert.deepEqual({ ...target.effects[0].offset }, { x: 0, y: 6 });
  assert.equal(target.effects[0].radius, 10);
  assert.equal(target.effects[0].color.a, 0.25);
  assert.equal(target.getSharedPluginData("ui_sync", "native_svg_shadow"), "1");
});

test("Figma bridge restores source-recorded SwiftUI effects on clean SVG geometry", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 128, height: 128 }, displayScale: 2,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "abababababababababababab", projectName: "Semantic Shadow", figmaFileName: "Sample Design",
    screens: [{
      id: "semantic-shadow-screen", name: "Semantic Shadow Screen", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "pdf-glyphs",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect id="orb" x="20" y="20" width="88" height="88"/></svg>',
      vectorFallbackSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect x="10" y="10" width="108" height="108"/></svg>',
      vectorEffects: [{
        id: "swift/orb/shadow", syncId: "swift/orb", type: "DROP_SHADOW",
        frame: { x: 20, y: 20, width: 88, height: 88 }, radius: 10,
        colorToken: "flowAccent", opacity: 0.18, offset: { x: 0, y: 6 }
      }],
      uiTree: { type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 128, height: 128 }, runtimeEnvironment: environment, children: [] }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Semantic Shadow Screen");
  const target = screen.findAll((node) => node.getSharedPluginData("ui_sync", "native_swift_effect") === "swift/orb/shadow")[0];
  assert.ok(target);
  assert.equal(target.effects[0].type, "DROP_SHADOW");
  assert.equal(target.effects[0].radius, 10);
  assert.equal(target.effects[0].color.a, 0.18);
  assert.deepEqual({ ...target.effects[0].offset }, { x: 0, y: 6 });
});

test("Figma bridge restores source-recorded SwiftUI layer blur on clean SVG geometry", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 200, height: 200 }, displayScale: 2,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "cdcdcdcdcdcdcdcdcdcdcdcd", projectName: "Semantic Blur", figmaFileName: "Sample Design",
    screens: [{
      id: "semantic-blur-screen", name: "Semantic Blur Screen", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "pdf-glyphs",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect id="glow" x="40" y="40" width="120" height="120"/></svg>',
      vectorFallbackSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect x="20" y="20" width="160" height="160"/></svg>',
      vectorEffects: [{
        id: "swift/glow/blur", syncId: "swift/glow", type: "LAYER_BLUR",
        frame: { x: 40, y: 40, width: 120, height: 120 }, radius: 36
      }],
      uiTree: { type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 200, height: 200 }, runtimeEnvironment: environment, children: [] }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Semantic Blur Screen");
  const target = screen.findAll((node) => node.getSharedPluginData("ui_sync", "native_swift_effect") === "swift/glow/blur")[0];
  assert.ok(target);
  assert.deepEqual(JSON.parse(JSON.stringify(target.effects[0])), { type: "LAYER_BLUR", blurType: "NORMAL", radius: 36, visible: true });
  assert.equal(screen.findAll((node) => node.getSharedPluginData("ui_sync", "native_swift_effect_fallback") === "1").length, 0);
});

test("Figma bridge applies layer blur only to the matching SVG shape", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 200, height: 200 }, displayScale: 2,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "dededededededededededede", projectName: "Scoped Blur", figmaFileName: "Sample Design",
    screens: [{
      id: "scoped-blur-screen", name: "Scoped Blur Screen", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "pdf-glyphs",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect id="background" width="200" height="200"/><rect id="glow" x="40" y="40" width="120" height="120"/><rect id="content" x="60" y="60" width="80" height="80"/></svg>',
      vectorFallbackSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200"/></svg>',
      vectorEffects: [{
        id: "swift/glow/scoped-blur", syncId: "swift/glow", type: "LAYER_BLUR",
        frame: { x: 40, y: 40, width: 120, height: 120 }, radius: 24
      }],
      uiTree: { type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 200, height: 200 }, runtimeEnvironment: environment, children: [] }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Scoped Blur Screen");
  const target = screen.findAll((node) => node.getSharedPluginData("ui_sync", "native_swift_effect") === "swift/glow/scoped-blur")[0];
  const content = screen.findAll((node) => node.name === "content")[0];
  assert.ok(target);
  assert.equal(target.type, "VECTOR");
  assert.deepEqual({ x: target.x, y: target.y, width: target.width, height: target.height }, { x: 40, y: 40, width: 120, height: 120 });
  assert.equal(content.parent, target.parent);
  assert.equal(content.effects.length, 0);
});

test("Figma bridge suppresses a full-page blurred hairline that would become a vertical band", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 402, height: 874 }, displayScale: 3,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "797979797979797979797979", projectName: "Hairline Blur", figmaFileName: "Sample Design",
    screens: [{
      id: "hairline-blur", name: "Hairline Blur", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", vectorTextMode: "pdf-glyphs",
      vectorSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874"><rect id="background" width="402" height="874"/><rect id="beam" x="311" y="0" width="1" height="874"/></svg>',
      vectorFallbackSvg: '<svg xmlns="http://www.w3.org/2000/svg" width="402" height="874"><rect width="402" height="874"/></svg>',
      vectorEffects: [{
        id: "swift/beam/blur", syncId: "swift/beam", type: "LAYER_BLUR",
        frame: { x: 311, y: 0, width: 1, height: 874 }, radius: 10
      }],
      uiTree: { type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 402, height: 874 }, runtimeEnvironment: environment, children: [] }
    }]
  };
  const fetch = async (_url, options) => options?.method === "POST"
    ? { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) }
    : { ok: true, json: async () => job };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });
  const screen = page.children.find((node) => node.name === "Hairline Blur");
  assert.ok(screen);
  assert.equal(screen.findAll((node) => node.name === "beam").length, 0);
  assert.equal(screen.findAll((node) => node.getSharedPluginData("ui_sync", "native_swift_effect") === "swift/beam/blur").length, 0);
  const vector = screen.findAll((node) => node.name === "Rendered Vector · SwiftUI")[0];
  assert.equal(vector.getSharedPluginData("ui_sync", "native_swift_effect_count"), "0");
});

test("Figma bridge keeps a hidden simulator reference and uses crops for opaque SwiftUI views", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  const environment = {
    viewport: { x: 0, y: 0, width: 393, height: 852 }, displayScale: 3,
    colorScheme: "light", dynamicTypeSize: "large", layoutDirection: "leftToRight"
  };
  const job = {
    projectId: "abcdef1234567890abcdef12", projectName: "Hybrid", figmaFileName: "Sample Design",
    screens: [{
      id: "hybrid-screen", name: "Hybrid Screen", sourceType: "screen", currentNodeId: null,
      renderMode: "structured", visualReferenceAssetId: "swift-reference-page",
      uiTree: {
        type: "vstack", runtimeStatus: "captured", runtimeFrame: { x: 0, y: 0, width: 393, height: 852 }, runtimeEnvironment: environment,
        children: [{
          type: "custom", name: "WebView", syncId: "swift/1111111111111111", runtimeStatus: "captured",
          runtimeFrame: { x: 10, y: 100, width: 373, height: 400 }, visualMode: "snapshot-fallback",
          visualConfidence: "low", fallbackAssetId: "swift-fallback-web"
        }]
      }
    }]
  };
  const fetch = async (url, options) => {
    if (options?.method === "POST") return { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) };
    if (String(url).includes("/assets/")) return { ok: true, arrayBuffer: async () => Uint8Array.from([137, 80, 78, 71]).buffer };
    return { ok: true, json: async () => job };
  };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  const screen = page.children.find((node) => node.name === "Hybrid Screen");
  const reference = screen.findAll((node) => node.name === "Visual Reference · Simulator")[0];
  const fallback = screen.findAll((node) => node.name === "WebView · Visual fallback")[0];
  assert.equal(reference.visible, false);
  assert.equal(reference.locked, true);
  assert.ok(fallback);
  assert.equal(fallback.getSharedPluginData("ui_sync", "visual_mode"), "snapshot-fallback");
});

test("Figma bridge rebuilds rendered DOM as editable Figma layers", async () => {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page, messages } = createFigmaMock();
  let completion = null;
  const elementStyle = {
    backgroundColor: "rgb(244, 244, 242)",
    borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)",
    borderBottomColor: "rgba(0, 0, 0, 0)", borderLeftColor: "rgba(0, 0, 0, 0)",
    borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0,
    borderRadius: 0, opacity: 1, clipsContent: true
  };
  let job = {
    projectId: "1234567890abcdef12345678",
    projectName: "UI Sync",
    figmaFileName: "Sample Design",
    screens: [{
      id: "editable-screen", name: "Connections", sourceType: "screen", currentNodeId: null,
      renderMode: "editable-dom", width: 1220, height: 790,
      domTree: {
        kind: "element", id: "root", selector: ".app-frame", name: "Application", x: 0, y: 0, width: 1220, height: 790,
        style: { ...elementStyle, shadows: [{ type: "DROP_SHADOW", color: { r: 0, g: 0, b: 0, a: 0.08 }, offset: { x: 0, y: 2 }, radius: 5, spread: 0, visible: true, blendMode: "NORMAL" }] },
        children: [
          {
            kind: "text", id: "root/text:0", selector: ".title", name: "Title", text: "Application pages",
            sourceText: "Application pages", wrapMode: "nowrap", lineCount: 1,
            lineRects: [{ x: 0, y: 0, width: 180, height: 28 }], layoutWidth: 180,
            x: 246, y: 120, width: 180, height: 28,
            style: {
              color: "rgb(32, 33, 31)", fontSize: 22, fontWeight: 700, lineHeight: 28, letterSpacing: 0, textAlign: "left",
              fontFamilies: ["Inter", "sans-serif"], resolvedFontFamily: "Inter", fontStyle: "normal", fontStretch: "100%",
              textCase: "uppercase",
              whiteSpace: "nowrap", wordBreak: "normal", overflowWrap: "normal", direction: "ltr", writingMode: "horizontal-tb"
            }
          },
          {
            kind: "text", id: "root/text:1", selector: ".body", name: "Body", text: "A paragraph that wraps onto two lines.",
            sourceText: "A paragraph that wraps onto two lines.", wrapMode: "wrap", lineCount: 2,
            lineRects: [{ x: 0, y: 0, width: 210, height: 20 }, { x: 0, y: 20, width: 118, height: 20 }],
            lineBreakOffsets: [23], layoutWidth: 240, layoutX: 231,
            x: 246, y: 164, width: 210, height: 40,
            style: {
              color: "rgb(32, 33, 31)", fontSize: 16, fontWeight: 400, lineHeight: 20, letterSpacing: 0, textAlign: "left",
              fontFamilies: ["system-ui", "sans-serif"], resolvedFontFamily: "system-ui", fontStyle: "normal", fontStretch: "100%",
              whiteSpace: "normal", wordBreak: "normal", overflowWrap: "normal", direction: "ltr", writingMode: "horizontal-tb"
            }
          },
          {
            kind: "text", id: "root/text:2", selector: ".pre", name: "Preformatted", text: "First\nSecond",
            sourceText: "First\nSecond", wrapMode: "explicit", lineCount: 2,
            lineRects: [{ x: 0, y: 0, width: 36, height: 18 }, { x: 0, y: 18, width: 52, height: 18 }],
            layoutWidth: 80, layoutX: 246, x: 246, y: 220, width: 52, height: 36,
            style: {
              color: "rgb(32, 33, 31)", fontSize: 14, fontWeight: 400, lineHeight: 18, letterSpacing: 0, textAlign: "left",
              fontFamilies: ["system-ui", "sans-serif"], resolvedFontFamily: "system-ui", fontStyle: "normal", fontStretch: "100%",
              whiteSpace: "pre-wrap", wordBreak: "normal", overflowWrap: "normal", direction: "ltr", writingMode: "horizontal-tb"
            }
          },
          { kind: "svg", id: "root/element:0", selector: ".link-icon", name: "Link icon", x: 18, y: 18, width: 16, height: 16, svg: "<svg xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M0 0h16v16H0z\"/></svg>" }
        ]
      }
    }]
  };
  const fetch = async (_url, options) => {
    if (options?.method === "POST") {
      completion = JSON.parse(options.body);
      return { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) };
    }
    return { ok: true, json: async () => job };
  };

  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math, Number, Buffer });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });

  assert.equal(completion.mappings[0].contentDisposition, "rendered");
  const screen = page.children.find((node) => node.name === "Connections");
  assert.equal(screen.width, 1220);
  assert.equal(screen.children[0].name, "Crank · Editable DOM");
  const importedTitle = screen.findAll((node) => node.type === "TEXT").find((node) => node.characters === "Application pages");
  assert.ok(importedTitle);
  assert.deepEqual(importedTitle.fontName, { family: "Inter", style: "Bold" });
  assert.equal(importedTitle.textAutoResize, "WIDTH_AND_HEIGHT");
  // The page renders this uppercase from markup that is not. Set as a property,
  // so the layer still carries the words the source uses.
  assert.equal(importedTitle.textCase, "UPPER");
  assert.equal(importedTitle.characters, "Application pages", "and the source string is untouched");
  const shadowed = screen.findAll((node) => node.name === "Application")[0] ?? screen.children[0];
  assert.equal(shadowed.effects?.[0]?.type, "DROP_SHADOW", "a card is not flat");
  assert.equal(shadowed.effects?.[0]?.radius, 5);
  const titleBounds = screen.findAll((node) => node.getSharedPluginData("ui_sync", "text_container") === "1")[0];
  assert.deepEqual({ x: titleBounds.x, y: titleBounds.y, width: titleBounds.width, height: titleBounds.height }, { x: 246, y: 120, width: 180, height: 28 });
  const importedBody = screen.findAll((node) => node.type === "TEXT").find((node) => node.characters.startsWith("A paragraph"));
  assert.equal(importedBody.textAutoResize, "HEIGHT");
  assert.equal(importedBody.characters, "A paragraph that wraps \nonto two lines.");
  const bodyBounds = screen.findAll((node) => node.getSharedPluginData("ui_sync", "text_container") === "1")[1];
  assert.deepEqual({ x: bodyBounds.x, width: bodyBounds.width, height: bodyBounds.height }, { x: 231, width: 240, height: 40 });
  const preformatted = screen.findAll((node) => node.type === "TEXT").find((node) => node.characters.startsWith("First"));
  assert.equal(preformatted.characters, "First\nSecond");
  assert.ok(screen.findAll((node) => node.name === "Link icon").length > 0);

  screen.findAll((node) => node.type === "TEXT")[0].characters = "Edited in Figma";
  job = { ...job, operation: "pull", screens: [{ ...job.screens[0], currentNodeId: screen.id }] };
  await figma.ui.onmessage({ type: "connect", pairingCode: "654321" });
  assert.equal(completion.operation, "pull");
  assert.ok(completion.screens[0].nodes.some((node) => node.text === "Edited in Figma"));
  assert.ok(completion.screens[0].nodes.some((node) => node.text === "A paragraph that wraps onto two lines."));
  assert.ok(completion.screens[0].nodes.some((node) => node.text === "First\nSecond"));

  // A font Figma does not have is substituted and named. It used to throw,
  // which aborted the render *after* the frame existed — so one missing
  // typeface left the whole page as an empty rectangle on the canvas, every
  // shape, image and vector on it lost.
  const missingFontJob = JSON.parse(JSON.stringify(job));
  missingFontJob.operation = "push";
  missingFontJob.screens[0].id = "missing-font";
  missingFontJob.screens[0].name = "Missing Font";
  missingFontJob.screens[0].currentNodeId = null;
  missingFontJob.screens[0].domTree.children[0].style.resolvedFontFamily = "Unavailable Sans";
  job = missingFontJob;
  await figma.ui.onmessage({ type: "connect", pairingCode: "777777" });

  assert.ok(!messages.some((message) => message.type === "error"), "a missing font is not a failure");
  const substituted = page.children.find((node) => node.name === "Missing Font");
  assert.ok(substituted, "the frame is created");
  assert.equal(substituted.children[0].name, "Crank · Editable DOM", "and it is not left empty");
  assert.ok(substituted.findAll((node) => node.name === "Link icon").length > 0, "the vector on it survives the missing font");
  const swapped = substituted.findAll((node) => node.type === "TEXT").find((node) => node.characters === "Application pages");
  assert.notEqual(swapped.fontName.family, "Unavailable Sans", "the run uses something Figma actually has");
  assert.deepEqual(completion.substitutedFonts, ["Unavailable Sans"], "and the swap is reported, never silent");
});

/**
 * A real application used emoji as its icons, and every one of them arrived in
 * Figma as a black square: SF Pro has no glyph for them, and a text layer set
 * in it draws the missing-glyph box.
 */
async function pushEmojiText(fonts) {
  const source = await readFile(path.join(__dirname, "..", "figma-plugin", "code.js"), "utf8");
  const { figma, page } = createFigmaMock();
  if (fonts) figma.listAvailableFontsAsync = async () => fonts;
  let completion = null;
  const job = {
    projectId: "1234567890abcdef12345678",
    projectName: "UI Sync",
    figmaFileName: "Sample Design",
    screens: [{
      id: "emoji-screen", name: "Chat", sourceType: "screen", currentNodeId: null,
      renderMode: "editable-dom", width: 600, height: 400,
      domTree: {
        kind: "element", id: "root", selector: ".shell", name: "Application", x: 0, y: 0, width: 600, height: 400,
        style: {
          backgroundColor: "rgb(255, 255, 255)",
          borderTopColor: "rgba(0, 0, 0, 0)", borderRightColor: "rgba(0, 0, 0, 0)",
          borderBottomColor: "rgba(0, 0, 0, 0)", borderLeftColor: "rgba(0, 0, 0, 0)",
          borderTopWidth: 0, borderRightWidth: 0, borderBottomWidth: 0, borderLeftWidth: 0,
          borderRadius: 0, opacity: 1, clipsContent: true
        },
        children: [{
          kind: "text", id: "root/text:0", selector: ".row", name: "Row", text: "Ask 🤓 anything",
          sourceText: "Ask 🤓 anything", wrapMode: "nowrap", lineCount: 1,
          lineRects: [{ x: 0, y: 0, width: 160, height: 20 }], layoutWidth: 160,
          x: 20, y: 20, width: 160, height: 20,
          style: {
            color: "rgb(0, 0, 0)", fontSize: 14, fontWeight: 400, lineHeight: 20, letterSpacing: 0, textAlign: "left",
            fontFamilies: ["ui-sans-serif"], resolvedFontFamily: "ui-sans-serif", fontStyle: "normal", fontStretch: "100%",
            whiteSpace: "nowrap", wordBreak: "normal", overflowWrap: "normal", direction: "ltr", writingMode: "horizontal-tb"
          }
        }]
      }
    }]
  };
  const fetch = async (url, options) => {
    if (options?.method === "POST") {
      completion = JSON.parse(options.body);
      return { ok: true, json: async () => ({ createdCount: 1, reusedCount: 0, renderedCount: 1 }) };
    }
    return { ok: true, json: async () => job };
  };
  vm.runInNewContext(source, { figma, fetch, __html__: "", console, Error, Map, Set, Promise, String, Math });
  await figma.ui.onmessage({ type: "connect", pairingCode: "123456" });
  const text = page.findAll((node) => node.type === "TEXT").find((node) => node.characters.includes("🤓"));
  return { text, completion };
}

test("an emoji is set in a font that has one, without moving the sentence around it", async () => {
  const { text } = await pushEmojiText([
    { fontName: { family: "SF Pro", style: "Regular" } },
    { fontName: { family: "SF Pro", style: "Bold" } },
    { fontName: { family: "SF Pro", style: "Semibold" } },
    { fontName: { family: "Apple Color Emoji", style: "Regular" } }
  ]);
  assert.ok(text, "the row was drawn");
  assert.equal(text.fontName.family, "SF Pro", "the words keep the typeface they were measured in");
  const ranges = text.fontRanges ?? [];
  const emojiRange = ranges.find((range) => range.fontName.family === "Apple Color Emoji");
  assert.ok(emojiRange, `expected an emoji range, got ${JSON.stringify(ranges)}`);
  // "Ask " is four characters; the emoji is a surrogate pair.
  assert.deepEqual([emojiRange.start, emojiRange.end], [4, 6]);
});

test("and when Figma has no emoji font at all, that is reported rather than drawn as boxes", async () => {
  const { text, completion } = await pushEmojiText([
    { fontName: { family: "SF Pro", style: "Regular" } },
    { fontName: { family: "SF Pro", style: "Bold" } },
    { fontName: { family: "SF Pro", style: "Semibold" } }
  ]);
  assert.ok(text);
  assert.deepEqual(text.fontRanges ?? [], [], "nothing is set to a font that does not exist");
  assert.ok(
    completion.substitutedFonts.includes("an emoji font"),
    `expected the missing emoji font to be named, got ${JSON.stringify(completion.substitutedFonts)}`
  );
});
