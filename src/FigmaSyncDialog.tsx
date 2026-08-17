import { AlertCircle, Check, Copy, ExternalLink, Figma, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import type { AutomaticMappingSession, AutomaticMappingStatus } from "./types";

/**
 * What a sync with Figma looks like while it is happening.
 *
 * Pairing, waiting, running and the result are the same four states whether the
 * pages came from a registered project or from a scan, so both flows show this
 * rather than each explaining the wait in its own words.
 */
export function FigmaSyncDialog({
  fileName,
  operation,
  session,
  status,
  note,
  onClose,
  onOpenFigma,
  onShowPlugin,
  onCopyCode,
  onRestart
}: {
  fileName: string;
  operation: "push" | "pull";
  session: AutomaticMappingSession;
  status: AutomaticMappingStatus;
  note?: string | null;
  onClose: () => void;
  onOpenFigma: () => void;
  onShowPlugin: () => void;
  onCopyCode: () => void;
  onRestart: () => void;
}) {
  const isPull = operation === "pull";
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
                : `UI Sync is ready. Open the plugin in ${fileName} to start syncing.`}
          </p>
          {note && <p className="dialog-note">{note}</p>}
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

        {isComplete && (status.substitutedFonts?.length ?? 0) > 0 && (
          <p className="dialog-note">
            Figma 没有 {status.substitutedFonts!.join("、")}，这些文字用了它有的最接近的字体。
          </p>
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
