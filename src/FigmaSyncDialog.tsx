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
        <button type="button" className="icon-button dialog-close" aria-label="关闭" onClick={onClose}>
          <X size={16} />
        </button>
        <div className="dialog-copy">
          <span>FIGMA 同步</span>
          <h2 id="automatic-mapping-title">
            {isComplete
              ? isPull ? "已读取 Figma 的改动" : "已送进 Figma"
              : isRunning
                ? isPull ? "正在读取 Figma…" : "正在送进 Figma…"
                : hasFailed
                  ? "这次同步没有完成"
                  : session.requiresPairing ? "第一次使用，先连接 Figma" : "在 Figma 里打开 Crank 插件"}
          </h2>
          <p>
            {isComplete
              ? isPull ? "对比结果已经准备好，可以查看。本地文件还没有任何改动。" : "页面已经送到，每一页都记住了自己对应的画框。"
              : isRunning
                ? isPull ? "保持 Figma 打开。Crank 只读取它记住的那些可编辑图层。" : "保持 Figma 打开，Crank 正在更新已关联的页面。"
                : hasFailed
                  ? "什么都没有改动。在 Figma 里打开 Crank 插件，然后重试。"
                  : session.requiresPairing
                    ? "输入一次这个配对码即可。这台 Mac 上的所有项目之后都会记住这个连接。"
                    : `在 ${fileName} 里打开 Crank 插件，就会开始。`}
          </p>
          {note && <p className="dialog-note">{note}</p>}
        </div>

        {!isComplete && !hasFailed && (
          <>
            {session.requiresPairing ? (
              <div className="pairing-code-block">
                <span>一次性配对码</span>
                <strong>{session.pairingCode.slice(0, 3)} {session.pairingCode.slice(3)}</strong>
                <button type="button" className="icon-button" aria-label="复制配对码" title="复制配对码" onClick={onCopyCode}>
                  <Copy size={15} />
                </button>
              </div>
            ) : (
              <div className={`connection-prompt ${isRunning ? "is-running" : ""}`}>
                {isRunning ? <LoaderCircle className="spin" size={18} /> : <Figma size={18} />}
                <div><strong>{isRunning ? (isPull ? "正在读取已关联的图层" : "正在送出页面") : "等待 Figma 插件"}</strong><span>{isRunning ? `${session.screenCount} 个页面${isPull ? "正在比对" : "正在更新"}` : "不需要配对码，这台设备的连接已经记住了"}</span></div>
              </div>
            )}
            <div className="connection-shortcuts">
              <button type="button" className="primary-button" onClick={onOpenFigma}><ExternalLink size={14} /> 打开 Figma</button>
              <button type="button" className="secondary-button" onClick={onShowPlugin}><Figma size={14} /> 找到插件</button>
            </div>
            {!session.requiresPairing && !isRunning && (
              <details className="pairing-fallback">
                <summary>插件没有自动连上？</summary>
                <div><span>手动输入配对码</span><strong>{session.pairingCode.slice(0, 3)} {session.pairingCode.slice(3)}</strong><button type="button" className="icon-button" onClick={onCopyCode} aria-label="复制配对码"><Copy size={14} /></button></div>
              </details>
            )}
          </>
        )}

        {isComplete && (
          <div className="automatic-result">
            <Check size={18} />
            <div><strong>{isPull ? `已读取 ${status.renderedCount ?? 0} 个页面` : `已送出 ${status.renderedCount ?? 0} 个页面`}</strong><span>{isPull ? "可以在本地查看对比结果" : `新建画框 ${status.createdCount ?? 0} 个 · 复用已有画框 ${status.reusedCount ?? 0} 个`}</span></div>
          </div>
        )}

        {isComplete && (status.substitutedFonts?.length ?? 0) > 0 && (
          <p className="dialog-note">
            Figma 里没有 {status.substitutedFonts!.join("、")}，这些文字用了最接近的替代字体。
          </p>
        )}

        {hasFailed && (
          <div className="automatic-error">
            <AlertCircle size={17} />
            <p><strong>{status.state === "expired" ? "配对码已过期" : "画框没有关联成功"}</strong><span>{status.message ?? "重新生成一个配对码再试一次。"}</span></p>
          </div>
        )}

        <div className="dialog-actions">
          {hasFailed ? (
            <button type="button" className="primary-button" onClick={onRestart}><RefreshCw size={14} /> 重试</button>
          ) : (
            <button type="button" className={isComplete ? "primary-button" : "secondary-button"} onClick={onClose}>
              {isComplete ? "完成" : "关闭"}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
