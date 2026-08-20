import type { ProjectInfo, SemanticChange } from "../types";

export const fallbackProject: ProjectInfo = {
  id: "ui-sync-preview",
  root: "/Users/you/Projects/crank-demo",
  name: "UI Sync Demo",
  kind: "desktop",
  framework: "Electron + React + Vite",
  analysisEngine: "Editable DOM capture",
  figmaFileName: null,
  frameName: null,
  frameNodeId: null,
  fileKey: null,
  linkedCount: 0,
  revision: 0,
  snapshotCount: 0,
  lastOrigin: "preview",
  lastSyncedAt: null,
  connectionStatus: "setup",
  sourceFileCount: 0,
  screens: []
};

export const swiftUiFallbackProject: ProjectInfo = {
  id: "swiftui-preview",
  root: "/tmp/SwiftSample",
  name: "SwiftSample",
  kind: "swiftui",
  framework: "SwiftUI · iOS",
  analysisEngine: "SwiftSyntax",
  figmaFileName: null,
  frameName: null,
  frameNodeId: null,
  fileKey: null,
  linkedCount: 0,
  revision: 0,
  snapshotCount: 0,
  lastOrigin: "discovery",
  lastSyncedAt: null,
  connectionStatus: "setup",
  sourceFileCount: 3,
  screens: [
    { id: "HomeView", name: "Home", sourceType: "screen", patterns: ["Navigation", "List"], sfSymbolCount: 1, semanticColorCount: 0, hasCustomFont: false, uiTree: { type: "navigation", title: "Home", children: [{ type: "list", children: [{ type: "label", text: "Saved", symbol: "bookmark" }] }] } },
    { id: "ProfileView", name: "Profile", sourceType: "modal", patterns: ["Scrollable content", "Sheet"], sfSymbolCount: 0, semanticColorCount: 1, hasCustomFont: false, uiTree: { type: "scroll", direction: "vertical", children: [{ type: "vstack", children: [{ type: "text", text: "Profile" }] }] } },
    { id: "ProfileRow", name: "ProfileRow", sourceType: "component", patterns: [], sfSymbolCount: 1, semanticColorCount: 0, hasCustomFont: false, uiTree: { type: "label", text: "Account", symbol: "person" } }
  ]
};

export const uiSyncSelfProject: ProjectInfo = {
  id: "ui-sync-self-capture",
  root: "/Users/you/Projects/crank-demo",
  name: "UI Sync",
  kind: "desktop",
  framework: "Electron + React + Vite + Tailwind",
  analysisEngine: "Editable DOM capture",
  figmaFileName: "UI Sync Design",
  frameName: "UI Sync",
  frameNodeId: null,
  fileKey: "ui-sync-preview",
  linkedCount: 3,
  revision: 4,
  snapshotCount: 4,
  lastOrigin: "code",
  lastSyncedAt: "2026-08-13T10:42:00.000Z",
  connectionStatus: "connected",
  sourceFileCount: 5,
  screens: [
    { id: "self-project", name: "Project", sourceType: "screen", patterns: ["Editable rendered view"], sfSymbolCount: 0, semanticColorCount: 0, hasCustomFont: false, captureView: "connections", figmaNodeId: null, figmaFrameName: null }
  ]
};

export const previewChanges: SemanticChange[] = [
  {
    id: "timeline-spacing",
    area: "Today timeline",
    property: "Top spacing",
    before: "14 px",
    after: "18 px",
    kind: "spacing"
  },
  {
    id: "activity-radius",
    area: "Activity panel",
    property: "Corner radius",
    before: "14 px",
    after: "18 px",
    kind: "shape"
  },
  {
    id: "navigation-width",
    area: "Navigation",
    property: "Panel width",
    before: "232 px",
    after: "224 px",
    kind: "size"
  },
  {
    id: "header-divider",
    area: "Header",
    property: "Divider color",
    before: "#E5E5E2",
    after: "#D8D8D4",
    kind: "color"
  }
];
