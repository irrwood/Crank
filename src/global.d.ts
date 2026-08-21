import type { DiscoveredPage, PageInventory, PageInventoryFiltered, InventoryGroup, InventoryTarget, ScanLifecycle, ScanProgress, ScanStatus, FigmaBuildProgress, AutomaticMappingSession, AutomaticMappingStatus, FigmaConnection, CodexSyncResult, DesignBuildResult, LivePreviewBounds, LivePreviewSession, LivePreviewStatus, ProjectInfo, ProjectKind, ProjectPreview, PullApplyResult, SemanticIntent, SwiftUiDesignSession, VisualEditResult } from "./types";

declare global {
  interface Window {
    uiSync?: {
      listProjects: () => Promise<ProjectInfo[]>;
      addProject: (kind: ProjectKind) => Promise<ProjectInfo[]>;
      inspectDroppedProjects: (roots: string[]) => Promise<ProjectInfo[]>;
      getProjectPreviews: (root: string) => Promise<ProjectPreview[]>;
      scanUrl: (url: string, seedPaths?: string[]) => Promise<PageInventory>;
      scanFolder: (root: string, workspaceRoot?: string) => Promise<PageInventory>;
      /** Scans the app already running behind a Chromium debugging port. */
      scanAttached: (port: number) => Promise<PageInventory>;
      listDebugWindows: (port: number) => Promise<{
        ok: boolean;
        windows: Array<{ id: string; title: string; url: string }>;
      }>;
      startRecording: (target: string) => Promise<{ ok: boolean; origin?: string; message?: string }>;
      captureRecording: () => Promise<{ ok: boolean; count?: number; message?: string }>;
      stopRecording: () => Promise<{ ok: boolean; pages: DiscoveredPage[] }>;
      recapturePage: (
        source: { kind: "folder" | "url"; target: string },
        page: DiscoveredPage
      ) => Promise<{ ok: boolean; message?: string; page?: DiscoveredPage }>;
      explorePage: (
        source: { kind: "folder" | "url"; target: string },
        page: DiscoveredPage,
        held: Array<{ id: string; route: string; url?: string }>
      ) => Promise<{
        ok: boolean;
        message?: string;
        pages?: DiscoveredPage[];
        inert?: Array<{ label: string; from: string }>;
      }>;
      dropPage: (source: { kind: "folder" | "url"; target: string }, pageId: string) => Promise<{ ok: boolean }>;
      sendInventoryToFigma: (
        inventory: { origin?: string; source?: { kind: "folder" | "url"; target: string }; pages: DiscoveredPage[] },
        figmaUrl: string
      ) => Promise<{ ok: boolean; message?: string; pairingCode?: string; expiresAt?: string; screenCount?: number; requiresPairing?: boolean; fileName?: string; fileKey?: string; missing?: string[]; missingReasons?: string[]; dropped?: string[]; substitutedFonts?: string[] }>;
      getFigmaExportStatus: (pairingCode: string) => Promise<AutomaticMappingStatus>;
      onRecorded: (callback: (page: DiscoveredPage) => void) => () => void;
      chooseFolder: () => Promise<string | null>;
      listInventoryTargets: () => Promise<Array<InventoryTarget | InventoryGroup>>;
      openInventory: (id: string) => Promise<PageInventory | null>;
      restoreFilteredPage: (
        source: { kind: "folder" | "url"; target: string },
        item: { label: string; route: string; recipe: Array<{ kind?: string; locator: string; label: string }> }
      ) => Promise<{ ok: boolean; message?: string; page?: DiscoveredPage }>;
      openPagePreview: (
        id: string,
        page: { route: string; recipe: Array<{ locator: string; label: string }> },
        bounds: { x: number; y: number; width: number; height: number }
      ) => Promise<{ ok: boolean; message?: string; missed?: string[]; url?: string }>;
      setPagePreviewBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
      closePagePreview: () => Promise<boolean>;
      forgetInventoryTarget: (id: string) => Promise<Array<InventoryTarget | InventoryGroup>>;
      onScanStatus: (callback: (value: ScanStatus) => void) => () => void;
      onScanLifecycle: (callback: (value: ScanLifecycle) => void) => () => void;
      exportHandoffPage: (inventory: { origin?: string; pages: DiscoveredPage[]; filtered?: PageInventoryFiltered[] }, title?: string) => Promise<{ saved: boolean; filePath?: string }>;
      revealFile: (filePath: string) => Promise<void>;
      onScanProgress: (callback: (value: ScanProgress) => void) => () => void;
      onFigmaBuildProgress: (callback: (value: FigmaBuildProgress) => void) => () => void;
      getDroppedPath: (file: File) => string;
      connectFigmaProject: (root: string, figmaUrl: string) => Promise<ProjectInfo>;
      mapProjectScreen: (root: string, screenId: string, figmaUrl: string) => Promise<ProjectInfo>;
      beginAutomaticMapping: (root: string, targetId?: string) => Promise<AutomaticMappingSession>;
      beginPull: (root: string) => Promise<AutomaticMappingSession>;
      applyPull: (root: string) => Promise<PullApplyResult>;
      syncFromFigmaWithCodex: (root: string) => Promise<CodexSyncResult>;
      openCodexConversation: (root: string) => Promise<{ project: ProjectInfo; needsSend: boolean }>;
      onCodexThreadStarted: (callback: (value: { root: string; threadId: string }) => void) => () => void;
      openCodexThread: (threadId: string) => Promise<void>;
      getAutomaticMappingStatus: (root: string, pairingCode: string) => Promise<AutomaticMappingStatus>;
      refreshProject: (root: string) => Promise<ProjectInfo>;
      runSwiftUiDesignBuild: (root: string) => Promise<DesignBuildResult>;
      getSwiftUiDesignSession: (root: string) => Promise<SwiftUiDesignSession>;
      applySwiftUiVisualEdits?: (root: string, batch: { version: 1; projectRoot: string; pageName: string; createdAt: string; nodes: SwiftUiDesignSession["nodes"]; operations: SemanticIntent[] }) => Promise<VisualEditResult>;
      resolveSwiftUiVisualEdit?: (root: string, resolution: "accept" | "reject") => Promise<void>;
      showFigmaPlugin: () => Promise<void>;
      getFigmaConnection: () => Promise<FigmaConnection>;
      startFigmaPairing: () => Promise<{ ok: boolean; message?: string; pairingCode?: string; expiresAt?: string }>;
      forgetFigmaConnection: () => Promise<FigmaConnection>;
      copyText: (value: string) => Promise<void>;
      openFigma: (fileKey: string, nodeId: string | null) => Promise<void>;
      startLivePreview: (root: string, capturePath: string, bounds: LivePreviewBounds) => Promise<LivePreviewSession>;
      setLivePreviewBounds: (bounds: LivePreviewBounds) => Promise<boolean>;
      navigateLivePreview: (capturePath: string) => Promise<{ url: string; blockedHosts: string[] }>;
      reloadLivePreview: () => Promise<boolean>;
      stopLivePreview: () => Promise<boolean>;
      getLivePreviewStatus: (root: string) => Promise<LivePreviewStatus>;
      stopDevServer: (root: string) => Promise<boolean>;
    };
  }
}

export {};
