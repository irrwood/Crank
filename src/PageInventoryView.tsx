import { useEffect, useRef, useState } from "react";
import { ChevronRight, Download, Figma, FolderGit2, Globe2, LoaderCircle, Plus, RefreshCw, X } from "lucide-react";
import { FigmaSyncDialog } from "./FigmaSyncDialog";
import type { AutomaticMappingStatus, DiscoveredPage, InventoryGroup, InventoryTarget, PageInventory, ScanLifecycle, ScanProgress, ScanStatus, WorkspacePackage, ForeignProject } from "./types";

/**
 * The whole product in one screen: give an address, get every page.
 *
 * Deliberately stack-agnostic — the address may be a Vite dev server, a Python
 * app, a static folder or an Electron renderer served over http.
 */

function addressOf(page: DiscoveredPage): string {
  if (page.recipe.length === 0) return page.route;
  const steps = page.recipe.map((step) => `点击「${step.label || step.locator}」`).join(" → ");
  return `${page.route} → ${steps}`;
}

type FigmaExportSession = {
  pairingCode: string;
  expiresAt: string;
  screenCount: number;
  requiresPairing: boolean;
  fileName?: string;
  fileKey?: string;
  missing?: string[];
  dropped?: string[];
};

/** What will not arrive, said before the sync claims to be complete. */
function shortfall(session: FigmaExportSession): string | null {
  const parts: string[] = [];
  if (session.missing?.length) {
    parts.push(`${session.missing.length} ${session.missing.length === 1 ? "page has" : "pages have"} no captured layers and stay behind: ${session.missing.slice(0, 4).join(", ")}${session.missing.length > 4 ? "…" : ""}`);
  }
  if (session.dropped?.length) {
    parts.push(`${session.dropped.length} beyond the per-file limit were left out.`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

function PageCard({ page, index, onOpen }: { page: DiscoveredPage; index: number; onOpen: (page: DiscoveredPage) => void }) {
  // Variants are the same page re-skinned — dark mode, another language — so
  // they share one card and swap the preview rather than taking a slot each.
  const looks = [{ id: page.id, name: "Default", thumbnail: page.thumbnail }, ...(page.variants ?? [])];
  const [shown, setShown] = useState(0);
  const current = looks[Math.min(shown, looks.length - 1)];

  return (
    <article className="inventory-card">
      <button className="inventory-shot" onClick={() => onOpen(page)} type="button">
        {current.thumbnail
          ? <img alt="" src={current.thumbnail.dataUrl} />
          : <span className="inventory-shot-empty">No preview</span>}
      </button>
      <div className="inventory-meta">
        <span className="inventory-index">{String(index + 1).padStart(2, "0")}</span>
        <h3 title={page.name}>{page.name}</h3>
      </div>
      {looks.length > 1 && (
        <div className="inventory-variants">
          {looks.map((look, position) => (
            <button
              aria-pressed={position === shown}
              key={look.id}
              onClick={() => setShown(position)}
              type="button"
            >
              {look.name}
            </button>
          ))}
        </div>
      )}
      <p className="inventory-address" title={addressOf(page)}>{addressOf(page)}</p>
    </article>
  );
}


type Entry = InventoryTarget | InventoryGroup;

const isGroup = (entry: Entry): entry is InventoryGroup => entry.kind === "group";

function whenScanned(value: string | null): string {
  if (!value) return "not scanned";
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

function TargetRow({ target, active, busy, onOpen, onRescan, onForget, nested }: {
  target: InventoryTarget; active: boolean; busy?: boolean; nested?: boolean;
  onOpen: (target: InventoryTarget) => void;
  onRescan: (target: InventoryTarget) => void;
  onForget: (target: InventoryTarget) => void;
}) {
  return (
    <button
      className={`project-item ${active ? "is-active" : ""}${nested ? " is-nested" : ""}`}
      onClick={() => onOpen(target)}
      title={target.target}
      type="button"
    >
      <span className={`project-icon is-${target.kind === "folder" ? "web" : "desktop"}`}>
        {busy ? <LoaderCircle className="spin" size={14} /> : target.kind === "folder" ? <FolderGit2 size={14} /> : <Globe2 size={14} />}
      </span>
      <span className="project-copy">
        <strong>{target.name}</strong>
        <small>
          {busy
            ? "scanning…"
            : target.pageCount === null
              ? "not scanned"
              : `${target.pageCount} ${target.pageCount === 1 ? "page" : "pages"} · ${whenScanned(target.lastScannedAt)}`}
        </small>
      </span>
      <span className="target-actions">
        <span
          className="icon-button"
          onClick={(event) => { event.stopPropagation(); onRescan(target); }}
          role="button"
          title="Rescan"
        >
          <RefreshCw size={13} />
        </span>
        <span
          className="icon-button"
          onClick={(event) => { event.stopPropagation(); onForget(target); }}
          role="button"
          title="Remove"
        >
          <X size={13} />
        </span>
      </span>
    </button>
  );
}

function Sidebar({ entries, activeId, busyIds, onOpen, onRescan, onForget, onAdd }: {
  entries: Entry[]; activeId: string | null; busyIds: string[];
  onOpen: (target: InventoryTarget) => void;
  onRescan: (target: InventoryTarget) => void;
  onForget: (target: InventoryTarget) => void;
  onAdd: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  return (
    <aside className="sidebar">
      {/* The window is hiddenInset with the traffic lights at (18,18), so the
          sidebar has to start below them — the same spacer the older
          interface uses. */}
      <div className="sidebar-drag drag-region" />
      <div className="brand-row">
        <div aria-hidden="true" className="brand-mark"><img alt="" src="./app-icon.png" /></div>
        <span>UI Sync</span>
      </div>

      <div className="sidebar-section-header">
        <span>Projects</span>
        <button aria-label="Add project" className="icon-button" onClick={onAdd} title="Add project" type="button">
          <Plus size={15} />
        </button>
      </div>

      <div className="project-list">
        {entries.length === 0 && <p className="target-empty">Nothing scanned yet.</p>}
        {entries.map((entry) => (isGroup(entry) ? (
          <div key={entry.id}>
            <button
              className="target-group-head"
              onClick={() => setCollapsed((current) => ({ ...current, [entry.id]: !current[entry.id] }))}
              type="button"
            >
              <ChevronRight className={collapsed[entry.id] ? "" : "is-open"} size={13} />
              {entry.name}
              <span className="target-count">{entry.children.length}</span>
            </button>
            {!collapsed[entry.id] && entry.root && (
              <TargetRow
                active={entry.root.id === activeId} busy={busyIds.includes(entry.root.id)} nested
                onForget={onForget} onOpen={onOpen} onRescan={onRescan} target={entry.root}
              />
            )}
            {!collapsed[entry.id] && entry.children.map((child) => (
              <TargetRow
                active={child.id === activeId} busy={busyIds.includes(child.id)} key={child.id} nested
                onForget={onForget} onOpen={onOpen} onRescan={onRescan} target={child}
              />
            ))}
          </div>
        ) : (
          <TargetRow
            active={entry.id === activeId} busy={busyIds.includes(entry.id)} key={entry.id}
            onForget={onForget} onOpen={onOpen} onRescan={onRescan} target={entry}
          />
        )))}
      </div>
    </aside>
  );
}

function PageOverlay({ page, onClose }: { page: DiscoveredPage; onClose: () => void }) {
  const looks = [
    { id: page.id, name: "Default", snapshot: page.snapshot, thumbnail: page.thumbnail },
    ...(page.variants ?? [])
  ];
  const [shown, setShown] = useState(0);
  const current = looks[Math.min(shown, looks.length - 1)];

  return (
    <div className="inventory-overlay" onClick={onClose} role="presentation">
      <figure onClick={(event) => event.stopPropagation()} role="presentation">
        <figcaption>
          <strong>{page.name}</strong>
          <code>{addressOf(page)}</code>
          {looks.length > 1 && (
            <span className="inventory-variants">
              {looks.map((look, position) => (
                <button
                  aria-pressed={position === shown}
                  key={look.id}
                  onClick={() => setShown(position)}
                  type="button"
                >
                  {look.name}
                </button>
              ))}
            </span>
          )}
          <button onClick={onClose} type="button">Close</button>
        </figcaption>
        {current.snapshot?.html
          ? (
            <iframe
              className="inventory-frame"
              sandbox=""
              srcDoc={current.snapshot.html}
              title={page.name}
            />
          )
          : current.thumbnail
            ? <img alt="" src={current.thumbnail.dataUrl} />
            : <p>Nothing was captured for this page.</p>}
        {(current.snapshot?.stats?.rasterised?.length ?? 0) > 0 && (
          <p className="inventory-frame-note">
            {current.snapshot?.stats.rasterised.length} area(s) held pixels and were captured as images:{" "}
            {current.snapshot?.stats.rasterised.join(", ")}. Everything else is live markup.
          </p>
        )}
      </figure>
    </div>
  );
}

export default function PageInventoryView() {
  const [address, setAddress] = useState("");
  const [seeds, setSeeds] = useState("");
  // One job per project rather than one global "scanning": a scan takes
  // minutes, and locking the whole window for it means the wait is the only
  // thing you can do.
  const [jobs, setJobs] = useState<Record<string, { status: ScanStatus | null; progress: ScanProgress[]; target: string }>>({});
  const [result, setResult] = useState<PageInventory | null>(null);
  // Messages float at the bottom instead of taking a slot at the top: an error
  // pushing the header down moves everything the moment you most want it still.
  const [toasts, setToasts] = useState<Array<{ id: number; kind: "error" | "done"; text: string; path?: string }>>([]);
  const [focused, setFocused] = useState<DiscoveredPage | null>(null);
  const [showFiltered, setShowFiltered] = useState(false);

  const [title, setTitle] = useState("Design handoff");
  const [source, setSource] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
  const [choices, setChoices] = useState<WorkspacePackage[] | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [foreign, setForeign] = useState<{ info: ForeignProject; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [recording, setRecording] = useState<DiscoveredPage[] | null>(null);
  const [figmaUrl, setFigmaUrl] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"gallery" | "compact" | "list">("gallery");
  const [figmaOpen, setFigmaOpen] = useState(false);
  const [figmaSession, setFigmaSession] = useState<FigmaExportSession | null>(null);
  const [figmaStatus, setFigmaStatus] = useState<AutomaticMappingStatus>({ state: "waiting" });
  const progressRef = useRef<HTMLDivElement>(null);
  const toastSeq = useRef(0);

  const notify = (kind: "error" | "done", text: string, path?: string) => {
    const id = (toastSeq.current += 1);
    setToasts((current) => [...current, { id, kind, text, path }]);
    setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), kind === "error" ? 9000 : 6000);
  };
  const dismiss = (id: number) => setToasts((current) => current.filter((toast) => toast.id !== id));

  /** The job belonging to whatever is on screen; others keep running unseen. */
  const activeJob = activeId ? jobs[activeId] : undefined;

  useEffect(() => {
    void window.uiSync?.listInventoryTargets?.().then(setEntries);
  }, []);

  useEffect(() => {
    const offStatus = window.uiSync?.onScanStatus?.((value) => {
      if (!value.id) return;
      setJobs((current) => (current[value.id!] ? { ...current, [value.id!]: { ...current[value.id!], status: value } } : current));
    });
    const offProgress = window.uiSync?.onScanProgress?.((value) => {
      if (!value.id) return;
      setJobs((current) => (current[value.id!]
        ? { ...current, [value.id!]: { ...current[value.id!], progress: [...current[value.id!].progress, value] } }
        : current));
    });
    const offLife = window.uiSync?.onScanLifecycle?.((value: ScanLifecycle) => {
      if (value.phase === "started") {
        setJobs((current) => ({ ...current, [value.id]: { status: null, progress: [], target: value.target ?? "" } }));
        refreshTargets();
      } else {
        setJobs((current) => {
          const next = { ...current };
          delete next[value.id];
          return next;
        });
        refreshTargets();
      }
    });
    return () => { offStatus?.(); offProgress?.(); offLife?.(); };
  }, []);

  useEffect(() => {
    const off = window.uiSync?.onRecorded?.((page) => {
      setRecording((current) => (current ? [...current, page] : current));
    });
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    progressRef.current?.scrollTo({ top: progressRef.current.scrollHeight });
  }, [activeJob?.progress.length]);

  // Kicking off a scan clears the view for it but never locks the window: the
  // job runs against its own sidebar entry, so you can open something else.
  const beginScan = (label: string) => {
        setResult(null);
    setFocused(null);
    setSource(label);
  };

  const refreshTargets = () => { void window.uiSync?.listInventoryTargets?.().then(setEntries); };

  const finishScan = (inventory: PageInventory) => {
    refreshTargets();
    if (!inventory.ok && inventory.reason === "workspace" && inventory.packages?.length) {
      setChoices(inventory.packages);
      setWorkspaceRoot(source);
      return;
    }
    if (!inventory.ok && inventory.reason === "foreign" && inventory.foreign) {
      setForeign({ info: inventory.foreign, message: inventory.message });
      if (inventory.foreign.port) setAddress(`localhost:${inventory.foreign.port}`);
      setShowAddress(true);
      return;
    }
    setResult(inventory);
    if (!inventory.ok) notify("error", inventory.message);
  };

  const scanFolder = async (root: string, workspaceRoot?: string) => {
    if (!window.uiSync?.scanFolder) return;
    setChoices(null);
    setForeign(null);
    beginScan(root);
    setTitle(`${root.split("/").filter(Boolean).pop() ?? "Design"} handoff`);
    try {
      const inventory = await window.uiSync.scanFolder(root, workspaceRoot);
      if ((inventory as { id?: string }).id) setActiveId((inventory as { id?: string }).id!);
      finishScan(inventory);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : "The scan failed.");
    }
  };

  const scan = async (explicit?: string) => {
    if (!window.uiSync?.scanUrl) return;
    const target = explicit ?? address;
    beginScan(target);
    try {
      const seedPaths = seeds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
      const inventory = await window.uiSync.scanUrl(target, seedPaths);
      if ((inventory as { id?: string }).id) setActiveId((inventory as { id?: string }).id!);
      finishScan(inventory);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : "The scan failed.");
    }
  };

  const startRecording = async () => {
    if (!window.uiSync?.startRecording) return;
    const target = address.trim() || (result?.ok ? result.origin : "");
    if (!target) { notify("error", "Enter the address to record from."); return; }
        const outcome = await window.uiSync.startRecording(target);
    if (!outcome.ok) { notify("error", outcome.message ?? "Recording could not start."); return; }
    setRecording([]);
  };

  const stopRecording = async () => {
    const outcome = await window.uiSync?.stopRecording?.();
    const recorded = outcome?.pages ?? [];
    setRecording(null);
    if (recorded.length === 0) return;
    // Recorded pages join whatever the scan found, without replacing it.
    setResult((current) => {
      if (!current?.ok) {
        return { ok: true, origin: recorded[0].route, pages: recorded, skipped: [], filtered: [],
          sources: { sitemap: 0, seeds: 0, crawled: 0 }, blocked: { mutations: [], external: [] } };
      }
      // By identity, not by appearance: a page recorded by hand is the page the
      // crawl already has if it lives at the same address, even though the two
      // visits will never render byte-identically.
      const known = new Set(current.pages.map((page) => page.id));
      return { ...current, pages: [...current.pages, ...recorded.filter((page) => !known.has(page.id))] };
    });
  };

  const sendToFigma = async () => {
    if (!result?.ok || !window.uiSync?.sendInventoryToFigma) return;
        try {
      const outcome = await window.uiSync.sendInventoryToFigma(
        { origin: result.origin, source: result.source, pages: result.pages },
        figmaUrl.trim()
      );
      if (!outcome.ok || !outcome.pairingCode) { notify("error", outcome.message ?? "The export could not be prepared."); return; }
      setFigmaStatus({ state: "waiting" });
      setFigmaSession({
        pairingCode: outcome.pairingCode,
        expiresAt: outcome.expiresAt ?? "",
        screenCount: outcome.screenCount ?? 0,
        requiresPairing: outcome.requiresPairing ?? false,
        fileName: outcome.fileName,
        fileKey: outcome.fileKey,
        missing: outcome.missing,
        dropped: outcome.dropped
      });
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : "The export failed.");
    }
  };

  // A send only queues the job; the plugin does the work minutes later. Without
  // this the window said nothing at all — not even the code needed to pair.
  useEffect(() => {
    const pairingCode = figmaSession?.pairingCode;
    if (!pairingCode || !window.uiSync?.getFigmaExportStatus) return;
    let cancelled = false;
    let timer: number | null = null;
    const check = async () => {
      try {
        const status = await window.uiSync?.getFigmaExportStatus?.(pairingCode);
        if (!status || cancelled) return;
        setFigmaStatus(status);
        if (["complete", "error", "expired"].includes(status.state)) return;
      } catch (cause) {
        if (!cancelled) setFigmaStatus({ state: "error", message: cause instanceof Error ? cause.message : "Could not read the sync status" });
        return;
      }
      timer = window.setTimeout(() => void check(), 1000);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [figmaSession?.pairingCode]);

  const openSaved = async (target: InventoryTarget) => {
    const saved = await window.uiSync?.openInventory?.(target.id);
    if (!saved) {
      // Never scanned, or a scan that did not finish. Doing it is more useful
      // than telling the user it has not been done.
      rescan(target);
      return;
    }
        setChoices(null);
    setForeign(null);
    setResult(saved);
    setActiveId(target.id);
    setSource(target.target);
    setTitle(`${target.name} handoff`);
  };

  const rescan = (target: InventoryTarget) => {
    setActiveId(target.id);
    if (target.kind === "folder") void scanFolder(target.target);
    else { setAddress(target.target); void scan(target.target); }
  };

  const forget = async (target: InventoryTarget) => {
    const next = await window.uiSync?.forgetInventoryTarget?.(target.id);
    if (next) setEntries(next);
    if (activeId === target.id) { setResult(null); setActiveId(null); }
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    const dropped = file && window.uiSync?.getDroppedPath?.(file);
    if (dropped) void scanFolder(dropped);
    else notify("error", "Drop a project folder.");
  };

  const chooseFolder = async () => {
    const chosen = await window.uiSync?.chooseFolder?.();
    if (chosen) void scanFolder(chosen);
  };

  const exportPage = async () => {
    if (!result?.ok || !window.uiSync?.exportHandoffPage) return;
        try {
      const outcome = await window.uiSync.exportHandoffPage(
        { origin: result.origin, pages: result.pages, filtered: result.filtered },
        title.trim() || "Design handoff"
      );
      if (outcome.saved && outcome.filePath) notify("done", "Handoff page saved", outcome.filePath);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : "The page could not be saved.");
    }
  };

  const pages = result?.ok ? result.pages : [];
  const reskins = pages.reduce((total, page) => total + (page.variants?.length ?? 0), 0);
  // One page found, and every control on it did nothing. A scan that says only
  // "1 page" reads as a one-page app; it is worth saying which of the two it is.
  const stalled = Boolean(result?.ok && pages.length === 1 && (result.inert?.length ?? 0) > 0);
  // The inert controls are spelled out in that panel already, so they are not
  // also offered behind "left out".
  const leftOut = result?.ok
    ? result.filtered.length + (stalled ? 0 : result.inert?.length ?? 0)
    : 0;

  return (
    <div className="app-frame">
      <Sidebar
        activeId={activeId}
        busyIds={Object.keys(jobs)}
        entries={entries}
        onAdd={() => { setResult(null); setActiveId(null); setChoices(null); setForeign(null); }}
        onForget={(target) => void forget(target)}
        onOpen={(target) => void openSaved(target)}
        onRescan={rescan}
      />
    <main className="inventory-page">
      {choices && !activeJob && (
        <section className="inventory-choices">
          <strong>This folder holds several runnable projects</strong>
          <p>Its dev script starts them in parallel, so scanning the folder itself would pick one at random. Choose the one you mean.</p>
          <ul>
            {choices.map((item) => (
              <li key={item.root}>
                <button onClick={() => void scanFolder(item.root, workspaceRoot ?? undefined)} type="button">
                  <strong>{item.name}</strong>
                  <code>{item.root}</code>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {foreign && !activeJob && (
        <section className="inventory-choices">
          <strong>{foreign.message}</strong>
          <p>These come from the project itself — nothing here was invented.</p>
          <ul>
            {foreign.info.commands.map((entry) => (
              <li key={entry.command}>
                <button
                  onClick={() => { void window.uiSync?.copyText?.(entry.command); setCopied(entry.command); }}
                  type="button"
                >
                  <strong>{entry.command}</strong>
                  <code>from {entry.source}{copied === entry.command ? " · copied" : " · click to copy"}</code>
                </button>
              </li>
            ))}
          </ul>
          {foreign.info.port !== null && (
            <p className="inventory-note">
              Once it is running, scan <code>localhost:{foreign.info.port}</code> below.
            </p>
          )}
        </section>
      )}

      {!result?.ok && !activeJob && !choices && !foreign && (
        <section
          className={`onboarding${dragging ? " is-over" : ""}`}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDrop={onDrop}
        >
          <div className="onboarding-drop">
            <FolderGit2 size={26} />
            <h1>拖入你的项目文件夹</h1>
            <p>UI Sync 会自己判断技术栈、把项目跑起来,然后走遍每一个页面。</p>
            <button className="primary-button" onClick={() => void chooseFolder()} type="button">选择文件夹…</button>
          </div>

          <ol className="onboarding-steps">
            <li>
              <strong>识别并启动</strong>
              <span>npm / pnpm 项目读它自己的 dev 脚本;Electron 只起界面不弹窗口;Python、Ruby 这类读它 Dockerfile、Procfile 或 README 里写好的命令。</span>
            </li>
            <li>
              <strong>走遍每个页面</strong>
              <span>路由、tab、弹层都算一个页面。深色模式和切换语言不算新页面,会并进同一页的不同外观。</span>
            </li>
            <li>
              <strong>拿走结果</strong>
              <span>导出一份自带图片的 HTML 交接页,或直接把图层送进 Figma。</span>
            </li>
          </ol>

          <div className="onboarding-alt">
            <button className="inventory-link" onClick={() => void startRecording()} type="button">
              需要登录或填表单才能到达的页面?自己点一遍,我来记录
            </button>
            <button className="inventory-link" onClick={() => setShowAddress((value) => !value)} type="button">
              {showAddress ? "收起" : "项目已经跑起来了?直接扫一个地址"}
            </button>
            {showAddress && (
              <form className="inventory-form" onSubmit={(event) => { event.preventDefault(); void scan(); }}>
                <input
                  aria-label="Address"
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="localhost:5173"
                  value={address}
                />
                <input
                  aria-label="Extra addresses"
                  onChange={(event) => setSeeds(event.target.value)}
                  placeholder="额外路径,可选 — /?view=settings"
                  value={seeds}
                />
                <button disabled={!address.trim()} type="submit">扫描</button>
              </form>
            )}
          </div>
        </section>
      )}

      {activeJob && (
        <header className="project-header">
          <div className="project-header-copy">
            <h1>{(activeJob.target || source || "").split("/").filter(Boolean).pop() ?? "Scanning"}</h1>
            <div className="connection-line">
              <LoaderCircle className="spin" size={13} />
              <span>{activeJob.status ? activeJob.status.detail : "Opening…"}</span>
              <span className="header-sep">· this keeps running if you open something else</span>
            </div>
          </div>
        </header>
      )}

      {activeJob && (
        <section className="inventory-progress" ref={progressRef}>
          {activeJob.progress.length === 0
            ? <p>Looking for pages…</p>
            : activeJob.progress.map((item, index) => (
                <p key={`${item.route}-${index}`}>
                  <span className="inventory-progress-count">{index + 1}</span> {item.name}
                </p>
              ))}
        </section>
      )}

      {recording && (
        <section className="inventory-recording">
          <strong>Recording — use the app in the other window</strong>
          <p>
            Every page you land on is captured. Log in, fill forms, open the screens that matter;
            nothing is blocked while recording.
          </p>
          <div className="inventory-recorded">
            {recording.length === 0
              ? <span>No pages captured yet.</span>
              : recording.map((page) => <span key={page.id}>{page.name}</span>)}
          </div>
          <button className="inventory-export" onClick={() => void stopRecording()} type="button">
            Finish — keep {recording.length} page{recording.length === 1 ? "" : "s"}
          </button>
        </section>
      )}


      {result?.ok && (
        <>
          <header className="project-header">
            <div className="project-header-copy">
              <h1>{source?.split("/").filter(Boolean).pop() ?? result.origin}</h1>
              <div className="connection-line">
                <Globe2 size={13} />
                <span>{result.origin}</span>
                <span className="header-sep">·</span>
                <span>{pages.length} {pages.length === 1 ? "page" : "pages"}</span>
                {result.sources.sitemap > 0 && <span className="header-sep">· {result.sources.sitemap} from sitemap</span>}
                {result.sources.crawled > 0 && <span className="header-sep">· {result.sources.crawled} crawled</span>}
                {reskins > 0 && <span className="header-sep">· {reskins} {reskins === 1 ? "re-skin" : "re-skins"} grouped</span>}
              </div>
            </div>
            <div className="project-header-actions">
              <button
                aria-label="Rescan"
                className="secondary-button project-refresh-button"
                onClick={() => { if (source) source.startsWith("http") ? void scan(source) : void scanFolder(source); }}
                title="Rescan"
                type="button"
              >
                <RefreshCw size={14} />
              </button>
              <button className="secondary-button" onClick={() => void exportPage()} type="button">
                <Download size={14} /> Save handoff page
              </button>
              <button className="secondary-button" onClick={() => setFigmaOpen((value) => !value)} type="button">
                <Figma size={14} /> Send to Figma
              </button>
            </div>
          </header>

          {stalled && (
            <section className="inventory-stalled">
              <p>
                <strong>只找到这一页，因为页面上的每个控件点下去都没有任何反应。</strong>
                {" "}扫到的这一页是真的，但这个应用的其余部分不在这里。
              </p>
              <p className="inventory-note">
                最常见的原因是界面被单独跑了起来,而它依赖的运行时不在——Electron 项目只起渲染进程时拿不到 preload,
                前端拿不到后端接口时也一样。等应用完整跑起来之后扫它的地址,或者用「自己点一遍」把需要登录、需要真实数据的页面记录下来。
              </p>
              <ul>
                {result.inert!.map((entry, index) => (
                  <li key={`${entry.label}-${index}`}>「{entry.label || "(无标签)"}」</li>
                ))}
              </ul>
            </section>
          )}

          {figmaOpen && (
            <div className="inventory-figma-row">
              <input
                aria-label="Figma design URL"
                onChange={(event) => setFigmaUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void sendToFigma(); }}
                placeholder="Paste the Figma design URL to send these pages into"
                value={figmaUrl}
              />
              <button className="secondary-button" disabled={!figmaUrl.trim()} onClick={() => void sendToFigma()} type="button">
                Send {pages.length} pages
              </button>
            </div>
          )}

          <div className="inventory-toolbar">
            <span className="view-switch">
              {([["gallery", "Gallery"], ["compact", "Compact"], ["list", "List"]] as const).map(([id, label]) => (
                <button aria-pressed={view === id} key={id} onClick={() => setView(id)} type="button">{label}</button>
              ))}
            </span>
            {leftOut > 0 && (
              <button className="inventory-link" onClick={() => setShowFiltered((value) => !value)} type="button">
                {showFiltered ? "Hide" : "Show"} {leftOut} left out
              </button>
            )}
          </div>

          {showFiltered && (
            <section className="inventory-filtered">
              {result.filtered.length > 0 && (
                <>
                  <p>Left out for changing too little of the screen to be a page:</p>
                  <ul>
                    {result.filtered.map((item, index) => (
                      <li key={`${item.label}-${index}`}>
                        <code>{Math.round(item.magnitude * 1000) / 10}%</code>
                        <span>「{item.label}」</span>
                        <small>from {item.from}</small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {/* Kept apart from the list above: those were judged too small to
                  be a page, these did not change the page at all. */}
              {!stalled && (result.inert?.length ?? 0) > 0 && (
                <>
                  <p>点下去没有任何反应,页面保持原样:</p>
                  <ul>
                    {result.inert!.map((item, index) => (
                      <li key={`inert-${item.label}-${index}`}>
                        <span>「{item.label || "(无标签)"}」</span>
                        <small>from {item.from}</small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {result.skipped.length > 0 && (
                <p className="inventory-note">
                  Never clicked, the label reads as destructive: {result.skipped.map((item) => `「${item.label}」`).join(" ")}
                </p>
              )}
            </section>
          )}

          {view === "list" ? (
            <ul className="inventory-rows">
              {pages.map((page, index) => (
                <li key={page.id}>
                  <button onClick={() => setFocused(page)} type="button">
                    <span className="inventory-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="inventory-row-name">{page.name}</span>
                    {(page.variants?.length ?? 0) > 0 && (
                      <span className="inventory-row-variants">{page.variants.length} looks</span>
                    )}
                    <code>{addressOf(page)}</code>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={`inventory-grid${view === "compact" ? " is-compact" : ""}`}>
              {pages.map((page, index) => (
                <PageCard index={index} key={page.id} onOpen={setFocused} page={page} />
              ))}
            </div>
          )}
        </>
      )}

      {focused && <PageOverlay onClose={() => setFocused(null)} page={focused} />}

      {figmaSession && (
        <FigmaSyncDialog
          fileName={figmaSession.fileName ?? "your Figma file"}
          note={shortfall(figmaSession)}
          onClose={() => setFigmaSession(null)}
          onCopyCode={() => void window.uiSync?.copyText?.(figmaSession.pairingCode)}
          onOpenFigma={() => { if (figmaSession.fileKey) void window.uiSync?.openFigma?.(figmaSession.fileKey, null); }}
          onRestart={() => void sendToFigma()}
          onShowPlugin={() => void window.uiSync?.showFigmaPlugin?.()}
          operation="push"
          session={figmaSession}
          status={figmaStatus}
        />
      )}

      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map((toast) => (
            <div className={`toast is-${toast.kind}`} key={toast.id}>
              <span>{toast.text}</span>
              {toast.path && (
                <button onClick={() => void window.uiSync?.revealFile?.(toast.path!)} type="button">
                  Show in Finder
                </button>
              )}
              <button aria-label="Dismiss" className="toast-close" onClick={() => dismiss(toast.id)} type="button">
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}
    </main>
    </div>
  );
}
