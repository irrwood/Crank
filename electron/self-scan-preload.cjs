const { contextBridge, ipcRenderer } = require("electron");

/**
 * The bridge UI Sync gives the copy of itself that it is scanning.
 *
 * Scanning an Electron app through http gets a shell: the preload belongs to
 * the real window, so the copy has no projects and every screen is an empty
 * state. For its own interface UI Sync does not have that problem — the preload
 * is right here — and the window it opens to crawl can simply be given one.
 *
 * Given a *reading* one. A crawl clicks everything it finds, and with the real
 * bridge attached those clicks are real: Rescan would start scans inside a
 * scan, Remove would forget a project, Send to Figma would queue a job. The
 * network-level guard that protects someone else's app does not apply, because
 * these are not requests — they are this application's own calls.
 *
 * So the channels that only read are forwarded and everything else answers in
 * the shape the interface expects without doing anything. What the crawl sees
 * is the real inventory; what it can change is nothing.
 */

const readable = new Set([
  "projects:list",
  "projects:previews",
  "inventory:targets",
  "inventory:open",
  "figma:plugin-path"
]);

const forward = (channel) => (...args) => (
  readable.has(channel)
    ? ipcRenderer.invoke(channel, ...args)
    : Promise.reject(new Error(`${channel} is not available while UI Sync is scanning itself`))
);

/** Answers in the right shape, so the interface renders rather than throwing. */
const inert = (value) => async () => value;
const noListener = () => () => {};

contextBridge.exposeInMainWorld("uiSync", {
  // Reading — the whole point of scanning with a bridge at all.
  listProjects: forward("projects:list"),
  getProjectPreviews: forward("projects:previews"),
  listInventoryTargets: forward("inventory:targets"),
  openInventory: forward("inventory:open"),

  // Everything that would act. Shaped so a click is a no-op rather than an
  // error the interface has to render as a failed state.
  addProject: inert([]),
  inspectDroppedProjects: inert([]),
  scanUrl: inert({ ok: false, message: "UI Sync is scanning itself; this copy cannot start a scan." }),
  scanFolder: inert({ ok: false, message: "UI Sync is scanning itself; this copy cannot start a scan." }),
  scanAttached: inert({ ok: false, message: "UI Sync is scanning itself; this copy cannot start a scan." }),
  listDebugWindows: inert({ ok: false, windows: [] }),
  startRecording: inert({ ok: false, message: "Not available while UI Sync is scanning itself." }),
  captureRecording: inert({ ok: false }),
  stopRecording: inert({ ok: true, pages: [] }),
  recapturePage: inert({ ok: false, message: "Not available while UI Sync is scanning itself." }),
  explorePage: inert({ ok: false, message: "Not available while UI Sync is scanning itself." }),
  dropPage: inert({ ok: true }),
  sendInventoryToFigma: inert({ ok: false, message: "Not available while UI Sync is scanning itself." }),
  getFigmaExportStatus: inert({ state: "waiting" }),
  chooseFolder: inert(null),
  forgetInventoryTarget: forward("inventory:targets"),
  exportHandoffPage: inert({ saved: false }),
  revealFile: inert(undefined),
  connectFigmaProject: inert(null),
  mapProjectScreen: inert(null),
  beginAutomaticMapping: inert(null),
  beginPull: inert(null),
  applyPull: inert({ changedFiles: [], validation: [], needsCodex: false }),
  syncFromFigmaWithCodex: inert(null),
  openCodexConversation: inert(null),
  openCodexThread: inert(undefined),
  getAutomaticMappingStatus: inert({ state: "waiting" }),
  refreshProject: inert(null),
  runSwiftUiDesignBuild: inert(null),
  getSwiftUiDesignSession: inert(null),
  applySwiftUiVisualEdits: inert(null),
  resolveSwiftUiVisualEdit: inert(undefined),
  showFigmaPlugin: inert(undefined),
  copyText: inert(undefined),
  openFigma: inert(undefined),
  startLivePreview: inert(null),
  setLivePreviewBounds: inert(false),
  navigateLivePreview: inert({ url: "", blockedHosts: [] }),
  reloadLivePreview: inert(false),
  stopLivePreview: inert(false),
  getLivePreviewStatus: inert({ running: false, url: null, command: null, attached: false, reason: null, message: null }),
  stopDevServer: inert(false),

  // Subscriptions that never fire: nothing in this copy produces events.
  onRecorded: noListener,
  onScanStatus: noListener,
  onScanLifecycle: noListener,
  onScanProgress: noListener,
  onCodexThreadStarted: noListener,

  getDroppedPath: () => ""
});
