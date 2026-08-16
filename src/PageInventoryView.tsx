import { useEffect, useRef, useState } from "react";
import type { DiscoveredPage, PageInventory, ScanProgress } from "./types";

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
  const progressRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = window.uiSync?.onScanProgress?.((value) => {
      setProgress((current) => [...current, value]);
    });
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    progressRef.current?.scrollTo({ top: progressRef.current.scrollHeight });
  }, [progress]);

  const scan = async () => {
    if (!window.uiSync?.scanUrl || scanning) return;
    setScanning(true);
    setError(null);
    setResult(null);
    setProgress([]);
    setFocused(null);
    try {
      const seedPaths = seeds.split(/[\s,]+/).map((value) => value.trim()).filter(Boolean);
      const inventory = await window.uiSync.scanUrl(address, seedPaths);
      setResult(inventory);
      if (!inventory.ok) setError(inventory.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The scan failed.");
    } finally {
      setScanning(false);
    }
  };

  const pages = result?.ok ? result.pages : [];

  return (
    <main className="inventory-page">
      <header className="inventory-header">
        <div>
          <h1>Page inventory</h1>
          <p>Point it at a running app. Anything a browser can open works — React, Python, a static folder, an Electron renderer.</p>
        </div>
      </header>

      <form
        className="inventory-form"
        onSubmit={(event) => { event.preventDefault(); void scan(); }}
      >
        <input
          aria-label="Address"
          disabled={scanning}
          onChange={(event) => setAddress(event.target.value)}
          placeholder="localhost:5173"
          value={address}
        />
        <input
          aria-label="Extra addresses"
          disabled={scanning}
          onChange={(event) => setSeeds(event.target.value)}
          placeholder="Extra paths, optional — /?view=settings /about"
          value={seeds}
        />
        <button disabled={scanning || !address.trim()} type="submit">
          {scanning ? "Scanning…" : "Scan"}
        </button>
      </form>

      {scanning && (
        <section className="inventory-progress" ref={progressRef}>
          {progress.length === 0
            ? <p>Opening {address}…</p>
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
            <span>{result.origin}</span>
            {result.sources.sitemap > 0 && <span>{result.sources.sitemap} from sitemap</span>}
            {result.sources.crawled > 0 && <span>{result.sources.crawled} found by crawling</span>}
            {result.filtered.length > 0 && (
              <button className="inventory-link" onClick={() => setShowFiltered((value) => !value)} type="button">
                {showFiltered ? "Hide" : "Show"} {result.filtered.length} left out
              </button>
            )}
          </div>

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
