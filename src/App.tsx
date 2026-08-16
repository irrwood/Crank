import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  ArrowUpFromLine,
  AlertCircle,
  Check,
  Copy,
  ExternalLink,
  Figma,
  FolderGit2,
  Globe2,
  LayoutGrid,
  Layers3,
  Link2,
  LoaderCircle,
  MoreHorizontal,
  Monitor,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
  Smartphone,
  UploadCloud,
  X
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { fallbackProject, previewChanges, swiftUiFallbackProject, uiSyncSelfProject } from "./lib/demo";
import { VisualEditingStudio } from "./VisualEditingStudio";
import type {
  AutomaticMappingSession,
  AutomaticMappingStatus,
  CodexSyncResult,
  DiscoveredScreen,
  LivePreviewSession,
  ProjectInfo,
  ProjectKind,
  ProjectPreview,
  PullPreview,
  ReviewState,
  SemanticChange,
  SemanticIntent,
  SwiftUiDesignSession,
  SyncDirection,
  VisualEditResult
} from "./types";

const delay = (milliseconds: number) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

type FigmaLinkTarget =
  | { mode: "file" }
  | { mode: "screen"; screen: DiscoveredScreen };

type ActiveAutomaticMapping = {
  projectRoot: string;
  operation: "push" | "pull";
  session: AutomaticMappingSession;
  status: AutomaticMappingStatus;
};

function formatLastSync(value: string | null) {
  if (!value) return "Not synced yet";
  const date = new Date(value);
  return `Today at ${new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(date)}`;
}

function SourceIcon({ kind, size = 16 }: { kind: ProjectKind; size?: number }) {
  if (kind === "web") return <Globe2 size={size} />;
  if (kind === "swiftui") return <Smartphone size={size} />;
  return <Monitor size={size} />;
}

function sourceLabel(project: ProjectInfo) {
  if (project.kind === "web") return "Website";
  if (project.kind === "swiftui") return project.root;
  return "Desktop app";
}

function App() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeProjectId, setActiveProjectId] = useState("");
  const [reviewState, setReviewState] = useState<ReviewState>("idle");
  const [selectedChanges, setSelectedChanges] = useState(() =>
    new Set(previewChanges.map((change) => change.id))
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [isDraggingProject, setIsDraggingProject] = useState(false);
  const [figmaLinkTarget, setFigmaLinkTarget] = useState<FigmaLinkTarget | null>(null);
  const [automaticMapping, setAutomaticMapping] = useState<ActiveAutomaticMapping | null>(null);
  const [pullPreview, setPullPreview] = useState<PullPreview | null>(null);
  const [codexSyncResult, setCodexSyncResult] = useState<CodexSyncResult | null>(null);
  const [designBuildRunning, setDesignBuildRunning] = useState(false);
  const [codexSyncRunning, setCodexSyncRunning] = useState(false);
  const [codexThreadOpening, setCodexThreadOpening] = useState(false);
  const [projectRefreshing, setProjectRefreshing] = useState(false);
  const [swiftSessionVersion, setSwiftSessionVersion] = useState(0);
  const [projectPreviews, setProjectPreviews] = useState<Record<string, ProjectPreview[]>>({});
  const [previewStates, setPreviewStates] = useState<Record<string, "loading" | "ready" | "unavailable">>({});
  const [liveScreen, setLiveScreen] = useState<{ root: string; screen: DiscoveredScreen } | null>(null);
  const previewRequests = useRef(new Set<string>());
  const previewRequestVersions = useRef<Record<string, number>>({});

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const previewParams = new URLSearchParams(window.location.search);
      const showSelfCapture = previewParams.has("ui-sync-capture");
      const captureProjectId = previewParams.get("capture-project-id");
      const showSwiftUiPreview = import.meta.env.DEV && previewParams.has("swiftui-preview");
      const showAutomaticMappingPreview = showSwiftUiPreview && previewParams.has("automatic-mapping-preview");
      const swiftPreviewProject = showAutomaticMappingPreview
        ? { ...swiftUiFallbackProject, figmaFileName: "Sample Design", fileKey: "preview-file" }
        : swiftUiFallbackProject;
      const loaded = showSelfCapture
        ? window.uiSync ? await window.uiSync.listProjects() : [uiSyncSelfProject]
        : showSwiftUiPreview
        ? [swiftPreviewProject]
        : window.uiSync
          ? await window.uiSync.listProjects()
          : [fallbackProject];
      if (!mounted) return;
      const nextProjects = loaded.length > 0 ? loaded : [fallbackProject];
      setProjects(nextProjects);
      setActiveProjectId(nextProjects.find((project) => project.id === captureProjectId)?.id ?? nextProjects[0].id);
      if (showAutomaticMappingPreview) {
        const previewState = previewParams.get("mapping-state") ?? "pairing";
        const requiresPairing = previewState === "pairing";
        const status: AutomaticMappingStatus = previewState === "running"
          ? { state: "running" }
          : previewState === "complete"
            ? { state: "complete", renderedCount: 6, createdCount: 1, reusedCount: 5 }
            : previewState === "error"
              ? { state: "error", message: "Figma is not reachable. Open the UI Sync Bridge and try again." }
              : { state: "waiting" };
        setAutomaticMapping({
          projectRoot: swiftPreviewProject.root,
          operation: "push",
          session: { pairingCode: "482731", expiresAt: new Date(Date.now() + 600000).toISOString(), screenCount: 6, requiresPairing },
          status
        });
      }
    };
    void load();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!window.uiSync) return;
    return window.uiSync.onCodexThreadStarted(({ root, threadId }) => {
      setProjects((current) => current.map((project) => project.root === root ? { ...project, codexThreadId: threadId } : project));
      setNotice("Codex conversation is live — open it to watch or continue the work");
    });
  }, []);

  useEffect(() => {
    const previewParams = new URLSearchParams(window.location.search);
    if (!previewParams.has("ui-sync-capture") || projects.length === 0) return;
    document.documentElement.dataset.captureReady = "false";
    let cancelled = false;
    void document.fonts.ready.then(() => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        if (!cancelled) document.documentElement.dataset.captureReady = "true";
      }));
    });
    return () => { cancelled = true; };
  }, [projects]);

  const activeProject = useMemo(
    () =>
      projects.find((project) => project.id === activeProjectId) ??
      projects[0] ??
      fallbackProject,
    [activeProjectId, projects]
  );

  const loadProjectPreviews = async (projectRoot: string) => {
    if (!window.uiSync) return;
    const requestVersion = (previewRequestVersions.current[projectRoot] ?? 0) + 1;
    previewRequestVersions.current[projectRoot] = requestVersion;
    previewRequests.current.add(projectRoot);
    setPreviewStates((current) => ({ ...current, [projectRoot]: "loading" }));
    try {
      const previews = await window.uiSync.getProjectPreviews(projectRoot);
      if (previewRequestVersions.current[projectRoot] !== requestVersion) return;
      setProjectPreviews((current) => ({ ...current, [projectRoot]: previews }));
      setPreviewStates((current) => ({ ...current, [projectRoot]: previews.length > 0 ? "ready" : "unavailable" }));
    } catch {
      if (previewRequestVersions.current[projectRoot] !== requestVersion) return;
      setPreviewStates((current) => ({ ...current, [projectRoot]: "unavailable" }));
    }
  };

  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("ui-sync-capture")) return;
    if (!window.uiSync || activeProject.kind === "swiftui" || previewRequests.current.has(activeProject.root)) return;
    void loadProjectPreviews(activeProject.root);
  }, [activeProject.kind, activeProject.root]);

  const refreshActiveProject = async () => {
    if (!window.uiSync || projectRefreshing) {
      if (!window.uiSync) setNotice("Project refresh is available in the desktop app.");
      return;
    }
    const projectRoot = activeProject.root;
    setProjectRefreshing(true);
    setNotice("Refreshing discovered screens…");
    try {
      const refreshed = await window.uiSync.refreshProject(projectRoot);
      setProjects((current) => current.map((project) => project.root === projectRoot ? refreshed : project));
      setReviewState("idle");
      setPullPreview(null);
      setCodexSyncResult(null);
      if (refreshed.kind === "swiftui") {
        setSwiftSessionVersion((current) => current + 1);
      } else {
        previewRequests.current.delete(projectRoot);
        await loadProjectPreviews(projectRoot);
      }
      const screenCount = refreshed.screens.filter((screen) => screen.sourceType !== "component").length;
      setNotice(`${screenCount} ${screenCount === 1 ? "screen" : "screens"} refreshed`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Project screens could not be refreshed");
    } finally {
      setProjectRefreshing(false);
    }
  };

  const addProject = async (kind: ProjectKind) => {
    if (!window.uiSync) {
      setNotice("Folder selection is available in the desktop app.");
      return;
    }
    const discovered = await window.uiSync.addProject(kind);
    if (discovered.length === 0) return;
    connectDiscoveredProjects(discovered);
  };

  const connectDiscoveredProjects = (discovered: ProjectInfo[]) => {
    if (discovered.length === 0) return;
    setAutomaticMapping(null);
    setProjects((current) => {
      const nextById = new Map(current.map((project) => [project.id, project]));
      for (const project of discovered) nextById.set(project.id, project);
      return [...nextById.values()];
    });
    setActiveProjectId(discovered[0].id);
    setReviewState("idle");
    setNotice(discovered.length === 1
      ? `${discovered[0].name} connected`
      : `${discovered.length} projects connected: ${discovered.map((project) => project.name).join(", ")}`
    );
  };

  const handleProjectDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setIsDraggingProject(false);
    if (!window.uiSync) return;
    const roots = Array.from(event.dataTransfer.files)
      .map((file) => window.uiSync?.getDroppedPath(file) ?? "")
      .filter(Boolean);
    if (roots.length === 0) return;
    const discovered = await window.uiSync.inspectDroppedProjects(roots);
    if (discovered.length === 0) {
      setNotice("No supported UI project was found in that folder");
      return;
    }
    connectDiscoveredProjects(discovered);
  };

  const completePreviewSync = async () => {
    if (selectedChanges.size === 0) return;
    setReviewState("syncing");
    await delay(1100);
    setReviewState("complete");
    setNotice("Preview complete — no project or Figma data was changed");
  };

  const applyPull = async () => {
    if (!window.uiSync || !pullPreview) return;
    setReviewState("syncing");
    setCodexSyncResult(null);
    try {
      const direct = await window.uiSync.applyPull(activeProject.root);
      if (direct.needsCodex) {
        const result = await window.uiSync.syncFromFigmaWithCodex(activeProject.root);
        setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
        setCodexSyncResult(result);
        setNotice(
          `${direct.changedFiles.length} files updated directly · Codex ${result.changedFiles.length > 0 ? `updated ${result.changedFiles.length} more` : "verified the remaining visual changes"}`
        );
      } else {
        const refreshed = await window.uiSync.refreshProject(activeProject.root);
        setProjects((current) => current.map((project) => project.id === refreshed.id ? refreshed : project));
        setNotice(`${direct.changedFiles.length} local files updated from deterministic Figma properties`);
      }
      setReviewState("complete");
    } catch (caught) {
      setReviewState("review");
      setNotice(caught instanceof Error ? caught.message : "Codex could not synchronize the app from Figma");
    }
  };

  const toggleChange = (id: string) => {
    setSelectedChanges((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openFigma = (project: ProjectInfo = activeProject) => {
    if (!project.fileKey) return;
    if (window.uiSync) {
      void window.uiSync.openFigma(project.fileKey, project.frameNodeId);
      return;
    }
    const figmaUrl = project.frameNodeId
      ? `https://www.figma.com/design/${project.fileKey}?node-id=${project.frameNodeId.replace(":", "-")}`
      : `https://www.figma.com/design/${project.fileKey}`;
    window.open(
      figmaUrl,
      "_blank",
      "noopener,noreferrer"
    );
  };

  const openFigmaNode = (nodeId: string | null) => {
    if (!activeProject.fileKey || !window.uiSync) return;
    void window.uiSync.openFigma(activeProject.fileKey, nodeId);
  };

  const saveFigmaLink = async (value: string) => {
    if (!window.uiSync || !figmaLinkTarget) throw new Error("Desktop bridge is not available");
    const nextProject = figmaLinkTarget.mode === "file"
      ? await window.uiSync.connectFigmaProject(activeProject.root, value)
      : await window.uiSync.mapProjectScreen(activeProject.root, figmaLinkTarget.screen.id, value);
    setProjects((current) => current.map((project) => project.id === nextProject.id ? nextProject : project));
    setActiveProjectId(nextProject.id);
    setNotice(
      figmaLinkTarget.mode === "file"
        ? `${nextProject.figmaFileName} connected`
        : `${figmaLinkTarget.screen.name} mapped to Figma`
    );
    if (figmaLinkTarget.mode === "file" && nextProject.kind !== "swiftui") {
      try {
        const session = await window.uiSync.beginAutomaticMapping(nextProject.root);
        setAutomaticMapping({ projectRoot: nextProject.root, operation: "push", session, status: { state: "waiting" } });
      } catch (caught) {
        setNotice(caught instanceof Error ? caught.message : "Figma connected; automatic mapping is not available yet");
      }
    }
  };

  const beginAutomaticMapping = async (projectRoot = activeProject.root, targetId?: string) => {
    if (!window.uiSync) {
      setNotice("Automatic mapping is available in the desktop app.");
      return;
    }
    try {
      const session = await window.uiSync.beginAutomaticMapping(projectRoot, targetId);
      setAutomaticMapping({ projectRoot, operation: "push", session, status: { state: "waiting" } });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Automatic mapping could not start");
    }
  };

  const beginPull = async (projectRoot = activeProject.root) => {
    if (!window.uiSync) {
      setNotice("To local is available in the desktop app.");
      return;
    }
    try {
      const session = await window.uiSync.beginPull(projectRoot);
      setAutomaticMapping({ projectRoot, operation: "pull", session, status: { state: "waiting" } });
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Figma changes could not be read");
    }
  };

  const runDesignBuild = async () => {
    if (!window.uiSync || activeProject.kind !== "swiftui") return;
    setDesignBuildRunning(true);
    setNotice("Launching the iOS app and exporting its PDF pages…");
    try {
      const result = await window.uiSync.runSwiftUiDesignBuild(activeProject.root);
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      setNotice(result.vectorReady
        ? `PDF rendered on ${result.deviceName} and is ready for Figma`
        : `PDF export needs attention: ${result.vectorMessage ?? "no PDF was produced"}`);
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "PDF export could not capture this iOS app");
    } finally {
      setDesignBuildRunning(false);
    }
  };

  const syncFromFigmaWithCodex = async () => {
    if (!window.uiSync || !activeProject.fileKey) return;
    setCodexSyncRunning(true);
    setNotice("Codex is reading the mapped Figma frames through MCP…");
    try {
      const result = await window.uiSync.syncFromFigmaWithCodex(activeProject.root);
      setProjects((current) => current.map((project) => project.id === result.project.id ? result.project : project));
      setCodexSyncResult(result);
      setNotice(
        result.changedFiles.length > 0
          ? `Codex updated ${result.changedFiles.length} files${result.validation[0] ? ` · ${result.validation[0]}` : ""}`
          : "Codex inspected the mapped Figma frames and found no source edits were needed"
      );
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Codex could not sync the app from Figma");
    } finally {
      setCodexSyncRunning(false);
    }
  };

  const openCodexConversation = async () => {
    if (!window.uiSync || codexThreadOpening) return;
    setCodexThreadOpening(true);
    setNotice(activeProject.codexThreadId ? "Opening the linked Codex conversation…" : "Creating a Codex conversation in this project folder…");
    try {
      const result = await window.uiSync.openCodexConversation(activeProject.root);
      setProjects((current) => current.map((item) => item.id === result.project.id ? result.project : item));
      setNotice(result.needsSend
        ? "Codex opened in this Project — send the prefilled message once to finish linking"
        : "Opened this project's persistent Codex conversation");
    } catch (caught) {
      setNotice(caught instanceof Error ? caught.message : "Codex conversation could not be opened");
    } finally {
      setCodexThreadOpening(false);
    }
  };

  const applyVisualEdit = async (session: SwiftUiDesignSession, operations: SemanticIntent[]): Promise<VisualEditResult> => {
    const applySwiftUiVisualEdits = window.uiSync?.applySwiftUiVisualEdits;
    if (applySwiftUiVisualEdits) {
      setNotice("Codex is applying the confirmed intents, then UI Sync will rebuild and compare runtime snapshots…");
      return await applySwiftUiVisualEdits(activeProject.root, {
        version: 1,
        projectRoot: activeProject.root,
        pageName: session.nodes.find((node) => node.id === operations[0]?.node)?.pageName ?? "Current screen",
        createdAt: new Date().toISOString(),
        nodes: session.nodes,
        operations
      });
    }
    await delay(1100);
    return {
      state: "awaiting-review",
      branchName: "ui-sync/design-edit-preview",
      iterations: 1,
      converged: true,
      changedFiles: ["TripDetailScreen.swift"],
      checks: operations.map((operation) => ({
        operationId: operation.id,
        node: operation.node,
        property: operation.operation === "resize" ? (operation.axis === "horizontal" ? "width" : "height") : operation.operation === "set_property" ? operation.property : operation.operation,
        desired: operation.operation === "resize" ? operation.to : operation.operation === "set_property" ? operation.value : "visual review",
        actual: operation.operation === "resize" ? operation.to + 1 : operation.operation === "set_property" ? operation.value : "visual review",
        delta: operation.operation === "resize" ? 1 : null,
        passed: true
      })),
      summary: "Preview edit converged on both canvas sizes."
    };
  };

  const acceptVisualEdit = async () => {
    if (window.uiSync?.resolveSwiftUiVisualEdit) await window.uiSync.resolveSwiftUiVisualEdit(activeProject.root, "accept");
    setNotice("Visual edit accepted");
  };

  const rejectVisualEdit = async () => {
    if (window.uiSync?.resolveSwiftUiVisualEdit) await window.uiSync.resolveSwiftUiVisualEdit(activeProject.root, "reject");
    setNotice("Visual edit rejected and the checkpoint was restored");
  };

  useEffect(() => {
    if (!automaticMapping || !window.uiSync) return;
    let cancelled = false;
    let timer: number | null = null;
    const check = async () => {
      try {
        const status = await window.uiSync?.getAutomaticMappingStatus(
          automaticMapping.projectRoot,
          automaticMapping.session.pairingCode
        );
        if (!status || cancelled) return;
        setAutomaticMapping((current) => current ? { ...current, status } : current);
        if (status.project) {
          setProjects((current) => current.map((project) => project.id === status.project?.id ? status.project : project));
          setNotice(`${status.renderedCount ?? 0} screens rendered · ${status.reusedCount ?? 0} mappings restored`);
        }
        if (status.state === "complete" && status.pullPreview) {
          setPullPreview(status.pullPreview);
          setReviewState("review");
          setAutomaticMapping(null);
          setNotice(`${status.pullPreview.changes.length} Figma changes ready · ${status.pullPreview.conflicts.length} conflicts`);
          return;
        }
        if (["complete", "error", "expired"].includes(status.state)) return;
      } catch (caught) {
        if (!cancelled) {
          setAutomaticMapping((current) => current ? {
            ...current,
            status: { state: "error", message: caught instanceof Error ? caught.message : "Could not read sync status" }
          } : current);
        }
        return;
      }
      timer = window.setTimeout(() => void check(), 1000);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [automaticMapping?.projectRoot, automaticMapping?.session.pairingCode]);

  return (
    <div
      className={`app-frame ${isDraggingProject ? "is-dragging-project" : ""}`}
      onDragEnter={(event) => {
        if (event.dataTransfer.types.includes("Files")) setIsDraggingProject(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setIsDraggingProject(false);
      }}
      onDrop={(event) => void handleProjectDrop(event)}
    >
      <Sidebar
        projects={projects}
        activeProjectId={activeProject.id}
        onProjectChange={(id) => {
          setAutomaticMapping(null);
          setActiveProjectId(id);
          setReviewState("idle");
          setPullPreview(null);
          setCodexSyncResult(null);
        }}
        onAddProject={addProject}
      />

      <main className="workspace">
        <ProjectHeader
          project={activeProject}
          onOpenFigma={() => openFigma(activeProject)}
          onChooseFigma={() => setFigmaLinkTarget({ mode: "file" })}
          onAutoMap={() => void beginAutomaticMapping(activeProject.root)}
          onPull={() => void syncFromFigmaWithCodex()}
          codexSyncRunning={codexSyncRunning}
          codexThreadOpening={codexThreadOpening}
          onOpenCodex={openCodexConversation}
          onRefresh={() => activeProject.kind === "swiftui" ? void runDesignBuild() : void refreshActiveProject()}
          projectRefreshing={projectRefreshing}
          onRunDesignBuild={() => void runDesignBuild()}
          designBuildRunning={designBuildRunning}
        />

        {activeProject.kind === "swiftui" ? (
          <VisualEditingStudio
            project={activeProject}
            refreshVersion={swiftSessionVersion}
            captureRunning={designBuildRunning}
            onRunCapture={async () => { await runDesignBuild(); }}
            onSyncToFigma={async (pdfPageId) => { await beginAutomaticMapping(activeProject.root, pdfPageId); }}
          />
        ) : pullPreview && reviewState !== "idle" ? (
          <SyncWorkspace
            project={activeProject}
            direction="to-local"
            reviewState={reviewState}
            selectedChanges={selectedChanges}
            onCheck={() => void beginPull(activeProject.root)}
            onToggleChange={toggleChange}
            onCompleteSync={completePreviewSync}
            onReset={() => {
              setReviewState("idle");
              setPullPreview(null);
              setCodexSyncResult(null);
            }}
            pullPreview={pullPreview}
            codexSyncResult={codexSyncResult}
            onApplyPull={() => void applyPull()}
          />
        ) : liveScreen && liveScreen.root === activeProject.root ? (
          <LivePreviewView
            project={activeProject}
            screen={liveScreen.screen}
            onBack={() => setLiveScreen(null)}
            onOpenFigmaNode={openFigmaNode}
          />
        ) : (
          <ProjectMappingView
            project={activeProject}
            onOpenFigmaNode={openFigmaNode}
            onImportScreen={(screenId) => void beginAutomaticMapping(activeProject.root, screenId)}
            onOpenLivePreview={(screen) => setLiveScreen({ root: activeProject.root, screen })}
            previews={projectPreviews[activeProject.root] ?? []}
            previewState={previewStates[activeProject.root] ?? null}
          />
        )}
      </main>

      {notice && <Toast message={notice} onDismiss={() => setNotice(null)} />}
      {figmaLinkTarget && (
        <FigmaLinkDialog
          project={activeProject}
          target={figmaLinkTarget}
          onClose={() => setFigmaLinkTarget(null)}
          onSave={saveFigmaLink}
        />
      )}
      {automaticMapping && (
        <AutomaticMappingDialog
          project={projects.find((project) => project.root === automaticMapping.projectRoot) ?? activeProject}
          mapping={automaticMapping}
          onClose={() => setAutomaticMapping(null)}
          onOpenFigma={() => openFigma(projects.find((project) => project.root === automaticMapping.projectRoot) ?? activeProject)}
          onShowPlugin={() => void window.uiSync?.showFigmaPlugin()}
          onCopyCode={() => void window.uiSync?.copyText(automaticMapping.session.pairingCode)}
          onRestart={() => void (automaticMapping.operation === "pull" ? beginPull(automaticMapping.projectRoot) : beginAutomaticMapping(automaticMapping.projectRoot))}
        />
      )}
      {isDraggingProject && (
        <div className="drop-overlay">
          <div><UploadCloud size={24} /><strong>Drop project folder</strong><span>UI Sync will inspect it locally</span></div>
        </div>
      )}
    </div>
  );
}

function Sidebar({
  projects,
  activeProjectId,
  onProjectChange,
  onAddProject
}: {
  projects: ProjectInfo[];
  activeProjectId: string;
  onProjectChange: (id: string) => void;
  onAddProject: (kind: ProjectKind) => Promise<void>;
}) {
  const [addMenuOpen, setAddMenuOpen] = useState(false);

  return (
    <aside className="sidebar">
      <div className="sidebar-drag drag-region" />
      <div className="brand-row">
        <div className="brand-mark" aria-hidden="true">
          <img src="./app-icon.png" alt="" />
        </div>
        <span>UI Sync</span>
        <button className="icon-button no-drag ml-auto" aria-label="App menu" title="App menu">
          <MoreHorizontal size={17} />
        </button>
      </div>

      <div className="sidebar-section-header">
        <span>Projects</span>
        <div className="project-add-wrap">
          <button
            className={`icon-button ${addMenuOpen ? "is-open" : ""}`}
            aria-label="Add project"
            aria-expanded={addMenuOpen}
            title="Add project"
            onClick={() => setAddMenuOpen((current) => !current)}
          >
            <Plus size={15} />
          </button>
          {addMenuOpen && (
            <div className="add-project-menu">
              <div className="add-menu-heading">Connect a project</div>
              <button
                onClick={() => {
                  setAddMenuOpen(false);
                  void onAddProject("web");
                }}
              >
                <span className="add-menu-icon"><Globe2 size={16} /></span>
                <span><strong>Web projects</strong><small>Find every runnable app in a folder</small></span>
              </button>
              <button
                onClick={() => {
                  setAddMenuOpen(false);
                  void onAddProject("swiftui");
                }}
              >
                <span className="add-menu-icon swiftui-icon"><Smartphone size={16} /></span>
                <span><strong>iOS apps</strong><small>SwiftUI and UIKit Xcode projects</small></span>
              </button>
              <button
                onClick={() => {
                  setAddMenuOpen(false);
                  void onAddProject("desktop");
                }}
              >
                <span className="add-menu-icon"><Monitor size={16} /></span>
                <span><strong>Electron projects</strong><small>Find every Electron app in a folder</small></span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="project-list">
        {projects.map((project) => (
          <button
            className={`project-item ${project.id === activeProjectId ? "is-active" : ""}`}
            key={project.id}
            onClick={() => onProjectChange(project.id)}
          >
            <span className={`project-icon is-${project.kind}`}>
              <SourceIcon kind={project.kind} size={14} />
            </span>
            <span className="project-copy">
              <strong>{project.name}</strong>
              <small>{project.figmaFileName ?? (project.kind === "swiftui" ? "Ready to map" : "Not connected")}</small>
            </span>
            <span className={`status-dot ${project.connectionStatus === "setup" ? "is-setup" : ""}`} aria-label={project.connectionStatus === "setup" ? "Setup required" : "Connected"} />
          </button>
        ))}
      </div>

      <div className="sidebar-footer">
        <div className="bridge-status">
          <span className="bridge-icon"><Link2 size={14} /></span>
          <span>
            <strong>Local bridge</strong>
            <small>Ready</small>
          </span>
        </div>
        <button className="icon-button" aria-label="Settings" title="Settings">
          <Settings size={16} />
        </button>
      </div>
    </aside>
  );
}

function ProjectHeader({
  project,
  onOpenFigma,
  onChooseFigma,
  onAutoMap,
  onPull,
  codexSyncRunning,
  codexThreadOpening,
  onOpenCodex,
  onRefresh,
  projectRefreshing,
  onRunDesignBuild,
  designBuildRunning
}: {
  project: ProjectInfo;
  onOpenFigma: () => void;
  onChooseFigma: () => void;
  onAutoMap: () => void;
  onPull: () => void;
  codexSyncRunning: boolean;
  codexThreadOpening: boolean;
  onOpenCodex: () => void;
  onRefresh: () => void;
  projectRefreshing: boolean;
  onRunDesignBuild: () => void;
  designBuildRunning: boolean;
}) {
  return (
    <header className="project-header">
      <div className="project-header-copy">
        <h1>{project.name}</h1>
        <div className="connection-line">
          {designBuildRunning && project.kind === "swiftui"
            ? <LoaderCircle className="spin" size={14} />
            : <SourceIcon kind={project.kind} size={14} />}
          {project.kind === "swiftui" ? (
            <button
              type="button"
              onClick={onRunDesignBuild}
              disabled={designBuildRunning}
              title={project.runtimeCapture?.state === "captured" ? "Export all iOS pages to PDF again" : "Export all iOS pages to PDF"}
            >
              {sourceLabel(project)}
            </button>
          ) : (
            <span>{project.name}</span>
          )}
          {project.fileKey ? (
            <>
              <ArrowRight size={13} />
              <Figma size={13} />
              <button onClick={onOpenFigma}>{project.figmaFileName}</button>
            </>
          ) : (
            <span className="awaiting-link">Figma not linked</span>
          )}
        </div>
      </div>
      <div className="project-header-actions">
        <button
          className="secondary-button project-refresh-button"
          onClick={onRefresh}
          disabled={project.kind === "swiftui" ? designBuildRunning : projectRefreshing}
          aria-label={project.kind === "swiftui" ? "Re-export iOS PDF previews" : "Refresh discovered screens"}
          title={project.kind === "swiftui" ? "Re-export iOS PDF previews" : "Refresh discovered screens"}
        >
          {(project.kind === "swiftui" ? designBuildRunning : projectRefreshing)
            ? <LoaderCircle className="spin" size={14} />
            : <RefreshCw size={14} />}
        </button>
        <button className="secondary-button" onClick={onChooseFigma}>
          <Figma size={14} /> {project.fileKey ? "Change file" : "Choose Figma file"}
        </button>
        <button className="secondary-button" onClick={onOpenCodex} disabled={codexThreadOpening}>
          {codexThreadOpening ? <LoaderCircle className="spin" size={14} /> : <ExternalLink size={14} />}
          {codexThreadOpening ? "Opening Codex…" : "Open in Codex"}
        </button>
        {project.fileKey && (
          <>
            <button className="secondary-button" onClick={onPull} disabled={codexSyncRunning}>
              {codexSyncRunning ? <LoaderCircle className="spin" size={14} /> : <ArrowDownToLine size={14} />}
              {codexSyncRunning ? "Codex is syncing…" : "Sync from Figma"}
            </button>
            {project.kind !== "swiftui" && <button className="primary-button" onClick={onAutoMap}>
              <ArrowUpFromLine size={14} /> Sync All to Figma
            </button>}
          </>
        )}
      </div>
    </header>
  );
}

function SyncWorkspace({
  project,
  direction,
  reviewState,
  selectedChanges,
  onCheck,
  onToggleChange,
  onCompleteSync,
  onReset,
  pullPreview,
  codexSyncResult,
  onApplyPull
}: {
  project: ProjectInfo;
  direction: SyncDirection;
  reviewState: ReviewState;
  selectedChanges: Set<string>;
  onCheck: () => void;
  onToggleChange: (id: string) => void;
  onCompleteSync: () => void;
  onReset: () => void;
  pullPreview: PullPreview | null;
  codexSyncResult: CodexSyncResult | null;
  onApplyPull: () => void;
}) {
  if (reviewState === "idle" || reviewState === "checking") {
    return (
      <section className="empty-workspace">
        <div className={`sync-orbit ${reviewState === "checking" ? "is-checking" : ""}`}>
          <span className="orbit-source"><FolderGit2 size={20} /></span>
          <span className="orbit-line" />
          <span className="orbit-target"><Figma size={19} /></span>
        </div>
        <h2>{reviewState === "checking" ? "Comparing both sides…" : direction === "to-local" ? "Ready to read Figma" : "No supported differences detected"}</h2>
        <p>
          {reviewState === "checking"
            ? "Reading the linked screen and translating visual properties."
            : direction === "to-local"
              ? "UI Sync will read only remembered Figma layers, then show a three-way diff before changing files."
              : `${project.name} and ${project.figmaFileName} match revision ${project.revision}.`}
        </p>
        <button className="primary-button" onClick={onCheck} disabled={reviewState === "checking"}>
          {reviewState === "checking" ? (
            <LoaderCircle className="spin" size={16} />
          ) : (
            <RefreshCw size={16} />
          )}
          {reviewState === "checking" ? "Checking" : direction === "to-local" ? "Check Figma changes" : "Preview a change set"}
        </button>
        <span className="last-check">Last synced {formatLastSync(project.lastSyncedAt)}</span>
      </section>
    );
  }

  if (reviewState === "complete") {
    const codexChangedFiles = codexSyncResult?.changedFiles.length ?? 0;
    return (
      <section className="empty-workspace complete-state">
        <div className="success-mark"><Check size={24} strokeWidth={2.4} /></div>
        <h2>{direction === "to-local" ? "App updated" : "Preview complete"}</h2>
        <p>{direction === "to-local"
          ? codexSyncResult
            ? codexChangedFiles > 0
              ? `${codexChangedFiles} source files needed Codex reasoning. ${codexSyncResult.validation[0] ?? "The repository validation completed."}`
              : "Direct properties were applied and Codex verified the remaining visual design."
            : "High-confidence Figma properties were applied directly and validated locally."
          : "The selected visual changes passed review. Nothing was written in preview mode."}</p>
        <button className="secondary-button" onClick={onReset}>Back to sync status</button>
      </section>
    );
  }

  if (direction === "to-local" && pullPreview) {
    const totalChanges = pullPreview.changes.length + pullPreview.conflicts.length;
    const automaticChanges = pullPreview.changes.filter((change) => change.route === "automatic").length;
    const codexChanges = totalChanges - automaticChanges;
    return (
      <section className="review-workspace pull-review-workspace">
        <div className="review-main">
          <div className="review-heading">
            <div>
              <div className="preview-label"><ArrowDownToLine size={13} /> Figma → local</div>
              <h2>Review Figma changes</h2>
              <p>{automaticChanges} direct changes · {codexChanges} need Codex reasoning</p>
            </div>
            <button className="refresh-button" onClick={onReset} disabled={reviewState === "syncing"}><RefreshCw size={15} /> Cancel</button>
          </div>
          <div className="change-list">
            <div className="change-list-header"><span>Mapped property</span><span>Code → Figma</span></div>
            {pullPreview.changes.map((change) => (
              <div className="change-row is-selected" key={change.id}>
                <span className="check-control"><Check size={13} strokeWidth={2.8} /></span>
                <span className="change-glyph size-glyph"><i /></span>
                <span className="change-copy"><strong>{change.area}</strong><small>{change.property}</small></span>
                <span className="change-route">{change.route === "automatic" ? "Direct" : "Codex"}</span>
                <span className="value-change"><span>{formatPullValue(change.before)}</span><ArrowRight size={14} /><strong>{formatPullValue(change.after)}</strong></span>
              </div>
            ))}
            {pullPreview.conflicts.map((conflict) => (
              <div className="change-row pull-conflict-row" key={conflict.id}>
                <span className="check-control"><AlertCircle size={13} /></span>
                <span className="change-copy"><strong>Conflict · {conflict.property}</strong><small>Base {formatPullValue(conflict.base)} · Code {formatPullValue(conflict.code)} · Figma {formatPullValue(conflict.figma)}</small></span>
              </div>
            ))}
            {pullPreview.rejected.map((rejected) => (
              <div className="change-row pull-conflict-row" key={rejected.id}>
                <span className="check-control"><AlertCircle size={13} /></span>
                <span className="change-copy"><strong>Needs source mapping</strong><small>{rejected.reason}</small></span>
              </div>
            ))}
            {totalChanges === 0 && <div className="pull-no-changes"><Check size={16} /> No machine-readable property differences detected.</div>}
          </div>
        </div>
        <div className="review-footer">
          <div><strong>{`${totalChanges} design changes ready`}</strong><span>{automaticChanges > 0 ? `${automaticChanges} apply directly` : "No deterministic edits"}{codexChanges > 0 ? ` · ${codexChanges} go to Codex` : ""}</span></div>
          <button className="primary-button sync-button" onClick={onApplyPull} disabled={totalChanges === 0 || reviewState === "syncing"}>
            {reviewState === "syncing" ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}
            {reviewState === "syncing" ? "Updating the app" : codexChanges > 0 ? "Apply & finish with Codex" : "Apply directly"}
          </button>
        </div>
      </section>
    );
  }

  const isSyncing = reviewState === "syncing";
  return (
    <section className="review-workspace">
      <div className="review-main">
        <div className="review-heading">
          <div>
            <div className="preview-label"><Sparkles size={13} /> Interactive preview</div>
            <h2>Review visual changes</h2>
            <p>{previewChanges.length} differences found · No conflicts</p>
          </div>
          <button className="refresh-button" onClick={onReset} disabled={isSyncing}>
            <RefreshCw size={15} />
            Check again
          </button>
        </div>

        <div className="change-list">
          <div className="change-list-header">
            <label>
              <input
                type="checkbox"
                checked={selectedChanges.size === previewChanges.length}
                onChange={() => {
                  const allSelected = selectedChanges.size === previewChanges.length;
                  previewChanges.forEach((change) => {
                    if (allSelected === selectedChanges.has(change.id)) onToggleChange(change.id);
                  });
                }}
              />
              <span>{selectedChanges.size} selected</span>
            </label>
            <span>{direction === "to-figma" ? "Local → Figma" : "Figma → Local"}</span>
          </div>
          {previewChanges.map((change) => (
            <ChangeRow
              key={change.id}
              change={change}
              selected={selectedChanges.has(change.id)}
              onToggle={() => onToggleChange(change.id)}
            />
          ))}
        </div>
      </div>

      <ReviewInspector project={project} selectedCount={selectedChanges.size} direction={direction} />

      <div className="review-footer">
        <div>
          <strong>{selectedChanges.size} changes ready</strong>
          <span>Preview only · reversible by design</span>
        </div>
        <button
          className="primary-button sync-button"
          onClick={onCompleteSync}
          disabled={selectedChanges.size === 0 || isSyncing}
        >
          {isSyncing ? <LoaderCircle className="spin" size={16} /> : <ArrowRight size={16} />}
          {isSyncing
            ? "Preparing preview"
            : direction === "to-figma"
              ? "Preview sync to Figma"
              : "Preview sync to local"}
        </button>
      </div>
    </section>
  );
}

function formatPullValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "number") return `${Math.round(value * 100) / 100}`;
  if (typeof value === "string") return value.length > 28 ? `${value.slice(0, 25)}…` : value;
  return JSON.stringify(value);
}

function ChangeRow({
  change,
  selected,
  onToggle
}: {
  change: SemanticChange;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <button className={`change-row ${selected ? "is-selected" : ""}`} onClick={onToggle}>
      <span className="check-control">{selected && <Check size={13} strokeWidth={2.8} />}</span>
      <ChangeGlyph kind={change.kind} before={change.before} after={change.after} />
      <span className="change-copy">
        <strong>{change.area}</strong>
        <small>{change.property}</small>
      </span>
      <span className="value-change">
        <span>{change.before}</span>
        <ArrowRight size={14} />
        <strong>{change.after}</strong>
      </span>
    </button>
  );
}

function ChangeGlyph({ kind, before, after }: Pick<SemanticChange, "kind" | "before" | "after">) {
  if (kind === "color") {
    return (
      <span className="change-glyph color-glyph">
        <i style={{ background: before }} />
        <i style={{ background: after }} />
      </span>
    );
  }
  if (kind === "shape") {
    return <span className="change-glyph shape-glyph"><i /><i /></span>;
  }
  if (kind === "spacing") {
    return <span className="change-glyph spacing-glyph"><i /><i /><i /></span>;
  }
  return <span className="change-glyph size-glyph"><i /></span>;
}

function ReviewInspector({
  project,
  selectedCount,
  direction
}: {
  project: ProjectInfo;
  selectedCount: number;
  direction: SyncDirection;
}) {
  return (
    <aside className="review-inspector">
      <div className="inspector-header">
        <span>Visual preview</span>
        <button className="icon-button" aria-label="Preview options" title="Preview options">
          <MoreHorizontal size={16} />
        </button>
      </div>
      <div className="visual-preview">
        <div className="mini-window before-window">
          <span className="mini-sidebar" />
          <span className="mini-header" />
          <span className="mini-line line-one" />
          <span className="mini-card" />
        </div>
        <div className="preview-arrow"><ArrowRight size={15} /></div>
        <div className="mini-window after-window">
          <span className="mini-sidebar" />
          <span className="mini-header" />
          <span className="mini-line line-one" />
          <span className="mini-card" />
        </div>
      </div>
      <div className="preview-captions"><span>Before</span><span>After</span></div>

      <dl className="summary-list">
        <div><dt>Direction</dt><dd>{direction === "to-figma" ? "To Figma" : "To local"}</dd></div>
        <div><dt>Selected</dt><dd>{selectedCount} of {previewChanges.length}</dd></div>
        <div><dt>Conflicts</dt><dd className="good-value">0</dd></div>
        <div><dt>Next revision</dt><dd>{project.revision + 1}</dd></div>
      </dl>

      <div className="privacy-note">
        <Check size={14} />
        <p><strong>Local-first</strong><span>Only selected visual properties are prepared.</span></p>
      </div>
    </aside>
  );
}

/**
 * Hosts the project's own dev server output. The page itself is rendered by a
 * WebContentsView in the main process, so this component only reserves the
 * space and keeps the native view aligned with it.
 */
function LivePreviewView({
  project,
  screen,
  onBack,
  onOpenFigmaNode
}: {
  project: ProjectInfo;
  screen: DiscoveredScreen;
  onBack: () => void;
  onOpenFigmaNode: (nodeId: string | null) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [status, setStatus] = useState<"starting" | "ready" | "error">("starting");
  const [session, setSession] = useState<LivePreviewSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const routePath = screen.capturePath ?? "/";

  useEffect(() => {
    const element = frameRef.current;
    const bridge = window.uiSync;
    if (!element || !bridge) {
      setStatus("error");
      setError("Live preview needs the UI Sync desktop app.");
      return;
    }

    const measure = () => {
      const rect = element.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    };

    let cancelled = false;
    setStatus("starting");
    setError(null);
    setSession(null);
    void (async () => {
      try {
        const started = await bridge.startLivePreview(project.root, routePath, measure());
        if (cancelled) {
          void bridge.stopLivePreview();
          return;
        }
        setSession(started);
        setStatus("ready");
      } catch (caught) {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : "The live preview could not start.");
        setStatus("error");
      }
    })();

    const syncBounds = () => { void bridge.setLivePreviewBounds(measure()); };
    const observer = new ResizeObserver(syncBounds);
    observer.observe(element);
    window.addEventListener("resize", syncBounds);
    window.addEventListener("scroll", syncBounds, true);

    return () => {
      cancelled = true;
      observer.disconnect();
      window.removeEventListener("resize", syncBounds);
      window.removeEventListener("scroll", syncBounds, true);
      void bridge.stopLivePreview();
    };
  }, [project.root, routePath]);

  return (
    <section className="live-preview">
      <header className="live-preview-bar">
        <button type="button" className="live-preview-back" onClick={onBack}>
          <ArrowLeft size={14} />
          Overview
        </button>
        <div className="live-preview-identity">
          <strong>{screen.name}</strong>
          <code>{routePath}</code>
        </div>
        <div className="live-preview-actions">
          {session && (
            <span className="live-preview-source" title={`${session.command} · ${session.origin}`}>
              {session.attached ? "Attached to" : "Started"} {session.origin}
            </span>
          )}
          <button
            type="button"
            onClick={() => void window.uiSync?.reloadLivePreview()}
            disabled={status !== "ready"}
            title="Reload the page"
          >
            <RefreshCw size={14} />
          </button>
          {screen.figmaNodeId && (
            <button
              type="button"
              className="live-preview-figma"
              onClick={() => onOpenFigmaNode(screen.figmaNodeId ?? null)}
              title={screen.figmaFrameName ?? "Open the linked Figma frame"}
            >
              <Figma size={13} />
              Figma
              <ExternalLink size={11} />
            </button>
          )}
        </div>
      </header>

      <div className="live-preview-frame" ref={frameRef}>
        {status !== "ready" && (
          <div className="live-preview-status">
            {status === "starting" ? (
              <>
                <LoaderCircle className="spin" size={16} />
                <strong>Starting the dev server…</strong>
                <span>UI Sync reuses this project's own dev server, so the first start can take a moment.</span>
              </>
            ) : (
              <>
                <AlertCircle size={16} />
                <strong>Live preview is not available</strong>
                <span>{error}</span>
              </>
            )}
          </div>
        )}
      </div>

      {session && session.blockedHosts.length > 0 && (
        <footer className="live-preview-blocked">
          <AlertCircle size={12} />
          <span>
            Blocked {session.blockedHosts.length} external {session.blockedHosts.length === 1 ? "host" : "hosts"}:{" "}
            {session.blockedHosts.slice(0, 4).join(", ")}
            {session.blockedHosts.length > 4 ? "…" : ""}
          </span>
        </footer>
      )}
    </section>
  );
}

function ProjectMappingView({
  project,
  onOpenFigmaNode,
  onImportScreen,
  onOpenLivePreview,
  previews,
  previewState
}: {
  project: ProjectInfo;
  onOpenFigmaNode: (nodeId: string | null) => void;
  onImportScreen: (screenId: string) => void;
  onOpenLivePreview: (screen: DiscoveredScreen) => void;
  previews: ProjectPreview[];
  previewState: "loading" | "ready" | "unavailable" | null;
}) {
  const components = project.screens.filter((screen) => screen.sourceType === "component");
  const projectScreens = project.screens.filter((screen) => screen.sourceType !== "component");
  const discoveredScreens: DiscoveredScreen[] = projectScreens.length > 0
    ? projectScreens
    : [{
        id: `${project.id}-project`,
        name: project.frameName ?? project.name,
        sourceType: "screen",
        patterns: [project.analysisEngine],
        sfSymbolCount: 0,
        semanticColorCount: 0,
        hasCustomFont: false,
        figmaNodeId: project.frameNodeId,
        figmaFrameName: project.frameName
      }];
  const screens = discoveredScreens.map((screen) => ({
    ...screen,
    figmaNodeId: screen.figmaNodeId ?? (discoveredScreens.length === 1 ? project.frameNodeId : null),
    figmaFrameName: screen.figmaFrameName ?? (discoveredScreens.length === 1 ? project.frameName : null)
  }));
  const previewsByScreen = new Map(previews.map((preview) => [preview.screenId, preview]));
  // Live preview drives the project's own dev server, which only web and
  // Electron renderers expose; SwiftUI screens keep their capture-based flow.
  const canPreviewLive = project.kind !== "swiftui" && Boolean(window.uiSync);

  return (
    <section className="mapping-workspace">
      <div className="mapping-main">
        <div className="screen-preview-grid">
          {screens.map((screen) => (
            <article className="screen-preview-card" key={screen.id}>
              {previewsByScreen.get(screen.id) ? (
                <div
                  className="screen-preview-image"
                  style={{ aspectRatio: `${previewsByScreen.get(screen.id)?.width} / ${previewsByScreen.get(screen.id)?.height}` }}
                >
                  <img src={previewsByScreen.get(screen.id)?.screenshotDataUrl} alt={`${screen.name} rendered preview`} />
                  {canPreviewLive && (
                    <button
                      type="button"
                      className="screen-live-button"
                      onClick={() => onOpenLivePreview(screen)}
                      title={`Open ${screen.name} in a live preview`}
                    >
                      <Play size={12} />
                      Live preview
                    </button>
                  )}
                  <button
                    type="button"
                    className="screen-import-button"
                    disabled={!project.fileKey}
                    onClick={() => onImportScreen(screen.id)}
                    title={project.fileKey ? `Import ${screen.name} to Figma` : "Connect a Figma file first"}
                  >
                    <Figma size={13} />
                    Import to Figma
                  </button>
                </div>
              ) : (
                <div className="screen-preview-image is-placeholder">
                  {previewState === "loading" ? <LoaderCircle className="spin" size={14} /> : screen.sourceType === "screen" ? <LayoutGrid size={15} /> : <Layers3 size={15} />}
                  <span>{previewState === "loading" ? "Capturing rendered screen…" : "Rendered preview unavailable"}</span>
                  {canPreviewLive && previewState !== "loading" && (
                    <button
                      type="button"
                      className="screen-live-button is-inline"
                      onClick={() => onOpenLivePreview(screen)}
                      title={`Open ${screen.name} in a live preview`}
                    >
                      <Play size={12} />
                      Live preview
                    </button>
                  )}
                </div>
              )}
              <div className="screen-preview-caption">
                <strong>{screen.name}</strong>
                {screen.figmaNodeId ? (
                  <button
                    type="button"
                    className="screen-figma-link is-linked"
                    onClick={() => onOpenFigmaNode(screen.figmaNodeId ?? null)}
                    aria-label={`Open ${screen.name} in Figma`}
                    title={screen.figmaFrameName ?? "Open linked Figma frame"}
                  ><Figma size={13} /></button>
                ) : (
                  <span className={`screen-figma-link ${project.fileKey ? "is-pending" : ""}`} title={project.fileKey ? "Will be created on import" : "Connect a Figma file first"}>
                    <Figma size={13} />
                  </span>
                )}
              </div>
            </article>
          ))}
        </div>

        {components.length > 0 && (
          <section className="component-discovery" aria-labelledby="reusable-views-title">
            <div>
              <h2 id="reusable-views-title">Reusable views</h2>
              <p>These can become Figma components after screens are mapped.</p>
            </div>
            <div className="component-chips">
              {components.map((component) => (
                <span key={component.id}><Layers3 size={12} />{component.name}</span>
              ))}
            </div>
          </section>
        )}

      </div>
    </section>
  );
}

function AutomaticMappingDialog({
  project,
  mapping,
  onClose,
  onOpenFigma,
  onShowPlugin,
  onCopyCode,
  onRestart
}: {
  project: ProjectInfo;
  mapping: ActiveAutomaticMapping;
  onClose: () => void;
  onOpenFigma: () => void;
  onShowPlugin: () => void;
  onCopyCode: () => void;
  onRestart: () => void;
}) {
  const { status, session } = mapping;
  const isPull = mapping.operation === "pull";
  const isComplete = status.state === "complete";
  const hasFailed = status.state === "error" || status.state === "expired";
  const isRunning = status.state === "running";

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="figma-link-dialog automatic-mapping-dialog" role="dialog" aria-modal="true" aria-labelledby="automatic-mapping-title">
        <div className="dialog-icon"><Sparkles size={18} /></div>
        <button type="button" className="icon-button dialog-close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="dialog-copy">
          <span>Figma sync</span>
          <h2 id="automatic-mapping-title">
            {isComplete ? (isPull ? "Figma changes read" : "Sync complete") : isRunning ? (isPull ? "Reading Figma…" : "Syncing to Figma…") : hasFailed ? "Sync could not finish" : session.requiresPairing ? "Connect Figma once" : "Open UI Sync Bridge"}
          </h2>
          <p>
            {isComplete
              ? isPull ? "The three-way diff is ready for review. No local files have changed yet." : "Your pages and their Figma frame identities are up to date."
              : isRunning
                ? isPull ? "Keep Figma open while UI Sync reads only the remembered editable layers." : "Keep Figma open while UI Sync updates the linked pages."
                : hasFailed
                  ? "Nothing was changed. Open the Figma plugin, then try again."
                  : session.requiresPairing
                ? "Enter this code once. Every project on this Mac will use the same remembered connection."
                : `UI Sync is ready. Open the plugin in ${project.figmaFileName} to start syncing.`}
          </p>
        </div>

        {!isComplete && !hasFailed && (
          <>
            {session.requiresPairing ? (
              <div className="pairing-code-block">
                <span>One-time code</span>
                <strong>{session.pairingCode.slice(0, 3)} {session.pairingCode.slice(3)}</strong>
                <button type="button" className="icon-button" aria-label="Copy pairing code" title="Copy pairing code" onClick={onCopyCode}>
                  <Copy size={15} />
                </button>
              </div>
            ) : (
              <div className={`connection-prompt ${isRunning ? "is-running" : ""}`}>
                {isRunning ? <LoaderCircle className="spin" size={18} /> : <Figma size={18} />}
                <div><strong>{isRunning ? (isPull ? "Reading mapped layers" : "Syncing pages") : "Waiting for the Figma plugin"}</strong><span>{isRunning ? `${session.screenCount} pages are being ${isPull ? "compared" : "updated"}` : "No code needed — the device connection is remembered"}</span></div>
              </div>
            )}
            <div className="connection-shortcuts">
              <button type="button" className="primary-button" onClick={onOpenFigma}><ExternalLink size={14} /> Open Figma</button>
              <button type="button" className="secondary-button" onClick={onShowPlugin}><Figma size={14} /> Find plugin</button>
            </div>
            {!session.requiresPairing && !isRunning && (
              <details className="pairing-fallback">
                <summary>Plugin does not reconnect?</summary>
                <div><span>Enter fallback code</span><strong>{session.pairingCode.slice(0, 3)} {session.pairingCode.slice(3)}</strong><button type="button" className="icon-button" onClick={onCopyCode} aria-label="Copy fallback code"><Copy size={14} /></button></div>
              </details>
            )}
          </>
        )}

        {isComplete && (
          <div className="automatic-result">
            <Check size={18} />
            <div><strong>{status.renderedCount ?? 0} screens {isPull ? "read" : "rendered"}</strong><span>{isPull ? "Ready for local review" : `${status.createdCount ?? 0} frames created · ${status.reusedCount ?? 0} mappings restored`}</span></div>
          </div>
        )}

        {hasFailed && (
          <div className="automatic-error">
            <AlertCircle size={17} />
            <p><strong>{status.state === "expired" ? "Pairing code expired" : "Frames were not linked"}</strong><span>{status.message ?? "Create a new pairing code and try again."}</span></p>
          </div>
        )}

        <div className="dialog-actions">
          {hasFailed ? (
            <button type="button" className="primary-button" onClick={onRestart}><RefreshCw size={14} /> Try again</button>
          ) : (
            <button type="button" className={isComplete ? "primary-button" : "secondary-button"} onClick={onClose}>
              {isComplete ? "Done" : "Close"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function FigmaLinkDialog({
  project,
  target,
  onClose,
  onSave
}: {
  project: ProjectInfo;
  target: FigmaLinkTarget;
  onClose: () => void;
  onSave: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const isFile = target.mode === "file";

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!value.trim()) {
      setError(isFile ? "Paste a Figma Design link" : "Paste a link to the exact Figma frame");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(value);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "This Figma link could not be saved");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <form className="figma-link-dialog" onSubmit={(event) => void submit(event)}>
        <div className="dialog-icon"><Figma size={19} /></div>
        <button type="button" className="icon-button dialog-close" aria-label="Close" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="dialog-copy">
          <span>{isFile ? "Connect Figma" : `Map ${target.screen.name}`}</span>
          <h2>{isFile ? "Choose a Figma file" : "Choose the matching frame"}</h2>
          <p>
            {isFile
              ? `Paste a Design link for ${project.name}. You can copy it from the Figma address bar.`
              : "In Figma, select the exact frame and choose Copy link to selection."}
          </p>
        </div>
        <label className={`figma-url-field ${error ? "has-error" : ""}`}>
          <span>Figma link</span>
          <input
            autoFocus
            type="url"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={isFile ? "https://www.figma.com/design/…" : "https://www.figma.com/design/…?node-id=…"}
            spellCheck={false}
          />
        </label>
        <div className="dialog-message">
          {error ? (
            <span className="dialog-error"><AlertCircle size={13} />{error}</span>
          ) : (
            <span><Check size={12} />Only the file key and exact node ID are stored.</span>
          )}
        </div>
        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancel</button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? <LoaderCircle className="spin" size={15} /> : <ArrowRight size={15} />}
            {saving ? "Connecting" : isFile ? "Connect file" : "Save mapping"}
          </button>
        </div>
      </form>
    </div>
  );
}

function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 3600);
    return () => window.clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className="toast" role="status">
      <span><Check size={14} /></span>
      <p>{message}</p>
      <button onClick={onDismiss} aria-label="Dismiss notification"><X size={14} /></button>
    </div>
  );
}

export default App;
