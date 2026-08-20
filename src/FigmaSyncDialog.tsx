import { AlertCircle, Check, Copy, ExternalLink, Figma, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import { useT } from "./lib/locale";
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
  const t = useT();

  const title = isComplete
    ? isPull
      ? t("figma.sync.completePullTitle")
      : t("figma.sync.completePushTitle")
    : isRunning
      ? isPull
        ? t("figma.sync.runningPullTitle")
        : t("figma.sync.runningPushTitle")
      : hasFailed
        ? t("figma.sync.failedTitle")
        : session.requiresPairing
          ? t("figma.sync.pairingRequired")
          : t("figma.sync.waitingForPlugin");

  const body = isComplete
    ? isPull
      ? t("figma.sync.completePullBody")
      : t("figma.sync.completePushBody")
    : isRunning
      ? isPull
        ? t("figma.sync.runningPullBody")
        : t("figma.sync.runningPushBody")
      : hasFailed
        ? t("figma.sync.failedBody")
        : session.requiresPairing
          ? t("figma.sync.pairingBody")
          : t("figma.sync.startBody", { fileName });

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="figma-link-dialog automatic-mapping-dialog" role="dialog" aria-modal="true" aria-labelledby="automatic-mapping-title">
        <div className="dialog-icon"><Sparkles size={18} /></div>
        <button type="button" className="icon-button dialog-close" aria-label={t("common.close")} onClick={onClose}>
          <X size={16} />
        </button>
        <div className="dialog-copy">
          <span>{t("figma.sync.title")}</span>
          <h2 id="automatic-mapping-title">{title}</h2>
          <p>{body}</p>
          {note && <p className="dialog-note">{note}</p>}
        </div>

        {!isComplete && !hasFailed && (
          <>
            {session.requiresPairing ? (
              <div className="pairing-code-block">
                <span>{t("figma.sync.pairingCode")}</span>
                <strong>{session.pairingCode.slice(0, 3)} {session.pairingCode.slice(3)}</strong>
                <button type="button" className="icon-button" aria-label={t("figma.sync.copyPairingCode")} title={t("figma.sync.copyPairingCode")} onClick={onCopyCode}>
                  <Copy size={15} />
                </button>
              </div>
            ) : (
              <div className={`connection-prompt ${isRunning ? "is-running" : ""}`}>
                {isRunning ? <LoaderCircle className="spin" size={18} /> : <Figma size={18} />}
                <div>
                  <strong>{isRunning ? t("figma.sync.runningState") : t("figma.sync.waitingState")}</strong>
                  <span>
                    {isRunning
                      ? t("figma.sync.runningStateText", {
                        count: session.screenCount,
                        unit: isPull ? t("figma.sync.compare") : t("figma.sync.push")
                      })
                      : t("figma.sync.waitingSubtext")}
                  </span>
                </div>
              </div>
            )}
            <div className="connection-shortcuts">
              <button type="button" className="primary-button" onClick={onOpenFigma}>
                <ExternalLink size={14} /> {t("figma.sync.openFigma")}
              </button>
              <button type="button" className="secondary-button" onClick={onShowPlugin}>
                <Figma size={14} /> {t("figma.sync.openPlugin")}
              </button>
            </div>
            {!session.requiresPairing && !isRunning && (
              <details className="pairing-fallback">
                <summary>{t("figma.sync.notAutoConnected")}</summary>
                <div>
                  <span>{t("figma.sync.manualPairing")}</span>
                  <strong>{session.pairingCode.slice(0, 3)} {session.pairingCode.slice(3)}</strong>
                  <button type="button" className="icon-button" onClick={onCopyCode} aria-label={t("figma.sync.copyPairingCode")}>
                    <Copy size={14} />
                  </button>
                </div>
              </details>
            )}
          </>
        )}

        {isComplete && (
          <div className="automatic-result">
            <Check size={18} />
            <div>
              <strong>
                {isPull
                  ? t("figma.sync.completePullCount", { count: status.renderedCount ?? 0 })
                  : t("figma.sync.completePushCount", { count: status.renderedCount ?? 0 })}
              </strong>
              <span>
                {isPull
                  ? t("figma.sync.completePullNote")
                  : t("figma.sync.completePushNote", {
                    createdCount: status.createdCount ?? 0,
                    reusedCount: status.reusedCount ?? 0
                  })}
              </span>
            </div>
          </div>
        )}

        {isComplete && (status.substitutedFonts?.length ?? 0) > 0 && (
          <p className="dialog-note">
            {t("figma.sync.substitutedFonts", { fonts: status.substitutedFonts!.join(t("common.separator")) })}
          </p>
        )}

        {hasFailed && (
          <div className="automatic-error">
            <AlertCircle size={17} />
            <p>
              <strong>{status.state === "expired" ? t("figma.sync.pairingExpired") : t("figma.sync.mappingNotLinked")}</strong>
              <span>{status.message ?? t("figma.sync.retryMessage")}</span>
            </p>
          </div>
        )}

        <div className="dialog-actions">
          {hasFailed ? (
            <button type="button" className="primary-button" onClick={onRestart}>
              <RefreshCw size={14} /> {t("common.retry")}
            </button>
          ) : (
            <button type="button" className={isComplete ? "primary-button" : "secondary-button"} onClick={onClose}>
              {isComplete ? t("common.done") : t("common.close")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
