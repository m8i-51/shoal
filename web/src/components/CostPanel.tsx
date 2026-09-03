import { useTranslation } from "react-i18next";
import { formatCostUSD } from "../utils/format";
import { computeCostStats, formatTokens } from "../utils/cost-stats";
import type { RunSummary } from "../types";

/** Cost is a magnitude from zero, so bars rather than a line. */
function CostBars({ trend }: { trend: { runId: string; cost: number }[] }) {
  if (trend.length < 2) return null;
  const max = Math.max(...trend.map((t) => t.cost));
  if (max <= 0) return null;

  return (
    <div style={styles.bars} aria-hidden="true">
      {trend.map((t) => (
        <div
          key={t.runId}
          style={{
            ...styles.bar,
            height: `${Math.max(2, (t.cost / max) * 100)}%`,
          }}
          title={`${t.runId}: ${formatCostUSD(t.cost)}`}
        />
      ))}
    </div>
  );
}

export function CostPanel({ runs }: { runs: RunSummary[] }) {
  const { t } = useTranslation();
  const stats = computeCostStats(runs);
  if (!stats) return null;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>{t("cost.title")}</span>
        <span style={styles.runCount}>{t("cost.runCount", { count: stats.runsWithCost })}</span>
      </div>

      <div style={styles.body}>
        <div style={styles.totalBlock}>
          <span style={styles.total}>{formatCostUSD(stats.total)}</span>
          <span style={styles.totalLabel}>{t("cost.total")}</span>
        </div>

        <CostBars trend={stats.trend} />

        <div style={styles.subStats}>
          <span style={styles.subStat}>
            {t("cost.average")}: <strong>{formatCostUSD(stats.average)}</strong>
          </span>
          <span style={styles.subStat}>
            {t("cost.last30d")}: <strong>{formatCostUSD(stats.last30d)}</strong>
          </span>
          {(stats.inputTokens > 0 || stats.outputTokens > 0) && (
            <span style={styles.subStat}>
              {t("cost.tokens")}:{" "}
              <strong>{formatTokens(stats.inputTokens)}</strong>
              {" / "}
              <strong>{formatTokens(stats.outputTokens)}</strong>
            </span>
          )}
        </div>
      </div>

      {stats.runsWithoutCost > 0 && (
        <p style={styles.caveat}>{t("cost.missing", { count: stats.runsWithoutCost })}</p>
      )}
    </div>
  );
}

const styles = {
  panel: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
    padding: "1rem 1.25rem",
    marginBottom: "1.5rem",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.6rem",
  },
  title: {
    fontSize: "0.7rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "#64748b",
  },
  runCount: {
    fontSize: "0.7rem",
    color: "#94a3b8",
  },
  body: {
    display: "flex",
    alignItems: "center",
    gap: "1.5rem",
    flexWrap: "wrap" as const,
  },
  totalBlock: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.4rem",
  },
  total: {
    fontSize: "2rem",
    fontWeight: 700,
    lineHeight: 1,
    color: "#0f172a",
  },
  totalLabel: {
    fontSize: "0.75rem",
    color: "#94a3b8",
  },
  bars: {
    display: "flex",
    alignItems: "flex-end",
    gap: "2px",
    height: "36px",
    width: "160px",
  },
  bar: {
    flex: 1,
    background: "#cbd5e1",
    borderRadius: "1px",
    minWidth: "2px",
    // Without a cap, a two-run history renders as two fat slabs rather than a chart.
    maxWidth: "10px",
  },
  subStats: {
    display: "flex",
    gap: "1rem",
    flexWrap: "wrap" as const,
    fontSize: "0.8rem",
    color: "#64748b",
  },
  subStat: {
    whiteSpace: "nowrap" as const,
  },
  caveat: {
    fontSize: "0.72rem",
    color: "#94a3b8",
    margin: "0.75rem 0 0",
  },
} as const;
