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
  substitutedFonts?: string[];
};

/** What will not arrive, said before the sync claims to be complete. */
function shortfall(session: FigmaExportSession): string | null {
  const parts: string[] = [];
  if (session.missing?.length) {
    const named = session.missing.slice(0, 4).join("、");
    parts.push(`${session.missing.length} 个页面没有捕获到图层，不会送出：${named}${session.missing.length > 4 ? " 等" : ""}。`);
  }
  if (session.dropped?.length) {
    parts.push(`还有 ${session.dropped.length} 个页面超出单个文件的上限，这次没有送出。`);
  }
  if (session.substitutedFonts?.length) {
    // Not a shortfall in what arrives — every layer is sent. It changes who
    // decided where the lines fall, which is worth knowing before the result
    // is compared against the browser.
    parts.push(`${session.substitutedFonts.join("、")} 没能在捕获时加载，这些文字的换行交给 Figma 自己排。`);
  }
  return parts.length > 0 ? parts.join(" ") : null;
}

type PageAction = "recapture" | "explore" | "figma" | "drop";

/**
 * The menu a page opens on right-click.
 *
 * Only actions that mean something for one page in particular live here; what
 * applies to the whole project belongs on the project, not repeated on each of
 * its pages.
 */
function PageMenu({ at, busy, onPick, onClose }: {
  at: { x: number; y: number };
  busy: boolean;
  onPick: (action: PageAction) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Capture, so a click anywhere else closes the menu before it reaches what
    // is underneath. A press inside the menu has to be let through by asking
    // the DOM where it landed: React's own handler runs after this one, so
    // stopping propagation there would be too late — the menu would already
    // have unmounted and the click would never reach the item.
    const dismiss = (event: MouseEvent) => {
      if (box.current?.contains(event.target as Node)) return;
      onClose();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const away = () => onClose();
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("keydown", key);
    window.addEventListener("resize", away);
    window.addEventListener("scroll", away, true);
    return () => {
      window.removeEventListener("mousedown", dismiss, true);
      window.removeEventListener("keydown", key);
      window.removeEventListener("resize", away);
      window.removeEventListener("scroll", away, true);
    };
  }, [onClose]);

  const items: Array<{ id: PageAction; label: string; danger?: boolean }> = [
    { id: "recapture", label: "重新捕获这一页" },
    { id: "explore", label: "从这一页继续往下找" },
    { id: "figma", label: "只把这一页送进 Figma" },
    { id: "drop", label: "从清单里删掉这一页", danger: true }
  ];

  return (
    <div
      className="page-menu"
      ref={box}
      role="menu"
      // Kept inside the window: a card near the right or bottom edge would
      // otherwise open its menu off screen.
      style={{ left: Math.min(at.x, window.innerWidth - 210), top: Math.min(at.y, window.innerHeight - 130) }}
    >
      {items.map((item) => (
        <button
          className={item.danger ? "is-danger" : undefined}
          disabled={busy}
          key={item.id}
          onClick={() => onPick(item.id)}
          role="menuitem"
          type="button"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function PageCard({ page, index, busy, onOpen, onMenu }: {
  page: DiscoveredPage;
  index: number;
  busy: boolean;
  onOpen: (page: DiscoveredPage) => void;
  onMenu: (page: DiscoveredPage, at: { x: number; y: number }) => void;
}) {
  // Variants are the same page re-skinned — dark mode, another language — so
  // they share one card and swap the preview rather than taking a slot each.
  const looks = [{ id: page.id, name: "默认", thumbnail: page.thumbnail }, ...(page.variants ?? [])];
  const [shown, setShown] = useState(0);
  const current = looks[Math.min(shown, looks.length - 1)];

  return (
    <article
      className={`inventory-card${busy ? " is-busy" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(page, { x: event.clientX, y: event.clientY });
      }}
    >
      <button className="inventory-shot" onClick={() => onOpen(page)} type="button">
        {busy && <span className="inventory-shot-busy"><LoaderCircle className="spin" size={18} /></span>}
        {current.thumbnail
          ? <img alt="" src={current.thumbnail.dataUrl} />
          : <span className="inventory-shot-empty">没有预览</span>}
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
  if (!value) return "未扫描";
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return "今天";
  if (days === 1) return "昨天";
  return `${days} 天前`;
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
      <span className={`project-icon is-${target.kind === "folder" ? "web" : "desktop"}${target.icon && !busy ? " has-own" : ""}`}>
        {busy
          ? <LoaderCircle className="spin" size={14} />
          : target.icon
            // The app's own icon, taken from the page it declares it on. A row
            // wearing the placeholder is one that has not been scanned yet.
            ? <img alt="" src={target.icon} />
            : target.kind === "folder" ? <FolderGit2 size={14} /> : <Globe2 size={14} />}
      </span>
      <span className="project-copy">
        <strong>{target.name}</strong>
        <small>
          {busy
            ? "扫描中…"
            : target.pageCount === null
              ? "未扫描"
              : `${target.pageCount} ${target.pageCount === 1 ? "page" : "pages"} · ${whenScanned(target.lastScannedAt)}`}
        </small>
      </span>
      <span className="target-actions">
        <span
          className="icon-button"
          onClick={(event) => { event.stopPropagation(); onRescan(target); }}
          role="button"
          title="重新扫描"
        >
          <RefreshCw size={13} />
        </span>
        <span
          className="icon-button"
          onClick={(event) => { event.stopPropagation(); onForget(target); }}
          role="button"
          title="移出列表"
        >
          <X size={13} />
        </span>
      </span>
    </button>
  );
}

function Sidebar({ entries, activeId, busyIds, onOpen, onRescan, onForget, onAdd, onDropFolder }: {
  entries: Entry[]; activeId: string | null; busyIds: string[];
  onOpen: (target: InventoryTarget) => void;
  onRescan: (target: InventoryTarget) => void;
  onForget: (target: InventoryTarget) => void;
  onAdd: () => void;
  onDropFolder: (event: React.DragEvent) => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // The list of projects is the obvious place to add one to, and unlike the
  // empty state it is on screen whatever else is: once a scan had a result
  // there was nowhere left to drop a folder at all.
  const [over, setOver] = useState(false);
  return (
    <aside
      className={`sidebar${over ? " is-drop-target" : ""}`}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOver(false); }}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        setOver(true);
      }}
      onDrop={(event) => { setOver(false); onDropFolder(event); }}
    >
      {/* The window is hiddenInset with the traffic lights at (18,18), so the
          sidebar has to start below them — the same spacer the older
          interface uses. */}
      <div className="sidebar-drag drag-region" />
      <div className="brand-row">
        <div aria-hidden="true" className="brand-mark"><img alt="" src="./app-icon.png" /></div>
        <span>Crank</span>
      </div>

      <div className="sidebar-section-header">
        <span>项目</span>
        <button aria-label="添加项目" className="icon-button" onClick={onAdd} title="添加项目" type="button">
          <Plus size={15} />
        </button>
      </div>

      <div className="project-list">
        {over && <p className="target-drop">松手即可加入并开始扫描</p>}
        {entries.length === 0 && !over && <p className="target-empty">还没有扫描过任何项目</p>}
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
    { id: page.id, name: "默认", snapshot: page.snapshot, thumbnail: page.thumbnail },
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
          <button onClick={onClose} type="button">关闭</button>
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

  const [title, setTitle] = useState("设计交接");
  const [source, setSource] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [port, setPort] = useState("9222");
  const [choices, setChoices] = useState<WorkspacePackage[] | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [foreign, setForeign] = useState<{ info: ForeignProject; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [recording, setRecording] = useState<DiscoveredPage[] | null>(null);
  const [figmaUrl, setFigmaUrl] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"gallery" | "compact" | "list" | "single">("gallery");
  const [figmaOpen, setFigmaOpen] = useState(false);
  const [menu, setMenu] = useState<{ page: DiscoveredPage; at: { x: number; y: number } } | null>(null);
  const [busyPage, setBusyPage] = useState<string | null>(null);
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
      notify("error", cause instanceof Error ? cause.message : "扫描失败。");
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
      notify("error", cause instanceof Error ? cause.message : "扫描失败。");
    }
  };

  const scanAttached = async () => {
    if (!window.uiSync?.scanAttached) {
      notify("error", "重启 Crank 后可用。这个功能是这次更新加的，正在运行的这份还没有它。");
      return;
    }
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      notify("error", "调试端口填数字，例如 9222。");
      return;
    }
    beginScan(`debug:${number}`);
    try {
      const inventory = await window.uiSync.scanAttached(number);
      if ((inventory as { id?: string }).id) setActiveId((inventory as { id?: string }).id!);
      finishScan(inventory);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : "连不上这个端口。确认应用带 --remote-debugging-port 启动了。");
    }
  };

  const startRecording = async () => {
    if (!window.uiSync?.startRecording) return;
    const target = address.trim() || (result?.ok ? result.origin : "");
    if (!target) { notify("error", "先填上要记录的地址。"); return; }
        const outcome = await window.uiSync.startRecording(target);
    if (!outcome.ok) { notify("error", outcome.message ?? "没能开始记录。"); return; }
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

  const sendToFigma = async (only?: DiscoveredPage[]) => {
    if (!result?.ok || !window.uiSync?.sendInventoryToFigma) return;
        try {
      const outcome = await window.uiSync.sendInventoryToFigma(
        { origin: result.origin, source: result.source, pages: only ?? result.pages },
        figmaUrl.trim()
      );
      if (!outcome.ok || !outcome.pairingCode) { notify("error", outcome.message ?? "没能准备这次导出。"); return; }
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
      notify("error", cause instanceof Error ? cause.message : "没能送进 Figma。");
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
        if (!cancelled) setFigmaStatus({ state: "error", message: cause instanceof Error ? cause.message : "读不到这次同步的状态。" });
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

  /**
   * Says why a per-page action cannot run, instead of doing nothing.
   *
   * The bridge is built when the window opens, so a UI Sync left running while
   * it was updated has the new menu but not the calls behind it — the interface
   * hot-reloads, the main process does not. A menu item that quietly does
   * nothing reads as a broken feature rather than a stale window.
   */
  const bridge = <K extends "recapturePage" | "explorePage" | "dropPage">(method: K) => {
    if (!window.uiSync) {
      notify("error", "这个动作要在 Crank 应用里才能用。");
      return null;
    }
    const call = window.uiSync[method];
    if (!call) {
      notify("error", "重启 Crank 后可用。这个功能是这次更新加的，正在运行的这份还没有它。");
      return null;
    }
    return call;
  };

  /** What the scan is of, which is what every per-page action acts on. */
  const sourceOf = (): { kind: "folder" | "url"; target: string } | null => {
    if (!result?.ok) return null;
    if (result.source) return result.source;
    // A scan kept from before the source was recorded still has its origin.
    return source ? { kind: source.startsWith("http") ? "url" : "folder", target: source } : null;
  };

  const recapture = async (page: DiscoveredPage) => {
    const where = sourceOf();
    const call = bridge("recapturePage");
    if (!call) return;
    if (!where) { notify("error", "这一页还不知道属于哪个项目。重新扫描一次即可。"); return; }
    setBusyPage(page.id);
    try {
      const outcome = await call(where, page);
      if (!outcome.ok || !outcome.page) {
        notify("error", outcome.message ?? "这一页没能重新捕获。");
        return;
      }
      const fresh = outcome.page;
      setResult((current) => (current?.ok
        ? { ...current, pages: current.pages.map((entry) => (entry.id === fresh.id ? fresh : entry)) }
        : current));
      setFocused((current) => (current?.id === fresh.id ? fresh : current));
      notify("done", `「${fresh.name}」已重新捕获。`);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : "这一页没能重新捕获。");
    } finally {
      setBusyPage(null);
    }
  };

  const explore = async (page: DiscoveredPage) => {
    const where = sourceOf();
    const call = bridge("explorePage");
    if (!call) return;
    if (!where || !result?.ok) { notify("error", "这一页还不知道属于哪个项目。重新扫描一次即可。"); return; }
    setBusyPage(page.id);
    try {
      const held = result.pages.map((entry) => ({ id: entry.id, route: entry.route, url: entry.url }));
      const outcome = await call(where, page, held);
      if (!outcome.ok) {
        notify("error", outcome.message ?? "从这一页往下没走通。");
        return;
      }
      const found = outcome.pages ?? [];
      if (found.length === 0) {
        // "没有找到内容" and "nothing on this page responds" look the same
        // from outside, and only the second is worth acting on.
        const dead = outcome.inert?.length ?? 0;
        notify("done", dead > 0
          ? `「${page.name}」上的 ${dead} 个控件都没有反应，这条路走不下去。`
          : `「${page.name}」后面没有别的页面了。`);
        return;
      }
      setResult((current) => {
        if (!current?.ok) return current;
        const seen = new Set(current.pages.map((entry) => entry.id));
        return { ...current, pages: [...current.pages, ...found.filter((entry) => !seen.has(entry.id))] };
      });
      notify("done", `从「${page.name}」往下又找到 ${found.length} 个页面。`);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : "从这一页往下没走通。");
    } finally {
      setBusyPage(null);
    }
  };

  const sendOnePage = async (page: DiscoveredPage) => {
    if (!result?.ok) return;
    if (!figmaUrl.trim()) {
      // Nowhere to send it yet. Open the field rather than refusing.
      setFigmaOpen(true);
      notify("error", "先填上要送进去的 Figma 文件地址。");
      return;
    }
    await sendToFigma([page]);
  };

  const dropPage = async (page: DiscoveredPage) => {
    const where = sourceOf();
    const call = bridge("dropPage");
    if (!call) return;
    if (!where) { notify("error", "这一页还不知道属于哪个项目。重新扫描一次即可。"); return; }
    await call(where, page.id);
    setResult((current) => (current?.ok
      ? { ...current, pages: current.pages.filter((entry) => entry.id !== page.id) }
      : current));
    setFocused((current) => (current?.id === page.id ? null : current));
    notify("done", `已从清单里删掉「${page.name}」，以后扫描也不会再出现。`);
  };

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
    else notify("error", "请拖入一个项目文件夹。");
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
        title.trim() || "设计交接"
      );
      if (outcome.saved && outcome.filePath) notify("done", "交接页已保存", outcome.filePath);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : "The page could not be saved.");
    }
  };

  const pages = result?.ok ? result.pages : [];
  const reskins = pages.reduce((total, page) => total + (page.variants?.length ?? 0), 0);
  // One page found, and every control on it did nothing. A scan that says only
  // "1 page" reads as a one-page app; it is worth saying which of the two it is.
  const stalled = Boolean(result?.ok && pages.length === 1 && (result.inert?.length ?? 0) > 0);
  // Where the project lives, when it is a folder. A scanned address stays an
  // address — that one is the user's own server and is still up.
  const scannedFolder = result?.ok
    ? result.source?.kind === "folder"
      ? result.source.target
      : source?.startsWith("/") ? source : null
    : null;
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
        onDropFolder={onDrop}
        onForget={(target) => void forget(target)}
        onOpen={(target) => void openSaved(target)}
        onRescan={rescan}
      />
    <main className="inventory-page">
      {choices && !activeJob && (
        <section className="inventory-choices">
          <strong>这是一个工作区，里面有 {choices.length} 个能单独跑起来的项目</strong>
          <p>
            工作区本身没有界面可扫——它的 dev 脚本是把活分给下面的包。这些项目已经加进左边的列表，
            选一个现在就扫。
          </p>
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
            <h1>把项目文件夹拖进来</h1>
            <p>Crank 会把它跑起来，走遍每一个页面，交给你一份可编辑的图层。</p>
            <button className="primary-button" onClick={() => void chooseFolder()} type="button">选择文件夹</button>
          </div>

          <ol className="onboarding-steps">
            <li>
              <strong>识别并启动</strong>
              <span>npm 和 pnpm 项目读它自己的 dev 脚本。Electron 只启动界面，不会弹出窗口。Python、Ruby 这类项目读 Dockerfile、Procfile 或 README 里已经写好的命令。</span>
            </li>
            <li>
              <strong>走遍每个页面</strong>
              <span>路由、标签页、弹层各算一个页面。深色模式和切换语言不算新页面，会并进同一页的不同外观。</span>
            </li>
            <li>
              <strong>拿走结果</strong>
              <span>导出一份自带图片的 HTML 交接页，或者把图层直接送进 Figma。</span>
            </li>
          </ol>

          <div className="onboarding-alt">
            <button className="inventory-link" onClick={() => void startRecording()} type="button">
              有些页面要登录或填表单才能到达？你点一遍，我来记录
            </button>
            <button className="inventory-link" onClick={() => setShowAddress((value) => !value)} type="button">
              {showAddress ? "收起" : "项目已经跑起来了？直接扫它的地址"}
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
                  aria-label="额外路径"
                  onChange={(event) => setSeeds(event.target.value)}
                  placeholder="额外路径，可选，例如 /?view=settings"
                  value={seeds}
                />
                <button disabled={!address.trim()} type="submit">开始扫描</button>
              </form>
            )}
            <button className="inventory-link" onClick={() => setShowAttach((value) => !value)} type="button">
              {showAttach ? "收起" : "界面里空空的，数据在别处？连上你正在运行的那个应用"}
            </button>
            {showAttach && (
              <form className="inventory-form" onSubmit={(event) => { event.preventDefault(); void scanAttached(); }}>
                <p className="inventory-note">
                  单独启动界面只能拿到空壳,数据在你正在运行的那个进程里。照常启动应用并加一个调试端口,
                  Crank 会连过去扫那一个真实窗口,不另开应用。
                  <code>npx electron . --remote-debugging-port=9222</code>
                </p>
                <input
                  aria-label="调试端口"
                  onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
                  placeholder="9222"
                  value={port}
                />
                <button disabled={!port.trim()} type="submit">连上去扫</button>
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
          <strong>正在记录——请在另一个窗口里操作你的应用</strong>
          <p>
            你到达的每一个页面都会被记录下来。登录、填表单、打开你在意的那些界面都可以，
            记录期间不拦截任何操作。
          </p>
          <div className="inventory-recorded">
            {recording.length === 0
              ? <span>还没有记录到页面</span>
              : recording.map((page) => <span key={page.id}>{page.name}</span>)}
          </div>
          <button className="inventory-export" onClick={() => void stopRecording()} type="button">
            结束记录，保留 {recording.length} 个页面
          </button>
        </section>
      )}


      {result?.ok && (
        <>
          <header className="project-header">
            <div className="project-header-copy">
              <h1>{source?.split("/").filter(Boolean).pop() ?? result.origin}</h1>
              <div className="connection-line">
                {/* Not the origin it was served on: a folder is served on a
                    throwaway port that is already closed by the time this is on
                    screen, so showing it named something that no longer exists.
                    A folder shows where it lives and opens there. */}
                {scannedFolder ? (
                  <button
                    className="connection-path"
                    onClick={() => void window.uiSync?.revealFile?.(scannedFolder)}
                    title={`${scannedFolder} — 在访达中显示`}
                    type="button"
                  >
                    <FolderGit2 size={13} />
                    <span>{scannedFolder.split("/").filter(Boolean).pop()}</span>
                  </button>
                ) : (
                  <><Globe2 size={13} /><span>{result.origin}</span></>
                )}
                <span className="header-sep">·</span>
                <span>{pages.length} 个页面</span>
                {result.sources.sitemap > 0 && <span className="header-sep">· {result.sources.sitemap} 个来自 sitemap</span>}
                {result.sources.crawled > 0 && <span className="header-sep">· {result.sources.crawled} 个靠点击找到</span>}
                {reskins > 0 && <span className="header-sep">· {reskins} 个外观已并入所属页面</span>}
              </div>
            </div>
            <div className="project-header-actions">
              <button
                aria-label="重新扫描"
                className="secondary-button project-refresh-button"
                onClick={() => { if (source) source.startsWith("http") ? void scan(source) : void scanFolder(source); }}
                title="重新扫描"
                type="button"
              >
                <RefreshCw size={14} />
              </button>
              <button className="secondary-button" onClick={() => void exportPage()} type="button">
                <Download size={14} /> 保存交接页
              </button>
              <button className="secondary-button" onClick={() => setFigmaOpen((value) => !value)} type="button">
                <Figma size={14} /> 送进 Figma
              </button>
            </div>
          </header>

          {stalled && (
            <section className="inventory-stalled">
              <p>
                <strong>只扫到一页：界面在跑，数据不在。</strong>
                {" "}这一页是真的。其余部分没有出现，是因为界面被单独启动了——它依赖的进程没跟着跑，
                Electron 拿不到 preload，前端拿不到后端接口，所以每一屏都是空的。
              </p>
              {/* No launch command here. The one that used to be printed only
                  worked for a bare `electron .`; a project built with
                  electron-vite, Forge or a custom script fails on it outright,
                  and a command that does not run is worse than none. This line
                  goes in the app's own code, so how it is launched stops
                  mattering. */}
              <p className="inventory-note">
                要扫到真实内容，Crank 需要连上你自己跑着的那个应用，而它得开着调试端口。
                在主进程里加一行，放在 <code>app.whenReady()</code> 之前：
              </p>
              <pre className="inventory-snippet">app.commandLine.appendSwitch("remote-debugging-port", "9222");</pre>
              <p className="inventory-note">
                不论项目用 electron-vite、Forge 还是自己的启动脚本，这一行都有效。照常启动应用，
                然后在这里填端口。扫完想删掉也可以。
              </p>
              <form className="inventory-form" onSubmit={(event) => { event.preventDefault(); void scanAttached(); }}>
                <input
                  aria-label="调试端口"
                  onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
                  placeholder="9222"
                  value={port}
                />
                <button disabled={!port.trim()} type="submit">连接并重新扫描</button>
              </form>
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
                aria-label="Figma 文件地址"
                onChange={(event) => setFigmaUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void sendToFigma(); }}
                placeholder="粘贴要送进去的 Figma 文件地址"
                value={figmaUrl}
              />
              <button className="secondary-button" disabled={!figmaUrl.trim()} onClick={() => void sendToFigma()} type="button">
                送进 {pages.length} 个页面
              </button>
            </div>
          )}

          <div className="inventory-toolbar">
            <span className="view-switch">
              {([["gallery", "大图"], ["compact", "紧凑"], ["list", "列表"], ["single", "单页"]] as const).map(([id, label]) => (
                <button aria-pressed={view === id} key={id} onClick={() => setView(id)} type="button">{label}</button>
              ))}
            </span>
            {leftOut > 0 && (
              <button className="inventory-link" onClick={() => setShowFiltered((value) => !value)} type="button">
                {showFiltered ? "收起" : "查看"}没有收进来的 {leftOut} 项
              </button>
            )}
          </div>

          {showFiltered && (
            <section className="inventory-filtered">
              {result.filtered.length > 0 && (
                <>
                  <p>改动太小，没有算作一个页面：</p>
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
                  <p>点下去没有反应，页面没有变化：</p>
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
                  没有点击，因为这些按钮看起来会造成破坏：{result.skipped.map((item) => `「${item.label}」`).join(" ")}
                </p>
              )}
            </section>
          )}

          {view === "list" ? (
            <ul className="inventory-rows">
              {pages.map((page, index) => (
                <li
                  className={busyPage === page.id ? "is-busy" : undefined}
                  key={page.id}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ page, at: { x: event.clientX, y: event.clientY } });
                  }}
                >
                  <button onClick={() => setFocused(page)} type="button">
                    <span className="inventory-index">{String(index + 1).padStart(2, "0")}</span>
                    <span className="inventory-row-name">{page.name}</span>
                    {(page.variants?.length ?? 0) > 0 && (
                      <span className="inventory-row-variants">{page.variants.length} 种外观</span>
                    )}
                    <code>{addressOf(page)}</code>
                    {busyPage === page.id && <LoaderCircle className="spin" size={13} />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={`inventory-grid${view === "compact" ? " is-compact" : ""}${view === "single" ? " is-single" : ""}`}>
              {pages.map((page, index) => (
                <PageCard
                  busy={busyPage === page.id}
                  index={index}
                  key={page.id}
                  onMenu={(target, at) => setMenu({ page: target, at })}
                  onOpen={setFocused}
                  page={page}
                />
              ))}
            </div>
          )}
        </>
      )}

      {menu && (
        <PageMenu
          at={menu.at}
          busy={busyPage !== null}
          onClose={() => setMenu(null)}
          onPick={(action) => {
            const { page } = menu;
            setMenu(null);
            if (action === "recapture") void recapture(page);
            else if (action === "explore") void explore(page);
            else if (action === "figma") void sendOnePage(page);
            else void dropPage(page);
          }}
        />
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
                  在访达中显示
                </button>
              )}
              <button aria-label="关闭" className="toast-close" onClick={() => dismiss(toast.id)} type="button">
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
