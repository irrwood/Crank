import { useEffect, useRef, useState } from "react";
import type { DiscoveredPage, PageInventory, ScanProgress, ScanStatus, WorkspacePackage, ForeignProject } from "./types";

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

export default function PageInventoryView() {
  const [address, setAddress] = useState("");
  const [seeds, setSeeds] = useState("");
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<ScanProgress[]>([]);
  const [result, setResult] = useState<PageInventory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState<DiscoveredPage | null>(null);
  const [showFiltered, setShowFiltered] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [title, setTitle] = useState("Design handoff");
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [showAddress, setShowAddress] = useState(false);
  const [choices, setChoices] = useState<WorkspacePackage[] | null>(null);
  const [foreign, setForeign] = useState<{ info: ForeignProject; message: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [recording, setRecording] = useState<DiscoveredPage[] | null>(null);
  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = window.uiSync?.onScanProgress?.((value) => {
      setProgress((current) => [...current, value]);
    });
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    const off = window.uiSync?.onScanStatus?.(setStatus);
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    const off = window.uiSync?.onRecorded?.((page) => {
      setRecording((current) => (current ? [...current, page] : current));
    });
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    progressRef.current?.scrollTo({ top: progressRef.current.scrollHeight });
  }, [progress]);

  const beginScan = (label: string) => {
    setScanning(true);
    setError(null);
    setResult(null);
    setProgress([]);
    setStatus(null);
    setSaved(null);
    setFocused(null);
    setSource(label);
  };

  const finishScan = (inventory: PageInventory) => {
    if (!inventory.ok && inventory.reason === "workspace" && inventory.packages?.length) {
      setChoices(inventory.packages);
      return;
    }
    if (!inventory.ok && inventory.reason === "foreign" && inventory.foreign) {
      setForeign({ info: inventory.foreign, message: inventory.message });
      if (inventory.foreign.port) setAddress(`localhost:${inventory.foreign.port}`);
      setShowAddress(true);
      return;
    }
    setResult(inventory);
    if (!inventory.ok) setError(inventory.message);
  };

  const scanFolder = async (root: string) => {
    if (!window.uiSync?.scanFolder || scanning) return;
    setChoices(null);
    setForeign(null);
    beginScan(root);
    setTitle(`${root.split("/").filter(Boolean).pop() ?? "Design"} handoff`);
    try {
      finishScan(await window.uiSync.scanFolder(root));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The scan failed.");
    } finally {
      setScanning(false);
      setStatus(null);
    }
  };

  const scan = async () => {
    if (!window.uiSync?.scanUrl || scanning) return;
    beginScan(address);
    try {
      const seedPaths = seeds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
      finishScan(await window.uiSync.scanUrl(address, seedPaths));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The scan failed.");
    } finally {
      setScanning(false);
      setStatus(null);
    }
  };

  const startRecording = async () => {
    if (!window.uiSync?.startRecording) return;
    const target = address.trim() || (result?.ok ? result.origin : "");
    if (!target) { setError("Enter the address to record from."); return; }
    setError(null);
    const outcome = await window.uiSync.startRecording(target);
    if (!outcome.ok) { setError(outcome.message ?? "Recording could not start."); return; }
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
      const known = new Set(current.pages.map((page) => page.signature));
      return { ...current, pages: [...current.pages, ...recorded.filter((page) => !known.has(page.signature))] };
    });
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    if (scanning) return;
    const file = event.dataTransfer.files[0];
    const dropped = file && window.uiSync?.getDroppedPath?.(file);
    if (dropped) void scanFolder(dropped);
    else setError("Drop a project folder.");
  };

  const chooseFolder = async () => {
    const chosen = await window.uiSync?.chooseFolder?.();
    if (chosen) void scanFolder(chosen);
  };

  const exportPage = async () => {
    if (!result?.ok || !window.uiSync?.exportHandoffPage) return;
    setError(null);
    try {
      const outcome = await window.uiSync.exportHandoffPage(
        { origin: result.origin, pages: result.pages, filtered: result.filtered },
        title.trim() || "Design handoff"
      );
      if (outcome.saved && outcome.filePath) setSaved(outcome.filePath);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The page could not be saved.");
    }
  };

  const pages = result?.ok ? result.pages : [];

  return (
    <main className="inventory-page">
      <header className="inventory-header">
        <div>
          <h1>Page inventory</h1>
          <p>Drop a project folder. It gets served and walked, and every page comes back.</p>
        </div>
      </header>

      {choices && !scanning && (
        <section className="inventory-choices">
          <strong>This folder holds several runnable projects</strong>
          <p>Its dev script starts them in parallel, so scanning the folder itself would pick one at random. Choose the one you mean.</p>
          <ul>
            {choices.map((item) => (
              <li key={item.root}>
                <button onClick={() => void scanFolder(item.root)} type="button">
                  <strong>{item.name}</strong>
                  <code>{item.root}</code>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {foreign && !scanning && (
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

      {!result?.ok && !scanning && !choices && (
        <section
          className={`inventory-drop${dragging ? " is-over" : ""}`}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDrop={onDrop}
        >
          <strong>Drop a project folder here</strong>
          <span>React, Vue, Next, Electron, a static site — it gets started for you.</span>
          <button className="inventory-export" onClick={() => void chooseFolder()} type="button">Choose folder…</button>
          <button className="inventory-link" onClick={() => void startRecording()} type="button">
            Or open the app and record the pages you visit
          </button>
          <button className="inventory-link" onClick={() => setShowAddress((value) => !value)} type="button">
            {showAddress ? "Hide" : "Already running? Scan an address instead"}
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
                placeholder="Extra paths, optional — /?view=settings"
                value={seeds}
              />
              <button disabled={!address.trim()} type="submit">Scan</button>
            </form>
          )}
        </section>
      )}

      {scanning && (
        <section className="inventory-progress" ref={progressRef}>
          <p className="inventory-phase">
            {status ? status.detail : `Opening ${source ?? ""}…`}
          </p>
          {progress.length === 0
            ? <p>Looking for pages…</p>
            : progress.map((item, index) => (
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

      {error && <p className="inventory-error">{error}</p>}

      {result?.ok && (
        <>
          <div className="inventory-summary">
            <strong>{pages.length} pages</strong>
            <span title={source ?? undefined}>{source?.split("/").filter(Boolean).pop() ?? result.origin}</span>
            <button className="inventory-link" onClick={() => { setResult(null); setSource(null); }} type="button">
              Scan something else
            </button>
            {result.sources.sitemap > 0 && <span>{result.sources.sitemap} from sitemap</span>}
            {result.sources.crawled > 0 && <span>{result.sources.crawled} found by crawling</span>}
            {pages.some((page) => page.variants?.length) && (
              <span>{pages.reduce((total, page) => total + (page.variants?.length ?? 0), 0)} re-skins grouped in</span>
            )}
            <input
              aria-label="Handoff page title"
              className="inventory-title-input"
              onChange={(event) => setTitle(event.target.value)}
              value={title}
            />
            <button className="inventory-export" onClick={() => void exportPage()} type="button">
              Save handoff page…
            </button>
            {result.filtered.length > 0 && (
              <button className="inventory-link" onClick={() => setShowFiltered((value) => !value)} type="button">
                {showFiltered ? "Hide" : "Show"} {result.filtered.length} left out
              </button>
            )}
          </div>

          {saved && (
            <p className="inventory-saved">
              Saved to <code>{saved}</code>
              <button onClick={() => void window.uiSync?.revealFile?.(saved)} type="button">Show in Finder</button>
            </p>
          )}

          {showFiltered && (
            <section className="inventory-filtered">
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
              {result.skipped.length > 0 && (
                <p className="inventory-note">
                  Never clicked, the label reads as destructive: {result.skipped.map((item) => `「${item.label}」`).join(" ")}
                </p>
              )}
            </section>
          )}

          <div className="inventory-grid">
            {pages.map((page, index) => (
              <PageCard index={index} key={page.id} onOpen={setFocused} page={page} />
            ))}
          </div>
        </>
      )}

      {focused && (
        <div className="inventory-overlay" onClick={() => setFocused(null)} role="presentation">
          <figure onClick={(event) => event.stopPropagation()} role="presentation">
            <figcaption>
              <strong>{focused.name}</strong>
              <code>{addressOf(focused)}</code>
              <button onClick={() => setFocused(null)} type="button">Close</button>
            </figcaption>
            {focused.thumbnail
              ? <img alt="" src={focused.thumbnail.dataUrl} />
              : <p>No preview was captured for this page.</p>}
          </figure>
        </div>
      )}
    </main>
  );
}
