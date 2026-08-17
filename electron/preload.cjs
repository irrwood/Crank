const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("uiSync", {
  listProjects: () => ipcRenderer.invoke("projects:list"),
  addProject: (kind) => ipcRenderer.invoke("projects:add", kind),
  inspectDroppedProjects: (roots) => ipcRenderer.invoke("projects:inspect-dropped", roots),
  getProjectPreviews: (root) => ipcRenderer.invoke("projects:previews", root),
  scanUrl: (url, seedPaths) => ipcRenderer.invoke("inventory:scan", url, seedPaths),
  scanFolder: (root, workspaceRoot) => ipcRenderer.invoke("inventory:scan-folder", root, workspaceRoot),
  startRecording: (target) => ipcRenderer.invoke("inventory:record-start", target),
  captureRecording: () => ipcRenderer.invoke("inventory:record-capture"),
  stopRecording: () => ipcRenderer.invoke("inventory:record-stop"),
  sendInventoryToFigma: (inventory, figmaUrl) => ipcRenderer.invoke("inventory:send-to-figma", inventory, figmaUrl),
  getFigmaExportStatus: (pairingCode) => ipcRenderer.invoke("inventory:figma-status", pairingCode),
  onRecorded: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("inventory:recorded", listener);
    return () => ipcRenderer.removeListener("inventory:recorded", listener);
  },
  chooseFolder: () => ipcRenderer.invoke("inventory:choose-folder"),
  listInventoryTargets: () => ipcRenderer.invoke("inventory:targets"),
  openInventory: (id) => ipcRenderer.invoke("inventory:open", id),
  forgetInventoryTarget: (id) => ipcRenderer.invoke("inventory:forget", id),
  onScanStatus: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("inventory:status", listener);
    return () => ipcRenderer.removeListener("inventory:status", listener);
  },
  onScanLifecycle: (callback) => {
    const started = (_event, value) => callback({ phase: "started", ...value });
    const finished = (_event, value) => callback({ phase: "finished", ...value });
    ipcRenderer.on("inventory:started", started);
    ipcRenderer.on("inventory:finished", finished);
    return () => {
      ipcRenderer.removeListener("inventory:started", started);
      ipcRenderer.removeListener("inventory:finished", finished);
    };
  },
  exportHandoffPage: (inventory, title) => ipcRenderer.invoke("inventory:export", inventory, title),
  revealFile: (filePath) => ipcRenderer.invoke("inventory:reveal", filePath),
  onScanProgress: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("inventory:progress", listener);
    return () => ipcRenderer.removeListener("inventory:progress", listener);
  },
  getDroppedPath: (file) => webUtils.getPathForFile(file),
  connectFigmaProject: (root, figmaUrl) => ipcRenderer.invoke("projects:connect-figma", root, figmaUrl),
  mapProjectScreen: (root, screenId, figmaUrl) => ipcRenderer.invoke("projects:map-screen", root, screenId, figmaUrl),
  beginAutomaticMapping: (root, targetId) => ipcRenderer.invoke("projects:auto-map", root, targetId),
  beginPull: (root) => ipcRenderer.invoke("projects:pull", root),
  applyPull: (root) => ipcRenderer.invoke("projects:apply-pull", root),
  syncFromFigmaWithCodex: (root) => ipcRenderer.invoke("projects:sync-from-figma-with-codex", root),
  openCodexConversation: (root) => ipcRenderer.invoke("projects:open-codex-conversation", root),
  onCodexThreadStarted: (callback) => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("projects:codex-thread-started", listener);
    return () => ipcRenderer.removeListener("projects:codex-thread-started", listener);
  },
  openCodexThread: (threadId) => ipcRenderer.invoke("codex:open-thread", threadId),
  getAutomaticMappingStatus: (root, pairingCode) => ipcRenderer.invoke("projects:auto-map-status", root, pairingCode),
  refreshProject: (root) => ipcRenderer.invoke("projects:refresh", root),
  runSwiftUiDesignBuild: (root) => ipcRenderer.invoke("projects:design-build", root),
  getSwiftUiDesignSession: (root) => ipcRenderer.invoke("projects:design-session", root),
  applySwiftUiVisualEdits: (root, batch) => ipcRenderer.invoke("projects:visual-edit", root, batch),
  resolveSwiftUiVisualEdit: (root, resolution) => ipcRenderer.invoke("projects:visual-edit-resolve", root, resolution),
  showFigmaPlugin: () => ipcRenderer.invoke("figma:show-plugin"),
  copyText: (value) => ipcRenderer.invoke("clipboard:write", value),
  openFigma: (fileKey, nodeId) => ipcRenderer.invoke("figma:open", fileKey, nodeId),
  startLivePreview: (root, capturePath, bounds) => ipcRenderer.invoke("preview:start", root, capturePath, bounds),
  setLivePreviewBounds: (bounds) => ipcRenderer.invoke("preview:set-bounds", bounds),
  navigateLivePreview: (capturePath) => ipcRenderer.invoke("preview:navigate", capturePath),
  reloadLivePreview: () => ipcRenderer.invoke("preview:reload"),
  stopLivePreview: () => ipcRenderer.invoke("preview:stop"),
  getLivePreviewStatus: (root) => ipcRenderer.invoke("preview:status", root),
  stopDevServer: (root) => ipcRenderer.invoke("preview:stop-server", root)
});
