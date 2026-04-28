import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { StartModal } from "../components/StartModal";
import { GoalsPanel } from "../components/GoalsPanel";
import { formatDuration, formatDate, formatCostUSD, CATEGORY_COLOR } from "../utils/format";
import type { RunSummary } from "../types";
import i18n from "../i18n/index";

export function Dashboard() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [showModal, setShowModal] = useState(false);

  const fetchRuns = () => {
    fetch("/api/runs")
      .then((r) => r.json())
      .then((data: RunSummary[]) => {
        const apiIds = new Set(data.map((r: RunSummary) => r.runId));

        // localStorage に保存した実行中 runId を復元
        const savedId = localStorage.getItem("shoal-active-run-id");
        const savedAt = localStorage.getItem("shoal-active-run-started-at");
        const clearLocalRun = () => {
          localStorage.removeItem("shoal-active-run-id");
          localStorage.removeItem("shoal-active-run-started-at");
        };
        let localLive: RunSummary[] = [];
        if (savedId && savedAt) {
          const ageMin = (Date.now() - new Date(savedAt).getTime()) / 60000;
          if (apiIds.has(savedId)) {
            // API が把握したらクリア
            clearLocalRun();
          } else if (ageMin > 120) {
            // 2時間以上経っても API に現れなければ古いエントリとしてクリア
            clearLocalRun();
          } else {
            localLive = [{
              runId: savedId,
              startedAt: savedAt,
              completedAt: null,
              status: "running" as const,
              agentCount: 0,
              completedAgents: 0,
              errorAgents: 0,
              findingCount: 0,
              findingsByCategory: {},
              hasReport: false,
              isLive: true,
            }];
          }
        }

        setRuns([...localLive, ...data]);
      })
      .catch(() => {});
  };

  useEffect(() => {
    fetchRuns();
    const id = setInterval(fetchRuns, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <main style={styles.main}>
      <div style={styles.pageHeader}>
        <h1 style={styles.pageTitle}>{t("dashboard.title")}</h1>
        <button onClick={() => setShowModal(true)} style={styles.startBtn}>
          {t("dashboard.startRun")}
        </button>
      </div>

      <GoalsPanel />

      {runs.length === 0 ? (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>{t("dashboard.noRuns")}</p>
          <p style={styles.emptyHint}>{t("dashboard.noRunsHint")}</p>
        </div>
      ) : (
        <div style={styles.tableWrapper}>
          <table style={styles.table}>
            <thead>
              <tr>
                {(["status", "started", "duration", "findings", "agents", "cost", "actions"] as const).map((col) => (
                  <th key={col} style={{ ...styles.th, ...(col === "agents" || col === "findings" || col === "cost" ? { textAlign: "center" } : {}) }}>
                    {t(`table.${col}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <RunRow key={run.runId} run={run} onView={() => navigate(`/runs/${run.runId}`)} />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <StartModal
          onClose={() => setShowModal(false)}
          onStarted={(runId) => {
            setShowModal(false);
            // localStorage に保存して画面遷移後も復元できるようにする
            localStorage.setItem("shoal-active-run-id", runId);
            localStorage.setItem("shoal-active-run-started-at", new Date().toISOString());
            fetchRuns();
          }}
        />
      )}
    </main>
  );
}

function RunRow({ run, onView }: { run: RunSummary; onView: () => void }) {
  const { t } = useTranslation();
  const isRunning = run.status === "running";

  const totalFindings = run.findingCount;
  const categories = Object.entries(run.findingsByCategory);

  return (
    <tr style={styles.row}>
      <td style={styles.td}>
        <span style={{ ...styles.badge, background: isRunning ? "#f59e0b" : "#22c55e" }}>
          {t(`status.${run.status}`)}
        </span>
      </td>
      <td style={{ ...styles.td, ...styles.muted }}>{formatDate(run.startedAt)}</td>
      <td style={{ ...styles.td, ...styles.muted }}>{formatDuration(run.startedAt, run.completedAt, t)}</td>
      <td style={{ ...styles.td, textAlign: "center" }}>
        {totalFindings > 0 ? (
          <span style={styles.findingsGroup}>
            {categories.map(([cat, count]) => (
              <span key={cat} style={{ ...styles.badge, background: CATEGORY_COLOR[cat] ?? "#6b7280" }}>
                {count}
              </span>
            ))}
          </span>
        ) : (
          <span style={styles.muted}>—</span>
        )}
      </td>
      <td style={{ ...styles.td, textAlign: "center", ...styles.muted }}>
        {run.completedAgents}/{run.agentCount}
      </td>
      <td style={{ ...styles.td, textAlign: "center", ...styles.muted }}>
        {formatCostUSD(run.estimatedCostUSD)}
      </td>
      <td style={styles.td}>
        <button onClick={onView} style={styles.viewBtn}>
          {run.isLive
            ? (i18n.language === "ja" ? "ログ →" : "Log →")
            : (i18n.language === "ja" ? "表示 →" : "View →")}
        </button>
      </td>
    </tr>
  );
}

const styles = {
  main: {
    maxWidth: "960px",
    margin: "0 auto",
    padding: "2rem",
  },
  pageHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "1.5rem",
  },
  pageTitle: {
    fontSize: "1rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "#64748b",
  },
  startBtn: {
    background: "#1e293b",
    color: "#f8fafc",
    border: "none",
    borderRadius: "6px",
    padding: "8px 16px",
    fontWeight: 600,
    fontSize: "0.875rem",
  },
  empty: {
    textAlign: "center" as const,
    padding: "4rem 2rem",
    color: "#94a3b8",
  },
  emptyTitle: {
    fontSize: "1rem",
    fontWeight: 600,
    marginBottom: "0.5rem",
  },
  emptyHint: {
    fontSize: "0.875rem",
  },
  tableWrapper: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
    overflow: "hidden",
  },
  table: {
    width: "100%",
    borderCollapse: "collapse" as const,
    fontSize: "0.875rem",
  },
  th: {
    background: "#f1f5f9",
    padding: "0.6rem 1rem",
    textAlign: "left" as const,
    fontWeight: 700,
    color: "#64748b",
    fontSize: "0.7rem",
    textTransform: "uppercase" as const,
    letterSpacing: "0.05em",
    borderBottom: "1px solid #e2e8f0",
  },
  row: {
    borderTop: "1px solid #e2e8f0",
  },
  td: {
    padding: "0.75rem 1rem",
    verticalAlign: "middle" as const,
  },
  muted: {
    color: "#64748b",
  },
  badge: {
    display: "inline-block",
    padding: "0.15rem 0.5rem",
    borderRadius: "9999px",
    fontSize: "0.65rem",
    fontWeight: 700,
    color: "#fff",
    whiteSpace: "nowrap" as const,
  },
  findingsGroup: {
    display: "inline-flex",
    gap: "4px",
    alignItems: "center",
  },
  viewBtn: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    color: "#475569",
    borderRadius: "6px",
    padding: "4px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
} as const;
