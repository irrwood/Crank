import { useEffect, useRef, useState } from "react";
import type { DiscoveredPage, PageInventory, ScanProgress, ScanStatus } from "./types";

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
  return (
    <article className="inventory-card">
      <button className="inventory-shot" onClick={() => onOpen(page)} type="button">
        {page.thumbnail
          ? <img alt="" src={page.thumbnail.dataUrl} />
          : <span className="inventory-shot-empty">No preview</span>}
      </button>
      <div className="inventory-meta">
        <span className="inventory-index">{String(index + 1).padStart(2, "0")}</span>
        <h3 title={page.name}>{page.name}</h3>
      </div>
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
    setResult(inventory);
    if (!inventory.ok) setError(inventory.message);
  };

  const scanFolder = async (root: string) => {
    if (!window.uiSync?.scanFolder || scanning) return;
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

      {!result?.ok && !scanning && (
        <section
          className={`inventory-drop${dragging ? " is-over" : ""}`}
          onDragLeave={() => setDragging(false)}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDrop={onDrop}
        >
          <strong>Drop a project folder here</strong>
          <span>React, Vue, Next, Electron, a static site — it gets started for you.</span>
          <button className="inventory-export" onClick={() => void chooseFolder()} type="button">Choose folder…</button>
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
