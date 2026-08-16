import type { AutomaticMappingSession, AutomaticMappingStatus, CodexSyncResult, DesignBuildResult, LivePreviewBounds, LivePreviewSession, LivePreviewStatus, ProjectInfo, ProjectKind, ProjectPreview, PullApplyResult, SemanticIntent, SwiftUiDesignSession, VisualEditResult } from "./types";

declare global {
  interface Window {
    uiSync?: {
      listProjects: () => Promise<ProjectInfo[]>;
      addProject: (kind: ProjectKind) => Promise<ProjectInfo[]>;
      inspectDroppedProjects: (roots: string[]) => Promise<ProjectInfo[]>;
      getProjectPreviews: (root: string) => Promise<ProjectPreview[]>;
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
