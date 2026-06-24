import { useParams, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useEffect, useRef, useState } from "react";
import { SwarmVisualizer } from "../components/SwarmVisualizer";

type Tab = "log" | "swarm" | "report" | "diary";

export function RunDetail() {
  const { runId } = useParams<{ runId: string }>();
  const navigate = useNavigate();
  const { t } = useTranslation();

  const [tab, setTab] = useState<Tab>("log");
  const [logLines, setLogLines] = useState<string[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [done, setDone] = useState(false);
  const [hasReport, setHasReport] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const [diaryContent, setDiaryContent] = useState<string | null>(null);
  const [diaryLoading, setDiaryLoading] = useState(false);
  const [diaryError, setDiaryError] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  const handleGenerateDiary = async () => {
    setDiaryLoading(true);
    setDiaryError(false);
    try {
      const res = await fetch(`/api/runs/${runId}/diary`, { method: "POST" });
      const data = await res.json();
      if (data.content) setDiaryContent(data.content);
      else setDiaryError(true);
    } catch {
      setDiaryError(true);
    } finally {
      setDiaryLoading(false);
    }
  };

  const handleCancelConfirm = async () => {
    setCancelling(true);
    setConfirmingCancel(false);
    await fetch(`/api/runs/${runId}/cancel`, { method: "POST" }).catch(() => {});
  };

  // 初回: バッファ済みログを取得
  useEffect(() => {
    fetch(`/api/runs/${runId}/log`)
      .then((r) => r.json())
      .then((data: { lines?: string[]; done?: boolean }) => {
        setLogLines(Array.isArray(data.lines) ? data.lines : []);
        setDone(data.done ?? false);
        if (!data.done) setIsLive(true);
      })
      .catch(() => {});

    // レポートの存在確認
    fetch(`/api/runs/${runId}/report`, { method: "HEAD" })
      .then((r) => setHasReport(r.ok))
      .catch(() => {});
  }, [runId]);

  // ライブ中: SSE で追記、繋がらない場合は 2 秒ポーリングにフォールバック
  useEffect(() => {
    if (!isLive) return;

    let closed = false;
    const es = new EventSource(`/api/runs/${runId}/events`);

    const onDone = () => {
      setDone(true);
      setIsLive(false);
      es.close();
      fetch(`/api/runs/${runId}/report`, { method: "HEAD" })
        .then((r) => setHasReport(r.ok))
        .catch(() => {});
    };

    es.onmessage = (e) => {
      const line: string = JSON.parse(e.data);
      setLogLines((prev) => [...prev, line]);
    };
    es.addEventListener("done", onDone);

    // SSE が 3 秒で繋がらない or エラーの場合はポーリングへ切り替え
    const sseTimer = setTimeout(() => {
      if (es.readyState !== EventSource.OPEN) {
        es.close();
        startPolling();
      }
    }, 3000);

    es.onerror = () => {
      clearTimeout(sseTimer);
      es.close();
      if (!closed) startPolling();
    };

    function startPolling() {
      let lastCount = 0;
      const id = setInterval(async () => {
        if (closed) { clearInterval(id); return; }
        try {
          const res = await fetch(`/api/runs/${runId}/log`);
          if (!res.ok) return;
          const data: { lines: string[]; done: boolean } = await res.json();
          if (data.lines.length > lastCount) {
            setLogLines(data.lines);
            lastCount = data.lines.length;
          }
          if (data.done) {
            clearInterval(id);
            setDone(true);
            setIsLive(false);
            fetch(`/api/runs/${runId}/report`, { method: "HEAD" })
              .then((r) => setHasReport(r.ok))
              .catch(() => {});
          }
        } catch { /* ignore */ }
      }, 2000);
      return () => clearInterval(id);
    }

    return () => {
      closed = true;
      clearTimeout(sseTimer);
      es.close();
    };
  }, [isLive, runId]);

  // ログ自動スクロール
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logLines]);

  // 日誌タブに切り替えた時、既存の日誌ファイルを取得
  useEffect(() => {
    if (tab !== "diary" || diaryContent) return;
    fetch(`/api/runs/${runId}/diary`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => { if (data?.content) setDiaryContent(data.content); })
      .catch(() => {});
  }, [tab, runId, diaryContent]);

  return (
    <div style={styles.wrapper}>
      {/* ツールバー */}
      <div style={styles.toolbar}>
        <button onClick={() => navigate("/")} style={styles.backBtn}>
          {t("detail.back")}
        </button>
        <span style={styles.runId}>{runId}</span>
        {isLive && <span style={styles.liveBadge}>● LIVE</span>}
        {isLive && !confirmingCancel && (
          <button onClick={() => setConfirmingCancel(true)} style={styles.cancelBtn} disabled={cancelling}>
            {cancelling ? "…" : t("detail.cancel")}
          </button>
        )}
        {isLive && confirmingCancel && (
          <div style={styles.cancelConfirm}>
            <span style={styles.cancelConfirmLabel}>{t("detail.cancelConfirmLabel")}</span>
            <button onClick={handleCancelConfirm} style={styles.cancelConfirmYes}>
              {t("detail.cancelConfirmYes")}
            </button>
            <button onClick={() => setConfirmingCancel(false)} style={styles.cancelConfirmNo}>
              {t("detail.cancelConfirmNo")}
            </button>
          </div>
        )}
      </div>

      {/* タブ */}
      <div style={styles.tabs}>
        <button
          style={{ ...styles.tab, ...(tab === "log" ? styles.tabActive : {}) }}
          onClick={() => setTab("log")}
        >
          {t("detail.tabLog")}
        </button>
        <button
          style={{ ...styles.tab, ...(tab === "swarm" ? styles.tabActive : {}) }}
          onClick={() => setTab("swarm")}
        >
          {t("detail.tabSwarm")}
        </button>
        <button
          style={{ ...styles.tab, ...(tab === "report" ? styles.tabActive : {}), ...(hasReport ? {} : styles.tabDisabled) }}
          onClick={() => hasReport && setTab("report")}
          disabled={!hasReport}
        >
          {t("detail.tabReport")}
        </button>
        <button
          style={{ ...styles.tab, ...(tab === "diary" ? styles.tabActive : {}), ...(!done ? styles.tabDisabled : {}) }}
          onClick={() => done && setTab("diary")}
          disabled={!done}
        >
          {t("detail.tabDiary")}
        </button>
      </div>

      {/* コンテンツ */}
      {tab === "swarm" && (
        <SwarmVisualizer logLines={logLines} isLive={isLive} />
      )}

      {tab === "log" && (
        <div ref={logRef} style={styles.log}>
          {logLines.length === 0 && !isLive && (
            <p style={styles.logEmpty}>{t("detail.noLog")}</p>
          )}
          {logLines.map((line, i) => (
            <div key={i} style={styles.logLine}>{line}</div>
          ))}
          {isLive && <div style={styles.cursor}>▌</div>}
          {done && logLines.length > 0 && (
            <div style={styles.logDone}>— {t("status.completed")} —</div>
          )}
        </div>
      )}

      {tab === "report" && (
        <iframe
          src={`/api/runs/${runId}/report`}
          style={styles.frame}
          title={`Report for ${runId}`}
        />
      )}

      {tab === "diary" && (
        <div style={styles.diaryWrapper}>
          {!diaryContent && !diaryLoading && (
            <div style={styles.diaryPrompt}>
              <p style={styles.diaryHint}>{t("detail.diaryHint")}</p>
              {diaryError && <p style={styles.diaryErrMsg}>{t("detail.diaryError")}</p>}
              <button onClick={handleGenerateDiary} style={styles.generateBtn}>
                {t("detail.generateDiary")}
              </button>
            </div>
          )}
          {diaryLoading && (
            <div style={styles.diaryLoading}>{t("detail.generatingDiary")}</div>
          )}
          {diaryContent && (
            <pre style={styles.diaryContent}>{diaryContent}</pre>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  wrapper: {
    display: "flex",
    flexDirection: "column" as const,
    height: "calc(100vh - 52px)",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "0.75rem 2rem",
    borderBottom: "1px solid #e2e8f0",
    background: "#fff",
  },
  backBtn: {
    background: "transparent",
    border: "none",
    color: "#475569",
    fontSize: "0.875rem",
    fontWeight: 600,
    padding: 0,
    cursor: "pointer",
  },
  runId: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    fontFamily: "monospace",
  },
  liveBadge: {
    fontSize: "0.7rem",
    fontWeight: 700,
    color: "#22c55e",
    letterSpacing: "0.05em",
  },
  cancelBtn: {
    background: "transparent",
    border: "1px solid #ef4444",
    color: "#ef4444",
    borderRadius: "6px",
    padding: "3px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
    marginLeft: "auto",
  },
  cancelConfirm: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginLeft: "auto",
  },
  cancelConfirmLabel: {
    fontSize: "0.75rem",
    color: "#64748b",
    fontWeight: 600,
  },
  cancelConfirmYes: {
    background: "#ef4444",
    border: "none",
    color: "#fff",
    borderRadius: "6px",
    padding: "3px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  cancelConfirmNo: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    color: "#64748b",
    borderRadius: "6px",
    padding: "3px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  tabs: {
    display: "flex",
    gap: 0,
    background: "#fff",
    borderBottom: "1px solid #e2e8f0",
    padding: "0 2rem",
  },
  tab: {
    background: "transparent",
    border: "none",
    borderBottom: "2px solid transparent",
    padding: "0.625rem 1rem",
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#94a3b8",
    cursor: "pointer",
    marginBottom: "-1px",
  },
  tabActive: {
    color: "#1e293b",
    borderBottomColor: "#1e293b",
  },
  tabDisabled: {
    opacity: 0.4,
    cursor: "default",
  },
  log: {
    flex: 1,
    overflowY: "auto" as const,
    background: "#0f172a",
    padding: "1.25rem 1.5rem",
    fontFamily: "monospace",
    fontSize: "0.8rem",
    lineHeight: 1.7,
  },
  logEmpty: {
    color: "#475569",
  },
  logLine: {
    color: "#94a3b8",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-all" as const,
  },
  cursor: {
    color: "#22c55e",
  },
  logDone: {
    color: "#475569",
    marginTop: "1rem",
    textAlign: "center" as const,
    fontSize: "0.75rem",
  },
  frame: {
    flex: 1,
    width: "100%",
    border: "none",
  },
  diaryWrapper: {
    flex: 1,
    overflowY: "auto" as const,
    background: "#f8fafc",
  },
  diaryPrompt: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "center",
    justifyContent: "center",
    gap: "1rem",
    height: "100%",
    minHeight: "200px",
    padding: "3rem 2rem",
  },
  diaryHint: {
    fontSize: "0.875rem",
    color: "#64748b",
    textAlign: "center" as const,
    maxWidth: "400px",
  },
  diaryErrMsg: {
    fontSize: "0.8rem",
    color: "#ef4444",
  },
  generateBtn: {
    background: "#1e293b",
    color: "#f8fafc",
    border: "none",
    borderRadius: "8px",
    padding: "0.6rem 1.5rem",
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  diaryLoading: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    height: "100%",
    minHeight: "200px",
    fontSize: "0.875rem",
    color: "#64748b",
  },
  diaryContent: {
    margin: "0 auto",
    maxWidth: "720px",
    padding: "2rem",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: "0.9rem",
    lineHeight: 1.8,
    color: "#1e293b",
    whiteSpace: "pre-wrap" as const,
    wordBreak: "break-word" as const,
    background: "transparent",
    border: "none",
  },
} as const;
