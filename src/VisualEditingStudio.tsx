import { Figma, LoaderCircle, Play, ScanLine } from "lucide-react";
import { useEffect, useState } from "react";
import type { ProjectInfo, SwiftUiDesignSession } from "./types";

function demoSession(project: ProjectInfo): SwiftUiDesignSession {
  return {
    state: "needs-capture",
    project,
    nodes: [],
    pdfDataUrl: null,
    pdfReady: false,
    screenshotDataUrl: null,
    vectorSvgDataUrl: null,
    vectorReady: false,
    vectorMessage: null,
    viewport: null,
    deviceName: null,
    capturedAt: null
  };
}

export function VisualEditingStudio({
  project,
  refreshVersion,
  captureRunning,
  onRunCapture,
  onSyncToFigma
}: {
  project: ProjectInfo;
  refreshVersion: number;
  captureRunning: boolean;
  onRunCapture: () => Promise<void>;
  onSyncToFigma: (pdfPageId: string) => Promise<void>;
}) {
  const [session, setSession] = useState<SwiftUiDesignSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncingPageId, setSyncingPageId] = useState<string | null>(null);

  const loadSession = async () => {
    setLoading(true);
    try {
      setSession(window.uiSync ? await window.uiSync.getSwiftUiDesignSession(project.root) : demoSession(project));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void loadSession(); }, [project.id, project.runtimeCapture?.capturedAt, refreshVersion]);

  const capture = async () => {
    await onRunCapture();
    await loadSession();
  };

  const sync = async (pdfPageId: string) => {
    setSyncingPageId(pdfPageId);
    try {
      await onSyncToFigma(pdfPageId);
    } finally {
      setSyncingPageId(null);
    }
  };

  if (loading) return <div className="studio-loading"><LoaderCircle className="spin" size={18} /> Loading rendered screen…</div>;

  const ready = session?.state === "ready" && Boolean(session.pdfReady && session.pdfDataUrl);
  const pages = session?.pages ?? [];

  return (
    <section className="rendered-studio">
      <div className="rendered-canvas">
        {ready && pages.length > 0 ? (
          <div className="pdf-page-grid">
            {pages.map((page) => (
              <article className="pdf-page-card" key={page.id}>
                <span className="pdf-page-preview" style={{ aspectRatio: `${page.width} / ${page.height}` }}>
                  <object
                    aria-label={`${page.name} PDF preview`}
                    data={`${page.pdfDataUrl}#page=${page.pdfPageNumber}&toolbar=0&navpanes=0&scrollbar=0&view=Fit`}
                    type="application/pdf"
                  >
                    <img src={page.previewDataUrl} alt={`${page.name} PDF preview`} />
                  </object>
                  <button
                    type="button"
                    className="pdf-import-button"
                    disabled={!project.fileKey || syncingPageId !== null}
                    onClick={() => void sync(page.id)}
                    title={project.fileKey ? `Convert ${page.name} to SVG and import it into Figma` : "Connect a Figma file first"}
                  >
                    {syncingPageId === page.id ? <LoaderCircle className="spin" size={13} /> : <Figma size={13} />}
                    {syncingPageId === page.id ? "Converting…" : "Import to Figma"}
                  </button>
                </span>
                <span className="pdf-page-caption">
                  <span>
                    <strong>{page.name}</strong>
                    <small>PDF preview</small>
                  </span>
                  <Figma size={13} />
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="rendered-empty">
            <span><ScanLine size={25} /></span>
            <strong>Export the current screen to PDF</strong>
            <p>The exported PDF is the preview and the design handoff source. UI Sync does not build a second synthetic layer preview.</p>
            <button className="primary-button" disabled={captureRunning} onClick={() => void capture()}>
              {captureRunning ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}
              {captureRunning ? "Exporting PDF…" : "Export iOS PDF"}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
