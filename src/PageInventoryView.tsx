import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AppWindowMac, Check, ChevronRight, Download, Figma, FolderGit2, Globe2, Languages, LoaderCircle, Play, Plus, RefreshCw, Smartphone, Square, X } from "lucide-react";
import { FigmaPluginPanel } from "./FigmaPluginPanel";
import { FigmaSyncDialog } from "./FigmaSyncDialog";
import { PageLayers } from "./PageLayers";
import type { AutomaticMappingStatus, DiscoveredPage, FigmaBuildProgress, FigmaConnection, FigmaTree, InventoryGroup, InventoryTarget, PageInventory, ScanLifecycle, ScanProgress, ScanStatus, WorkspacePackage, ForeignProject } from "./types";
import { useLocale, useT, type Translate } from "./lib/locale";

/**
 * The whole product in one screen: give an address, get every page.
 *
 * Deliberately stack-agnostic — the address may be a Vite dev server, a Python
 * app, a static folder or an Electron renderer served over http.
 */

function addressOf(page: DiscoveredPage, t: Translate): string {
  // An exported iOS page has no address. Saying where it came from is the
  // useful thing to put in its place.
  if (page.vector) {
    return page.vector.sourceName
      ? t("inventory.exportedFrom", { view: page.vector.sourceName })
      : t("inventory.exportedPage");
  }
  if (page.recipe.length === 0) return page.route;
  const steps = page.recipe.map((step) => t("inventory.recipeStep", {
    label: `${t("common.quoteOpen")}${step.label || step.locator}${t("common.quoteClose")}`
  })).join(" → ");
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
  missingReasons?: string[];
  dropped?: string[];
  substitutedFonts?: string[];
};

/** What will not arrive, said before the sync claims to be complete. */
function shortfall(session: FigmaExportSession, t: Translate): string | null {
  const parts: string[] = [];
  if (session.missing?.length) {
    const named = session.missing.slice(0, 4).join(t("common.separator") === ", " ? ", " : "、");
    // Why, not only how many: the count is visible on screen already.
    const why = session.missingReasons?.length ? t("inventory.shortfallReasons", { reasons: session.missingReasons.slice(0, 2).join(t("common.separator") === ", " ? "; " : "；") }) : "";
    parts.push(t("inventory.shortfallMissing", {
      count: session.missing.length,
      pages: session.missing.length === 1 ? t("common.page") : t("common.pages"),
      names: named,
      truncated: session.missing.length > 4 ? t("common.etc") : "",
      reasons: why
    }));
  }
  if (session.dropped?.length) {
    parts.push(t("inventory.shortfallDropped", { count: session.dropped.length, pages: session.dropped.length === 1 ? t("common.page") : t("common.pages") }));
  }
  if (session.substitutedFonts?.length) {
    // Not a shortfall in what arrives — every layer is sent. It changes who
    // decided where the lines fall, which is worth knowing before the result
    // is compared against the browser.
    parts.push(t("inventory.shortfallFonts", { fonts: session.substitutedFonts.join(t("common.separator")) }));
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
function PageMenu({ at, busy, exported, onPick, onClose }: {
  at: { x: number; y: number };
  busy: boolean;
  /** An exported iOS page: no address, so nothing that reloads one applies. */
  exported?: boolean;
  onPick: (action: PageAction) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const t = useT();

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

  // Recapturing and exploring both mean loading an address in a browser, which
  // an exported iOS page does not have. They are left out rather than offered
  // and then refused.
  const items: Array<{ id: PageAction; label: string; danger?: boolean }> = [
    ...(exported ? [] : [
      { id: "recapture" as const, label: t("inventory.menuRecapture") },
      { id: "explore" as const, label: t("inventory.menuExplore") }
    ]),
    { id: "figma", label: t("inventory.menuImport") },
    { id: "drop", label: t("inventory.menuDelete"), danger: true }
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

/**
 * One page, drawn from its layers by this app rather than embedded as a
 * document of its own.
 *
 * A thumbnail is 420px wide and turns to mud at full width. Embedding the
 * captured markup fixed that but meant a whole foreign document per page — and
 * it showed the browser's rendering, not the layers about to reach Figma, so
 * anything the capture missed still looked perfect here. Drawing the layer tree
 * shows the deliverable, and the same renderer serves every project.
 *
 * Mounted only once near the viewport: this view has thirty pages in one
 * scroll, and the thumbnail stands in until then.
 */
/**
 * Draws a captured page's layers at whatever width there is room for.
 *
 * The layers sit at the pixel positions they were captured at, which is wider
 * than the pane they are shown in. Scaling the whole drawing keeps every
 * position true to the capture, and because it is a transform rather than a
 * resize, text stays text — sharp at any zoom instead of a blurry picture of
 * itself.
 */
function ScaledLayers({ layerTree, lazy = false, selectable = false, fallback }: {
  layerTree: FigmaTree | null | undefined;
  /** Wait until the drawing is nearly on screen. A grid of them is expensive. */
  lazy?: boolean;
  /** Let the text be selected — for a page opened on its own, not for a card. */
  selectable?: boolean;
  fallback: ReactNode;
}) {
  const holder = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(!lazy);
  const [scale, setScale] = useState(0);
  const captureWidth = layerTree?.width || 1220;

  useEffect(() => {
    const element = holder.current;
    if (!element) return;
    const sizer = new ResizeObserver(([entry]) => {
      if (entry) setScale(entry.contentRect.width / captureWidth);
    });
    sizer.observe(element);
    if (!lazy) return () => sizer.disconnect();
    const watcher = new IntersectionObserver(
      (entries) => { if (entries.some((entry) => entry.isIntersecting)) setNear(true); },
      { rootMargin: "600px 0px" }
    );
    watcher.observe(element);
    return () => { watcher.disconnect(); sizer.disconnect(); };
  }, [captureWidth, lazy]);

  // A transform does not change how much room the element asks for, so the
  // holder is told the drawn height or it keeps the unscaled one.
  const height = (layerTree?.height || 790) * scale;
  return (
    <div
      className={`page-document${selectable ? " is-selectable" : ""}`}
      ref={holder}
      style={{ height: height > 0 ? height : undefined }}
    >
      {near && layerTree?.tree ? (
        <div className="page-layers-frame" style={{ transform: `scale(${scale})` }}>
          <PageLayers height={layerTree.height} tree={layerTree.tree} width={captureWidth} />
        </div>
      ) : fallback}
    </div>
  );
}

function PageDocument({ page }: { page: DiscoveredPage }) {
  const t = useT();
  // A page without layers is only ever its picture, and the picture keeps its
  // own proportions rather than the ones a layer drawing would have asked for.
  if (!page.layerTree?.tree) {
    return page.thumbnail
      ? <img alt="" src={page.thumbnail.dataUrl} />
      : <span className="inventory-shot-empty">{t("inventory.previewUnavailable")}</span>;
  }
  return <ScaledLayers fallback={null} layerTree={page.layerTree} lazy />;
}

/**
 * Whether a page is shaped like a phone held upright. An exported iOS page says
 * so in its own size; a captured web page is judged by the picture taken of it.
 */
function isPhonePortrait(page: DiscoveredPage) {
  const size = page.vector ?? page.thumbnail;
  return size ? size.height > size.width * 1.3 : false;
}

/**
 * The shape to hold a phone page in: the page's own, never a stand-in for it.
 * A frame even slightly off the picture's proportions shows as white bars along
 * the edges of every card.
 */
function phonePortraitShape(page: DiscoveredPage, picture?: { width: number; height: number } | null) {
  const size = page.vector ?? picture ?? page.thumbnail;
  return isPhonePortrait(page) && size ? { aspectRatio: `${size.width} / ${size.height}` } : null;
}

function PageCard({ page, index, busy, single, onOpen, onMenu }: {
  page: DiscoveredPage;
  index: number;
  busy: boolean;
  single?: boolean;
  onOpen: (page: DiscoveredPage) => void;
  onMenu: (page: DiscoveredPage, at: { x: number; y: number }) => void;
}) {
  const t = useT();
  // Variants are the same page re-skinned — dark mode, another language — so
  // they share one card and swap the preview rather than taking a slot each.
  const looks = [{ id: page.id, name: t("inventory.defaultLook"), thumbnail: page.thumbnail }, ...(page.variants ?? [])];
  const [shown, setShown] = useState(0);
  const current = looks[Math.min(shown, looks.length - 1)];
  const portrait = single ? null : phonePortraitShape(page, current.thumbnail);

  return (
    <article
      className={`inventory-card${busy ? " is-busy" : ""}${portrait ? " is-portrait" : ""}`}
      onContextMenu={(event) => {
        event.preventDefault();
        onMenu(page, { x: event.clientX, y: event.clientY });
      }}
    >
      <button
        className={`inventory-shot${portrait ? " is-portrait" : ""}`}
        onClick={() => onOpen(page)}
        style={portrait ?? undefined}
        type="button"
      >
        {busy && <span className="inventory-shot-busy"><LoaderCircle className="spin" size={18} /></span>}
        {single
          ? <PageDocument page={page} />
          : current.thumbnail
            ? <img alt="" src={current.thumbnail.dataUrl} />
            : <span className="inventory-shot-empty">{t("inventory.previewUnavailable")}</span>}
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
      <p className="inventory-address" title={addressOf(page, t)}>{addressOf(page, t)}</p>
    </article>
  );
}


type Entry = InventoryTarget | InventoryGroup;

const isGroup = (entry: Entry): entry is InventoryGroup => entry.kind === "group";

function whenScanned(value: string | null, t: Translate): string {
  if (!value) return t("inventory.statusNotScanned");
  const days = Math.floor((Date.now() - new Date(value).getTime()) / 86_400_000);
  if (days <= 0) return t("inventory.today");
  if (days === 1) return t("inventory.yesterday");
  return t("inventory.daysAgo", { days });
}

/** An installed app is a folder on disk, and the one folder that is not a project. */
const isAppBundle = (target: string) => target.replace(/\/+$/, "").toLowerCase().endsWith(".app");

function TargetRow({ target, active, busy, onOpen, onRescan, onForget, nested }: {
  target: InventoryTarget; active: boolean; busy?: boolean; nested?: boolean;
  onOpen: (target: InventoryTarget) => void;
  onRescan: (target: InventoryTarget) => void;
  onForget: (target: InventoryTarget) => void;
}) {
  const t = useT();
  return (
    <button
      className={`project-item ${active ? "is-active" : ""}${nested ? " is-nested" : ""}`}
      onClick={() => onOpen(target)}
      title={target.target}
      type="button"
    >
      <span className={`project-icon is-${target.kind === "folder" ? "web" : "desktop"}${target.icon ? " has-own" : ""}${busy ? " is-busy" : ""}`}>
        {target.icon
          // The app's own icon, or the one its page declares. An installed app
          // has one before it has been scanned, so the row wears it through the
          // scan too — with the ring around it saying the scan is still running.
          ? <img alt="" src={target.icon} />
          : busy
            ? <LoaderCircle className="spin" size={14} />
            : target.kind !== "folder"
              ? <Globe2 size={14} />
              // An app that was built and run rather than served: a phone says
              // that much even before its own icon has been read.
              : target.platform === "swiftui"
                ? <Smartphone size={14} />
                : isAppBundle(target.target) ? <AppWindowMac size={14} /> : <FolderGit2 size={14} />}
      </span>
      <span className="project-copy">
        <strong>{target.name}</strong>
        <small>
          {busy
            ? t("inventory.statusScanning")
            : target.pageCount === null
              ? t("inventory.statusNotScanned")
              : t("inventory.rowMeta", {
                count: target.pageCount,
                unit: target.pageCount === 1 ? t("common.page") : t("common.pages"),
                when: whenScanned(target.lastScannedAt, t)
              })}
        </small>
      </span>
      <span className="target-actions">
        <span
          className="icon-button"
          onClick={(event) => { event.stopPropagation(); onRescan(target); }}
          role="button"
          title={t("inventory.actions.rescan")}
        >
          <RefreshCw size={13} />
        </span>
        <span
          className="icon-button"
          onClick={(event) => { event.stopPropagation(); onForget(target); }}
          role="button"
          title={t("inventory.forget")}
        >
          <X size={13} />
        </span>
      </span>
    </button>
  );
}

/**
 * The language, in a bubble off the bar at the bottom.
 *
 * There is only room down there for one line, so the two options live behind
 * the button rather than beside it. Their labels stay in their own language
 * whichever one is active — the point of the row is to be readable by someone
 * who cannot read the interface as it stands.
 */
function LanguageBubble() {
  const { locale, setLocale } = useLocale();
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrap.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className="bubble-wrap" ref={wrap}>
      <button
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("sidebar.language")}
        className={`icon-button sidebar-bar-button${open ? " is-open" : ""}`}
        onClick={() => setOpen((current) => !current)}
        title={t("sidebar.language")}
        type="button"
      >
        <Languages size={15} />
      </button>
      {open && (
        <div className="sidebar-bubble" role="menu">
          <div className="bubble-heading">{t("sidebar.language")}</div>
          {([["en", "English"], ["zh-CN", "中文"]] as const).map(([id, label]) => (
            <button
              aria-checked={locale === id}
              className={locale === id ? "is-on" : ""}
              key={id}
              onClick={() => { setLocale(id); setOpen(false); }}
              role="menuitemradio"
              type="button"
            >
              <span>{label}</span>
              {locale === id && <Check size={14} />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Sidebar({ entries, activeId, busyIds, figmaConnected, onOpen, onRescan, onForget, onAdd, onDropFolder, onOpenPlugin }: {
  entries: Entry[]; activeId: string | null; busyIds: string[];
  figmaConnected: boolean | null;
  onOpen: (target: InventoryTarget) => void;
  onRescan: (target: InventoryTarget) => void;
  onForget: (target: InventoryTarget) => void;
  onAdd: () => void;
  onDropFolder: (event: React.DragEvent) => void;
  onOpenPlugin: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // The list of projects is the obvious place to add one to, and unlike the
  // empty state it is on screen whatever else is: once a scan had a result
  // there was nowhere left to drop a folder at all.
  const [over, setOver] = useState(false);
  const t = useT();
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

      {/* The name of the app and the one thing you do to the list beneath it,
          on a single line. The list used to carry its own "Projects" heading as
          well; between the name above and the bar below there is nothing else
          it could be. */}
      <div className="sidebar-head">
        <div aria-hidden="true" className="brand-mark"><img alt="" src="./app-icon.png" /></div>
        <span className="sidebar-title">Crank</span>
        <button aria-label={t("sidebar.addProject")} className="icon-button" onClick={onAdd} title={t("sidebar.addProject")} type="button">
          <Plus size={16} />
        </button>
      </div>

      {/* Everything between the two fixed ends scrolls, however many projects
          there are, and the head and the bar stay put. */}
      <div className="project-list">
        {over && <p className="target-drop">{t("sidebar.dropTarget")}</p>}
        {entries.length === 0 && !over && <p className="target-empty">{t("sidebar.empty")}</p>}
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

      {/* One line for the two things that belong to the app rather than to any
          one project: the Figma connection, which is worth a whole row because
          the dot answers "is this connected?" at a glance, and the language,
          which is worth a button. Both used to be stacked rows and cost the
          list two projects' worth of height. */}
      <div className="sidebar-bar">
        <button
          className="sidebar-chip"
          onClick={onOpenPlugin}
          type="button"
          {...(figmaConnected === null ? {} : {
            // The dot is the state; spelling it out as well cost the label
            // half the line and truncated it to "Figma …". The words are on
            // the pointer and in the panel the row opens.
            title: `${t("sidebar.figmaPlugin")} — ${figmaConnected ? t("common.connected") : t("common.notConnected")}`
          })}
        >
          <span className={`connection-dot${figmaConnected ? " is-on" : ""}`} />
          <Figma size={13} />
          <span className="sidebar-chip-copy">{t("sidebar.figmaPlugin")}</span>
        </button>
        <LanguageBubble />
      </div>
    </aside>
  );
}

/**
 * One page, as close to the real thing as this machine can get.
 *
 * First choice is the project's own page: it is still on disk, so it can be
 * served and opened, and then the fonts, the ::before, the hover and the
 * animation are simply right rather than approximated. Everything stored about
 * a page is an approximation of some size, and this is the moment those
 * differences show.
 *
 * The capture is what is left when that is impossible — the folder moved, the
 * address is down, or the project is an installed app.
 */
function PageOverlay({ page, targetId, onClose }: {
  page: DiscoveredPage;
  targetId: string | null;
  onClose: () => void;
}) {
  const t = useT();
  const looks = [
    { id: page.id, layerTree: page.layerTree, name: t("inventory.defaultLook"), snapshot: page.snapshot, thumbnail: page.thumbnail },
    ...(page.variants ?? [])
  ];
  const [shown, setShown] = useState(0);
  const current = looks[Math.min(shown, looks.length - 1)];
  const stage = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<{ state: "opening" | "open" | "unavailable"; missed?: string[]; why?: string }>(
    { state: "opening" }
  );
  // Only the page as it was found can be opened live. A re-skinned look is a
  // click away from it, and clicking is exactly what the recipe already does —
  // but the second look has no recipe of its own, so it stays a capture.
  // An exported iOS page cannot be opened live either: there is no address to
  // load and no browser to load it in.
  const liveWanted = shown === 0 && targetId !== null && !page.vector;
  // Opened, a phone page keeps its own proportions rather than being poured
  // into a landscape frame that leaves it a stripe down the middle.
  const portrait = phonePortraitShape(page, current.thumbnail);

  useEffect(() => {
    if (!liveWanted) {
      setLive({ state: "unavailable", why: page.vector ? t("inventory.exportedPageOnly") : t("inventory.variantCaptureOnly") });
      return;
    }
    const bridge = window.uiSync;
    if (!bridge) return;
    let dropped = false;
    const measure = () => {
      const box = stage.current?.getBoundingClientRect();
      return box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null;
    };

    setLive({ state: "opening" });
    void (async () => {
      const bounds = measure();
      if (!bounds) return;
      const opened = await bridge.openPagePreview(targetId, { recipe: page.recipe, route: page.route }, bounds)
        .catch((cause: unknown) => ({ message: cause instanceof Error ? cause.message : t("inventory.openFailed"), ok: false as const }));
      if (dropped) return;
      setLive(opened.ok
        ? { missed: "missed" in opened ? opened.missed ?? [] : [], state: "open" }
        : { state: "unavailable", why: opened.message });
    })();

    // The preview is a native view laid over the window, so it does not move
    // with the page on its own — it has to be told where the hole is.
    const follow = () => { const bounds = measure(); if (bounds) void bridge.setPagePreviewBounds(bounds); };
    const watcher = new ResizeObserver(follow);
    if (stage.current) watcher.observe(stage.current);
    window.addEventListener("resize", follow);
    window.addEventListener("scroll", follow, true);
    return () => {
      dropped = true;
      watcher.disconnect();
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow, true);
      void bridge.closePagePreview();
    };
  }, [liveWanted, page.id, page.route, page.recipe, targetId]);

  return (
    <div className="inventory-overlay" onClick={onClose} role="presentation">
      <figure onClick={(event) => event.stopPropagation()} role="presentation">
        <figcaption>
          <strong>{page.name}</strong>
          <code>{addressOf(page, t)}</code>
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
          <button onClick={onClose} type="button">{t("common.close")}</button>
        </figcaption>
        {live.state !== "unavailable" ? (
          // Left empty on purpose: the real page is a native view sitting over
          // this hole, so anything drawn here would be behind it.
          <div className={`inventory-frame is-live${portrait ? " is-portrait" : ""}`} ref={stage} style={portrait ?? undefined}>
            {live.state === "opening" && <p className="inventory-shot-empty">{t("inventory.livePlaceholder")}</p>}
          </div>
        ) : current.snapshot?.html
          ? (
            <iframe
              className={`inventory-frame${portrait ? " is-portrait" : ""}`}
              sandbox=""
              srcDoc={current.snapshot.html}
              style={portrait ?? undefined}
              title={page.name}
            />
          )
          : current.layerTree?.tree
            ? (
              <div className={`inventory-frame${portrait ? " is-portrait" : ""}`} style={portrait ?? undefined}>
                <ScaledLayers fallback={null} layerTree={current.layerTree} selectable />
              </div>
            )
            // Without layers there is only the picture, and it is the whole
            // frame: wrapping it in a drawing holder sized for layers left it a
            // stamp in the corner of an empty sheet.
            : current.thumbnail
              ? (
                <img
                  alt=""
                  className={`inventory-frame${portrait ? " is-portrait" : ""}`}
                  src={current.thumbnail.dataUrl}
                  style={portrait ?? undefined}
                />
              )
              : (
                <div className={`inventory-frame${portrait ? " is-portrait" : ""}`} style={portrait ?? undefined}>
                  <p className="inventory-shot-empty">{t("inventory.unavailable")}</p>
                </div>
              )}
        {/* Which of the three is on screen, said rather than left to be guessed:
            they differ, and knowing which one you are looking at is the whole
            point of having more than one. */}
        {live.state === "open" && (live.missed?.length ?? 0) > 0 && (
          <p className="inventory-frame-note">
            {t("inventory.liveMissed", { what: live.missed?.join(t("common.separator")) ?? "" })}
          </p>
        )}
        {live.state === "unavailable" && (
          <p className="inventory-frame-note">
            {t("inventory.liveShows", {
              why: live.why ?? t("inventory.liveUnavailable"),
              what: current.snapshot?.html ? t("inventory.liveWhatCaptured") : t("inventory.liveWhatLayers")
            })}
          </p>
        )}
        {(current.snapshot?.stats?.rasterised?.length ?? 0) > 0 && live.state === "unavailable" && (
          <p className="inventory-frame-note">
            {t("inventory.rasterisedNote", {
              count: current.snapshot?.stats.rasterised.length ?? 0,
              unit: t("inventory.rasterUnit"),
              names: current.snapshot?.stats.rasterised.join(t("common.separator")) ?? ""
            })}
          </p>
        )}
        {current.layerTree?.error && live.state === "unavailable" && !current.snapshot?.html && (
          <p className="inventory-frame-note">{t("inventory.layerTreeError", { error: current.layerTree.error })}</p>
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

  const t = useT();
  const [title, setTitle] = useState(t("inventory.handoffDefault"));
  const [source, setSource] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
  const [showAttach, setShowAttach] = useState(false);
  const [port, setPort] = useState("9222");
  const [choices, setChoices] = useState<WorkspacePackage[] | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState<string | null>(null);
  const [foreign, setForeign] = useState<{ info: ForeignProject; message: string } | null>(null);
  // A project that cannot start because nothing is installed in it yet — the
  // usual state of a repository someone has just cloned.
  const [install, setInstall] = useState<{ command: string; source: string; root: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [recording, setRecording] = useState<DiscoveredPage[] | null>(null);
  const [figmaUrl, setFigmaUrl] = useState("");
  // Which project the address field was last filled in for, so switching
  // projects offers that project's file and typing is never overwritten.
  const filledFor = useRef<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<"gallery" | "compact" | "list" | "single">("gallery");
  const [figmaOpen, setFigmaOpen] = useState(false);
  const [menu, setMenu] = useState<{ page: DiscoveredPage; at: { x: number; y: number } } | null>(null);
  const [busyPage, setBusyPage] = useState<string | null>(null);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [figmaSession, setFigmaSession] = useState<FigmaExportSession | null>(null);
  // Rendering a scan into vectors takes minutes on a picture-heavy app, and
  // until the pairing code arrives there is nothing else on screen to say so.
  const [preparing, setPreparing] = useState<FigmaBuildProgress | null>(null);
  const [figmaStatus, setFigmaStatus] = useState<AutomaticMappingStatus>({ state: "waiting" });
  const [connection, setConnection] = useState<FigmaConnection | null>(null);
  const [pluginOpen, setPluginOpen] = useState(false);
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  // The plugin took the code and then went quiet, which is what an out-of-date
  // plugin looks like from here.
  const [pairingStalled, setPairingStalled] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);
  const toastSeq = useRef(0);

  const readConnection = async () => {
    const current = await window.uiSync?.getFigmaConnection?.();
    if (current) setConnection(current);
    return current ?? null;
  };

  // Read once at startup, and again when a sync completes: a sync is the other
  // moment "not connected" becomes "connected".
  useEffect(() => { void readConnection(); }, []);
  useEffect(() => {
    if (figmaStatus.state === "complete") void readConnection();
  }, [figmaStatus.state]);

  // While a pairing code is out, watch for the plugin taking it. Nothing else
  // tells this window that the connection was made.
  useEffect(() => {
    if (!pairingCode) return;
    let stopped = false;
    let fetched = 0;
    const timer = setInterval(async () => {
      const status = await window.uiSync?.getFigmaExportStatus?.(pairingCode);
      if (stopped || !status) return;
      // "running" means the plugin has already taken the job. A plugin that
      // takes it and never finishes is one that could not do anything with it —
      // an older copy of the plugin, which knows only jobs that carry pages.
      if (status.state === "running") {
        fetched += 1;
        if (fetched >= 4) setPairingStalled(true);
      }
      if (status.state === "complete") {
        setPairingCode(null);
        setPairingStalled(false);
        await readConnection();
        notify("done", t("toast.figmaPaired"));
      } else if (status.state === "expired" || status.state === "error") {
        setPairingCode(null);
        setPairingStalled(false);
        notify("error", status.message ?? t("figma.sync.pairingExpired"));
      }
    }, 1500);
    return () => { stopped = true; clearInterval(timer); };
  }, [pairingCode]);

  const startPairing = async () => {
    setPairing(true);
    try {
      const outcome = await window.uiSync?.startFigmaPairing?.();
      if (!outcome?.ok || !outcome.pairingCode) {
        notify("error", outcome?.message ?? t("figma.plugin.getCodeFailed"));
        return;
      }
      setPairingStalled(false);
      setPairingCode(outcome.pairingCode);
    } finally {
      setPairing(false);
    }
  };

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
    if (!inventory.ok && inventory.reason === "dependencies-missing" && inventory.install) {
      setInstall(inventory.install);
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
    setInstall(null);
    beginScan(root);
    const handoffName = root.split("/").filter(Boolean).pop();
    setTitle(handoffName ? t("inventory.handoffTitle", { name: handoffName }) : t("inventory.handoffDefault"));
    try {
      const inventory = await window.uiSync.scanFolder(root, workspaceRoot);
      if ((inventory as { id?: string }).id) setActiveId((inventory as { id?: string }).id!);
      finishScan(inventory);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : t("toast.scanFailed"));
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
      notify("error", cause instanceof Error ? cause.message : t("toast.scanFailed"));
    }
  };

  const scanAttached = async () => {
    if (!window.uiSync?.scanAttached) {
      notify("error", t("toast.requiresRestart"));
      return;
    }
    const number = Number(port);
    if (!Number.isInteger(number) || number < 1 || number > 65535) {
      notify("error", t("inventory.attachPortInvalid"));
      return;
    }
    beginScan(`debug:${number}`);
    try {
      const inventory = await window.uiSync.scanAttached(number);
      if ((inventory as { id?: string }).id) setActiveId((inventory as { id?: string }).id!);
      finishScan(inventory);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : t("inventory.attachFailed"));
    }
  };

  const startRecording = async () => {
    if (!window.uiSync?.startRecording) return;
    const target = address.trim() || (result?.ok ? result.origin : "");
    if (!target) { notify("error", t("inventory.recordAddressFirst")); return; }
        const outcome = await window.uiSync.startRecording(target);
    if (!outcome.ok) { notify("error", outcome.message ?? t("inventory.recordFailed")); return; }
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
    if (!result?.ok || !window.uiSync?.sendInventoryToFigma || preparing) return;
    setPreparing({ name: "", done: 0, total: (only ?? result.pages).length });
    try {
      const outcome = await window.uiSync.sendInventoryToFigma(
        { origin: result.origin, source: result.source, pages: only ?? result.pages },
        figmaUrl.trim()
      );
      if (!outcome.ok || !outcome.pairingCode) { notify("error", outcome.message ?? t("figma.exportPrepareFailed")); return; }
      setFigmaStatus({ state: "waiting" });
      setFigmaSession({
        pairingCode: outcome.pairingCode,
        expiresAt: outcome.expiresAt ?? "",
        screenCount: outcome.screenCount ?? 0,
        requiresPairing: outcome.requiresPairing ?? false,
        fileName: outcome.fileName,
        fileKey: outcome.fileKey,
        missing: outcome.missing,
        missingReasons: outcome.missingReasons,
        dropped: outcome.dropped
      });
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : t("figma.exportFailed"));
    } finally {
      setPreparing(null);
    }
  };

  // Each page reaches Figma only after its vectors are rendered, which the main
  // process reports one page at a time.
  useEffect(() => {
    const off = window.uiSync?.onFigmaBuildProgress?.((value) => setPreparing((current) => (current ? value : current)));
    return () => off?.();
  }, []);

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
        if (!cancelled) setFigmaStatus({ state: "error", message: cause instanceof Error ? cause.message : t("figma.syncStatusUnreadable") });
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
  const bridge = <K extends "recapturePage" | "explorePage" | "dropPage" | "restoreFilteredPage">(method: K) => {
    if (!window.uiSync) {
      notify("error", t("toast.insideCrank"));
      return null;
    }
    const call = window.uiSync[method];
    if (!call) {
      notify("error", t("toast.requiresRestart"));
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
    if (!where) { notify("error", t("inventory.pageUnknownProject")); return; }
    setBusyPage(page.id);
    try {
      const outcome = await call(where, page);
      if (!outcome.ok || !outcome.page) {
        notify("error", outcome.message ?? t("inventory.recaptureFailed"));
        return;
      }
      const fresh = outcome.page;
      setResult((current) => (current?.ok
        ? { ...current, pages: current.pages.map((entry) => (entry.id === fresh.id ? fresh : entry)) }
        : current));
      setFocused((current) => (current?.id === fresh.id ? fresh : current));
      notify("done", t("inventory.recaptured", { name: `${t("common.quoteOpen")}${fresh.name}${t("common.quoteClose")}` }));
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : t("inventory.recaptureFailed"));
    } finally {
      setBusyPage(null);
    }
  };

  /**
   * Puts back a page the crawl judged too small to be one.
   *
   * The 12% threshold is a judgement, not a fact — a tab that swaps a single
   * number really is a page to whoever is documenting the app. So the list of
   * what was left out is a list of decisions, and each of them can be reversed.
   * The reversal is remembered on disk, or the next scan would apply the
   * threshold again and quietly take the page back.
   */
  const restoreFiltered = async (item: { label: string; route?: string; recipe?: Array<{ kind?: string; locator: string; label: string }> }) => {
    const where = sourceOf();
    const call = bridge("restoreFilteredPage");
    if (!call) return;
    if (!where) { notify("error", t("inventory.pageUnknownProject")); return; }
    if (!item.route || !item.recipe?.length) { notify("error", t("inventory.restoreUnavailable")); return; }
    setRestoring(item.label);
    try {
      const outcome = await call(where, { label: item.label, recipe: item.recipe, route: item.route });
      if (!outcome.ok || !outcome.page) {
        notify("error", outcome.message ?? t("inventory.recaptureFailed"));
        return;
      }
      const added = outcome.page;
      setResult((current) => (current?.ok
        ? {
          ...current,
          filtered: current.filtered.filter((entry) => !(entry.label === item.label && entry.route === item.route)),
          pages: [...current.pages.filter((entry) => entry.id !== added.id), added]
        }
        : current));
      notify("done", t("inventory.recaptured", { name: `${t("common.quoteOpen")}${added.name}${t("common.quoteClose")}` }));
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : t("inventory.recaptureFailed"));
    } finally {
      setRestoring(null);
    }
  };

  const explore = async (page: DiscoveredPage) => {
    const where = sourceOf();
    const call = bridge("explorePage");
    if (!call) return;
    if (!where || !result?.ok) { notify("error", t("inventory.pageUnknownProject")); return; }
    setBusyPage(page.id);
    try {
      const held = result.pages.map((entry) => ({ id: entry.id, route: entry.route, url: entry.url }));
      const outcome = await call(where, page, held);
      if (!outcome.ok) {
        notify("error", outcome.message ?? t("inventory.exploreFailed"));
        return;
      }
      const found = outcome.pages ?? [];
      if (found.length === 0) {
        // "没有找到内容" and "nothing on this page responds" look the same
        // from outside, and only the second is worth acting on.
        const dead = outcome.inert?.length ?? 0;
        notify("done", dead > 0
          ? t("inventory.exploreInert", { count: dead, name: `${t("common.quoteOpen")}${page.name}${t("common.quoteClose")}` })
          : t("inventory.exploreDeadEnd", { name: `${t("common.quoteOpen")}${page.name}${t("common.quoteClose")}` }));
        return;
      }
      setResult((current) => {
        if (!current?.ok) return current;
        const seen = new Set(current.pages.map((entry) => entry.id));
        return { ...current, pages: [...current.pages, ...found.filter((entry) => !seen.has(entry.id))] };
      });
      notify("done", t("inventory.exploreFound", { count: found.length, name: `${t("common.quoteOpen")}${page.name}${t("common.quoteClose")}` }));
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : t("inventory.exploreFailed"));
    } finally {
      setBusyPage(null);
    }
  };

  const sendOnePage = async (page: DiscoveredPage) => {
    if (!result?.ok) return;
    if (!figmaUrl.trim()) {
      // Nowhere to send it yet. Open the field rather than refusing.
      setFigmaOpen(true);
      notify("error", t("inventory.figmaUrlFirst"));
      return;
    }
    await sendToFigma([page]);
  };

  const dropPage = async (page: DiscoveredPage) => {
    const where = sourceOf();
    const call = bridge("dropPage");
    if (!call) return;
    if (!where) { notify("error", t("inventory.pageUnknownProject")); return; }
    await call(where, page.id);
    setResult((current) => (current?.ok
      ? { ...current, pages: current.pages.filter((entry) => entry.id !== page.id) }
      : current));
    setFocused((current) => (current?.id === page.id ? null : current));
    notify("done", t("inventory.dropped", { name: `${t("common.quoteOpen")}${page.name}${t("common.quoteClose")}` }));
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
    setInstall(null);
    setResult(saved);
    setActiveId(target.id);
    setSource(target.target);
    setTitle(t("inventory.handoffTitle", { name: target.name }));
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
    else notify("error", t("inventory.dropInvalid"));
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
        title.trim() || t("inventory.handoffDefault")
      );
      if (outcome.saved && outcome.filePath) notify("done", t("toast.savedHandoff"), outcome.filePath);
    } catch (cause) {
      notify("error", cause instanceof Error ? cause.message : t("toast.handoffFailed"));
    }
  };

  const pages = result?.ok ? result.pages : [];

  // Typed once per project, not once per send: the file a project's pages go to
  // is the same file every time, and it was recorded the last time they went.
  useEffect(() => {
    if (!activeId || filledFor.current === activeId) return;
    filledFor.current = activeId;
    const remembered = entries
      .flatMap((entry) => (isGroup(entry) ? [...(entry.root ? [entry.root] : []), ...entry.children] : [entry]))
      .find((target) => target.id === activeId)?.figmaUrl;
    setFigmaUrl(remembered ?? "");
  }, [activeId, entries]);

  // Opened, a page is being looked at rather than managed, so the keyboard
  // works the way a viewer's does: leave with Escape, walk the set with the
  // arrows instead of closing and aiming at the next card.
  useEffect(() => {
    if (!focused) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Escape") { setFocused(null); return; }
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step === 0 || pages.length < 2) return;
      const at = pages.findIndex((page) => page.id === focused.id);
      if (at < 0) return;
      event.preventDefault();
      setFocused(pages[(at + step + pages.length) % pages.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [focused, pages]);
  const reskins = pages.reduce((total, page) => total + (page.variants?.length ?? 0), 0);
  // A project the window started and left up, so it can be looked at rather
  // than only scanned. A scan starts one too and stops it again afterwards.
  const [runState, setRunState] = useState<{ state: "idle" | "starting" | "running"; root?: string }>({ state: "idle" });

  const toggleRun = async (root: string) => {
    if (runState.state === "running" && runState.root === root) {
      await window.uiSync?.stopProjectRun?.(root);
      setRunState({ state: "idle" });
      notify("done", t("inventory.runStopped"));
      return;
    }
    setRunState({ state: "starting", root });
    const outcome = await window.uiSync?.runProject?.(root);
    if (!outcome?.ok) {
      setRunState({ state: "idle" });
      notify("error", outcome?.message ?? t("inventory.runFailed"));
      return;
    }
    setRunState({ state: "running", root });
    notify("done", t("inventory.runOpened", { url: outcome.url ?? "" }));
  };

  // Where the project lives, when it is a folder. A scanned address stays an
  // address — that one is the user's own server and is still up.
  const scannedFolder = result?.ok
    ? result.source?.kind === "folder"
      ? result.source.target
      : source?.startsWith("/") ? source : null
    : null;
  const leftOut = result?.ok
    ? result.filtered.length + (result.inert?.length ?? 0)
    : 0;

  return (
    <div className="app-frame">
      <Sidebar
        activeId={activeId}
        busyIds={Object.keys(jobs)}
        entries={entries}
        figmaConnected={connection ? connection.connected : null}
        onAdd={() => { setResult(null); setActiveId(null); setChoices(null); setForeign(null); setInstall(null); }}
        onDropFolder={onDrop}
        onForget={(target) => void forget(target)}
        onOpen={(target) => void openSaved(target)}
        onOpenPlugin={() => { void readConnection(); setPluginOpen(true); }}
        onRescan={rescan}
      />

      {pluginOpen && connection && (
        <FigmaPluginPanel
          connection={connection}
          onClose={() => setPluginOpen(false)}
          onCopyCode={() => { if (pairingCode) void window.uiSync?.copyText?.(pairingCode); }}
          onStartPairing={() => void startPairing()}
          pairing={pairing}
          pairingCode={pairingCode}
          pairingStalled={pairingStalled}
          onForget={async () => {
            const next = await window.uiSync?.forgetFigmaConnection?.();
            if (next) setConnection(next);
            notify("done", t("toast.figmaForget"));
          }}
          onShowPlugin={() => void window.uiSync?.showFigmaPlugin?.()}
        />
      )}
    <main className="inventory-page">
      {choices && !activeJob && (
        <section className="inventory-choices">
          <strong>{t("inventory.workspaceTitle", { count: choices.length })}</strong>
          <p>
            {t("inventory.workspaceBody")}
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

      {install && !activeJob && (
        <section className="inventory-choices">
          <strong>{t("inventory.installTitle")}</strong>
          <p>{t("inventory.installNote", { source: install.source })}</p>
          <ul>
            <li>
              <button
                onClick={() => { void window.uiSync?.copyText?.(install.command); setCopied(install.command); }}
                type="button"
              >
                <strong>{install.command}</strong>
                <code>
                  {t("inventory.installIn", { root: install.root.split("/").filter(Boolean).pop() ?? install.root })}
                  {copied === install.command ? ` · ${t("inventory.copied")}` : ` · ${t("inventory.clickToCopy")}`}
                </code>
              </button>
            </li>
          </ul>
          <p className="inventory-note">{t("inventory.installThen")}</p>
        </section>
      )}

      {foreign && !activeJob && (
        <section className="inventory-choices">
          <strong>{foreign.message}</strong>
          <p>{t("inventory.foreignNote")}</p>
          <ul>
            {foreign.info.commands.map((entry) => (
              <li key={entry.command}>
                <button
                  onClick={() => { void window.uiSync?.copyText?.(entry.command); setCopied(entry.command); }}
                  type="button"
                >
                  <strong>{entry.command}</strong>
                  <code>{t("inventory.foreignFrom", { source: entry.source })}{copied === entry.command ? ` · ${t("inventory.copied")}` : ` · ${t("inventory.clickToCopy")}`}</code>
                </button>
              </li>
            ))}
          </ul>
          {foreign.info.port !== null && (
            <p className="inventory-note">
              {t("inventory.foreignScanHint", { port: foreign.info.port })}
            </p>
          )}
        </section>
      )}

      {!result?.ok && !activeJob && !choices && !foreign && !install && (
        <section
          className={`onboarding${dragging ? " is-over" : ""}`}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDrop={onDrop}
        >
          <div className="onboarding-drop">
            <FolderGit2 size={26} />
            <h1>{t("inventory.drag")}</h1>
            <p>{t("inventory.dragHint")}</p>
            <p className="onboarding-alt-line">
              {t("inventory.dragHintBundle")}
            </p>
            <button className="primary-button" onClick={() => void chooseFolder()} type="button">{t("inventory.chooseFolderOrApp")}</button>
          </div>

          <ol className="onboarding-steps">
            <li>
              <strong>{t("inventory.stepStart")}</strong>
              <span>{t("inventory.stepStartDesc")}</span>
            </li>
            <li>
              <strong>{t("inventory.stepCrawl")}</strong>
              <span>{t("inventory.stepCrawlDesc")}</span>
            </li>
            <li>
              <strong>{t("inventory.stepExport")}</strong>
              <span>{t("inventory.stepExportDesc")}</span>
            </li>
          </ol>

          <div className="onboarding-alt">
            <button className="inventory-link" onClick={() => void startRecording()} type="button">
              {t("inventory.record")}
            </button>
            <button className="inventory-link" onClick={() => setShowAddress((value) => !value)} type="button">
              {showAddress ? t("inventory.collapse") : t("inventory.scanAddress")}
            </button>
            {showAddress && (
              <form className="inventory-form" onSubmit={(event) => { event.preventDefault(); void scan(); }}>
                <input
                  aria-label={t("inventory.addressLabel")}
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="localhost:5173"
                  value={address}
                />
                <input
                  aria-label={t("inventory.seedsLabel")}
                  onChange={(event) => setSeeds(event.target.value)}
                  placeholder={t("inventory.scanAddressExtraPlaceholder")}
                  value={seeds}
                />
                <button disabled={!address.trim()} type="submit">{t("inventory.scanAddressButton")}</button>
              </form>
            )}
            <button className="inventory-link" onClick={() => setShowAttach((value) => !value)} type="button">
              {showAttach ? t("inventory.collapse") : t("inventory.attach")}
            </button>
            {showAttach && (
              <form className="inventory-form" onSubmit={(event) => { event.preventDefault(); void scanAttached(); }}>
                <p className="inventory-note">
                  {t("inventory.attachDescription")}
                  <code>npx electron . --remote-debugging-port=9222</code>
                </p>
                <input
                  aria-label={t("inventory.attachPort")}
                  onChange={(event) => setPort(event.target.value.replace(/\D/g, "").slice(0, 5))}
                  placeholder="9222"
                  value={port}
                />
                <button disabled={!port.trim()} type="submit">{t("inventory.attachStart")}</button>
              </form>
            )}
          </div>
        </section>
      )}

      {activeJob && (
        <header className="project-header">
          <div className="project-header-copy">
            <h1>{(activeJob.target || source || "").split("/").filter(Boolean).pop() ?? t("inventory.title")}</h1>
            <div className="connection-line">
              <LoaderCircle className="spin" size={13} />
              <span>{activeJob.status ? activeJob.status.detail : t("toast.opening")}</span>
              <span className="header-sep">{t("inventory.backgroundJob")}</span>
            </div>
          </div>
        </header>
      )}

      {activeJob && (
        <section className="inventory-progress" ref={progressRef}>
          {activeJob.progress.length === 0
            ? <p>{t("inventory.looking")}</p>
            : activeJob.progress.map((item, index) => (
                <p key={`${item.route}-${index}`}>
                  <span className="inventory-progress-count">{index + 1}</span> {item.name}
                </p>
              ))}
        </section>
      )}

      {recording && (
        <section className="inventory-recording">
          <strong>{t("inventory.recordingTitle")}</strong>
          <p>
            {t("inventory.recordNote")}
          </p>
          <div className="inventory-recorded">
            {recording.length === 0
              ? <span>{t("inventory.recordEmpty")}</span>
              : recording.map((page) => <span key={page.id}>{page.name}</span>)}
          </div>
          <button className="inventory-export" onClick={() => void stopRecording()} type="button">
            {t("inventory.recordStop", { count: recording.length })}
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
                    title={t("inventory.revealInFinder", { path: scannedFolder })}
                    type="button"
                  >
                    {isAppBundle(scannedFolder) ? <AppWindowMac size={13} /> : <FolderGit2 size={13} />}
                    <span>{scannedFolder.split("/").filter(Boolean).pop()}</span>
                  </button>
                ) : (
                  <><Globe2 size={13} /><span>{result.origin}</span></>
                )}
                <span className="header-sep">·</span>
                <span>{t("inventory.pageCount", { count: pages.length })}</span>
                {result.sources.sitemap > 0 && <span className="header-sep">· {t("inventory.fromSitemap", { count: result.sources.sitemap })}</span>}
                {result.sources.crawled > 0 && <span className="header-sep">· {t("inventory.fromClicks", { count: result.sources.crawled })}</span>}
                {reskins > 0 && <span className="header-sep">· {t("inventory.reskinCount", { count: reskins })}</span>}
              </div>
            </div>
            <div className="project-header-actions">
              <button
                aria-label={t("inventory.actions.rescan")}
                className="secondary-button project-refresh-button"
                onClick={() => { if (source) source.startsWith("http") ? void scan(source) : void scanFolder(source); }}
                title={t("inventory.actions.rescan")}
                type="button"
              >
                <RefreshCw size={14} />
              </button>
              {scannedFolder && !isAppBundle(scannedFolder) && result.platform !== "swiftui" && (
                <button
                  className="secondary-button"
                  disabled={runState.state === "starting"}
                  onClick={() => void toggleRun(scannedFolder)}
                  type="button"
                >
                  {runState.state === "starting"
                    ? <><LoaderCircle className="spin" size={14} /> {t("inventory.runStarting")}</>
                    : runState.state === "running"
                      ? <><Square size={13} /> {t("inventory.stopRun")}</>
                      : <><Play size={14} /> {t("inventory.run")}</>}
                </button>
              )}
              <button className="secondary-button" onClick={() => void exportPage()} type="button">
                <Download size={14} /> {t("inventory.saveHandoff")}
              </button>
              <button className="secondary-button" onClick={() => setFigmaOpen((value) => !value)} type="button">
                <Figma size={14} /> {t("inventory.sendToFigma")}
              </button>
            </div>
          </header>

          {figmaOpen && (
            <div className="inventory-figma-row">
              <input
                aria-label={t("inventory.figmaUrlLabel")}
                onChange={(event) => setFigmaUrl(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void sendToFigma(); }}
                placeholder={t("inventory.figmaUrlPlaceholder")}
                value={figmaUrl}
              />
              <button className="secondary-button" disabled={!figmaUrl.trim() || preparing !== null} onClick={() => void sendToFigma()} type="button">
                {preparing
                  ? <><LoaderCircle className="spin" size={14} /> {preparing.name
                    ? t("inventory.sendProgress", { done: preparing.done + 1, total: preparing.total, name: preparing.name })
                    : t("inventory.sendPreparing")}</>
                  : t("inventory.sendCount", { count: pages.length })}
              </button>
            </div>
          )}

          <div className="inventory-toolbar">
            <span className="view-switch">
              {([["gallery", t("inventory.viewGallery")], ["compact", t("inventory.viewCompact")], ["list", t("inventory.viewList")], ["single", t("inventory.viewSingle")]] as const).map(([id, label]) => (
                <button aria-pressed={view === id} key={id} onClick={() => setView(id)} type="button">{label}</button>
              ))}
            </span>
            {leftOut > 0 && (
              <button className="inventory-link" onClick={() => setShowFiltered((value) => !value)} type="button">
                {showFiltered ? t("inventory.collapse") : t("inventory.showFiltered", { count: leftOut })}
              </button>
            )}
          </div>

          {showFiltered && (
            <section className="inventory-filtered">
              {result.filtered.length > 0 && (
                <>
                  <p>{t("inventory.filteredTitle")}</p>
                  <ul>
                    {result.filtered.map((item, index) => (
                      <li key={`${item.label}-${index}`}>
                        <code>{Math.round(item.magnitude * 1000) / 10}%</code>
                        <span>{`${t("common.quoteOpen")}${item.label}${t("common.quoteClose")}`}</span>
                        <small>{t("inventory.from", { from: item.from })}</small>
                        {/* Only where there is a way back to it. A scan taken
                            before the way back was recorded says so rather than
                            offering a button that cannot work. */}
                        {item.route && item.recipe?.length ? (
                          <button
                            className="inventory-link"
                            disabled={restoring !== null}
                            onClick={() => void restoreFiltered(item)}
                            type="button"
                          >
                            {restoring === item.label ? t("inventory.restoring") : t("inventory.restore")}
                          </button>
                        ) : (
                          <small className="inventory-note">{t("inventory.restoreUnavailable")}</small>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {/* Kept apart from the list above: those were judged too small to
                  be a page, these did not change the page at all. */}
              {(result.inert?.length ?? 0) > 0 && (
                <>
                  <p>{t("inventory.unrelated")}</p>
                  <ul>
                    {result.inert!.map((item, index) => (
                      <li key={`inert-${item.label}-${index}`}>
                        <span>{`${t("common.quoteOpen")}${item.label || t("inventory.noLabel")}${t("common.quoteClose")}`}</span>
                        <small>{t("inventory.from", { from: item.from })}</small>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {result.skipped.length > 0 && (
                <p className="inventory-note">
                  {t("inventory.skipped")}{result.skipped.map((item) => `${t("common.quoteOpen")}${item.label}${t("common.quoteClose")}`).join(" ")}
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
                      <span className="inventory-row-variants">{t("inventory.variantCount", { count: page.variants.length })}</span>
                    )}
                    <code>{addressOf(page, t)}</code>
                    {busyPage === page.id && <LoaderCircle className="spin" size={13} />}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className={`inventory-grid${view === "compact" ? " is-compact" : ""}${view === "single" ? " is-single" : ""}${view !== "single" && pages.length > 0 && pages.every(isPhonePortrait) ? " is-portrait" : ""}`}>
              {pages.map((page, index) => (
                <PageCard
                  busy={busyPage === page.id}
                  index={index}
                  key={page.id}
                  onMenu={(target, at) => setMenu({ page: target, at })}
                  onOpen={setFocused}
                  page={page}
                  single={view === "single"}
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
          exported={Boolean(menu.page.vector)}
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

      {focused && <PageOverlay onClose={() => setFocused(null)} page={focused} targetId={activeId} />}

      {figmaSession && (
        <FigmaSyncDialog
          fileName={figmaSession.fileName ?? t("inventory.yourFigmaFile")}
          note={shortfall(figmaSession, t)}
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
                  {t("common.reveal")}
                </button>
              )}
              <button aria-label={t("common.close")} className="toast-close" onClick={() => dismiss(toast.id)} type="button">
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
