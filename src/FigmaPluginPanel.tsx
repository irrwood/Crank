import { AlertCircle, Check, Copy, ExternalLink, Figma, LoaderCircle, Unplug, X } from "lucide-react";
import { useT } from "./lib/locale";
import type { FigmaConnection } from "./types";

/**
 * The state of the connection to Figma, on its own rather than mid-sync.
 *
 * The pairing is device-level and has always been remembered on disk, but the
 * only place it was ever visible was inside a sync that was already running —
 * as the presence or absence of a code. "Is this connected?" and "how do I
 * install the plugin?" had no answer that did not begin with sending pages
 * somewhere.
 *
 * A code can be had here without sending anything, which is the order someone
 * actually does this in: install the plugin, connect, and only then have pages
 * worth sending. Requiring a batch of pages first meant the connection could
 * only be made by accident, in the middle of doing something else.
 */
export function FigmaPluginPanel({
  connection,
  pairingCode,
  pairing,
  pairingStalled,
  onClose,
  onShowPlugin,
  onCopyCode,
  onStartPairing,
  onForget
}: {
  connection: FigmaConnection;
  pairingCode: string | null;
  pairing: boolean;
  pairingStalled: boolean;
  onClose: () => void;
  onShowPlugin: () => void;
  onCopyCode: () => void;
  onStartPairing: () => void;
  onForget: () => void;
}) {
  const t = useT();
  return (
    <div className="modal-backdrop" role="presentation">
      <section aria-labelledby="figma-plugin-title" aria-modal="true" className="figma-link-dialog" role="dialog">
        <div className="dialog-icon"><Figma size={18} /></div>
        <button aria-label={t("common.close")} className="icon-button dialog-close" onClick={onClose} type="button">
          <X size={16} />
        </button>
        <div className="dialog-copy">
          <span>{t("figma.plugin.title")}</span>
          <h2 id="figma-plugin-title">
            {connection.connected ? t("figma.plugin.connected") : t("figma.plugin.notConnected")}
          </h2>
          <p>
            {connection.connected
              ? t("figma.plugin.connectedBody")
              : t("figma.plugin.notConnectedBody")}
          </p>
        </div>

        {connection.connected ? (
          <div className="connection-prompt">
            <Check size={18} />
            <div>
              <strong>{t("figma.plugin.remembered")}</strong>
              <span>{t("figma.plugin.connectedFrom", { port: connection.port })}</span>
            </div>
          </div>
        ) : (
          <ol className="plugin-steps">
            <li>
              <strong>{t("figma.plugin.steps.install")}</strong>
              <span>{t("figma.plugin.steps.installBody")}</span>
              <button
                className="secondary-button plugin-community"
                onClick={() => void window.uiSync?.openFigmaPluginPage?.()}
                type="button"
              >
                <ExternalLink size={13} /> {t("figma.plugin.openCommunity")}
              </button>
            </li>
            <li>
              <strong>{t("figma.plugin.steps.run")}</strong>
              <span>{t("figma.plugin.steps.runBody")}</span>
            </li>
            <li>
              <strong>{t("figma.plugin.steps.pair")}</strong>
              <span>{t("figma.plugin.steps.pairBody")}</span>
            </li>
          </ol>
        )}

        {!connection.connected && (pairingCode ? (
          <>
            <div className="pairing-code-block">
              <span>{t("figma.plugin.pairingCode")}</span>
              <strong>{pairingCode.slice(0, 3)} {pairingCode.slice(3)}</strong>
              <button aria-label={t("figma.sync.copyPairingCode")} className="icon-button" onClick={onCopyCode} title={t("figma.sync.copyPairingCode")} type="button">
                <Copy size={15} />
              </button>
            </div>
            <div className={`connection-prompt${pairingStalled ? "" : " is-running"}`}>
              {pairingStalled ? <AlertCircle size={18} /> : <LoaderCircle className="spin" size={18} />}
              <div>
                <strong>{pairingStalled ? t("figma.plugin.pairingStalled") : t("figma.plugin.waitingForCode")}</strong>
                <span>{pairingStalled ? t("figma.plugin.pairingRetry") : t("figma.plugin.enterInFigma")}</span>
              </div>
            </div>
          </>
        ) : (
          <button className="primary-button pairing-start" disabled={pairing} onClick={onStartPairing} type="button">
            {pairing ? <LoaderCircle className="spin" size={14} /> : <Figma size={14} />}
            {pairing ? t("figma.plugin.gettingCode") : t("figma.plugin.getCode")}
          </button>
        ))}

        <div className="connection-shortcuts">
          <button className="secondary-button" onClick={onShowPlugin} type="button">
            <ExternalLink size={14} /> {t("figma.plugin.showPlugin")}
          </button>
          {connection.connected && (
            <button className="secondary-button" onClick={onForget} type="button">
              <Unplug size={14} /> {t("figma.plugin.disconnect")}
            </button>
          )}
        </div>

        <div className="dialog-actions">
          <button className="secondary-button" onClick={onClose} type="button">
            {t("common.close")}
          </button>
        </div>
      </section>
    </div>
  );
}
