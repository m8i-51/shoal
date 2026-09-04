import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../api";

interface RunExperience {
  runId: string;
  timestamp: string;
  score: number;
  achievementRate: number | null;
  avgIterations: number | null;
  regressionRate: number | null;
}

interface ExperienceScore {
  latest: RunExperience;
  delta: number | null;
  trend: RunExperience[];
}

function scoreColor(score: number): string {
  // Darker than the usual green/amber/red "500" shade — this is used as text
  // color on a white background, where the lighter shades fail WCAG AA
  // contrast (2.2-2.6:1, need 4.5:1).
  return score >= 70 ? "#15803d" : score >= 40 ? "#b45309" : "#dc2626";
}

function Sparkline({ trend }: { trend: RunExperience[] }) {
  if (trend.length < 2) return null;
  const w = 160;
  const h = 36;
  const pad = 3;
  const scores = trend.map((t) => t.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min || 1;
  const points = scores
    .map((s, i) => {
      const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
      const y = h - pad - ((s - min) / range) * (h - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  const last = points.split(" ").pop()!.split(",");
  return (
    <svg width={w} height={h} style={{ display: "block" }} aria-hidden="true">
      <polyline points={points} fill="none" stroke="#94a3b8" strokeWidth="1.5" />
      <circle cx={last[0]} cy={last[1]} r="2.5" fill={scoreColor(scores[scores.length - 1])} />
    </svg>
  );
}

export function ExperiencePanel() {
  const { t } = useTranslation();
  const [exp, setExp] = useState<ExperienceScore | null>(null);

  useEffect(() => {
    apiFetch("/api/experience")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ExperienceScore | null) => {
        if (data) setExp(data);
      })
      .catch(() => {});
  }, []);

  if (!exp) return null;

  const { latest, delta, trend } = exp;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>{t("experience.title")}</span>
        <span style={styles.runCount}>{t("experience.runCount", { count: trend.length })}</span>
      </div>
      <div style={styles.body}>
        <div style={styles.scoreBlock}>
          <span style={{ ...styles.score, color: scoreColor(latest.score) }}>{latest.score}</span>
          <span style={styles.scoreMax}>/100</span>
          {delta != null && (
            <span style={{ ...styles.delta, color: delta > 0 ? "#15803d" : delta < 0 ? "#dc2626" : "#475569" }}>
              {delta > 0 ? `▲${delta}` : delta < 0 ? `▼${Math.abs(delta)}` : "±0"}
            </span>
          )}
        </div>
        <Sparkline trend={trend} />
        <div style={styles.subStats}>
          {latest.achievementRate != null && (
            <span style={styles.subStat}>
              {t("experience.achievement")}: <strong>{Math.round(latest.achievementRate * 100)}%</strong>
            </span>
          )}
          {latest.avgIterations != null && (
            <span style={styles.subStat}>
              {t("experience.friction")}: <strong>{latest.avgIterations}</strong>
            </span>
          )}
          {latest.regressionRate != null && (
            <span style={styles.subStat}>
              {t("experience.regression")}: <strong>{Math.round(latest.regressionRate * 100)}%</strong>
            </span>
          )}
        </div>
      </div>
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
    color: "#475569",
  },
  body: {
    display: "flex",
    alignItems: "center",
    gap: "1.5rem",
    flexWrap: "wrap" as const,
  },
  scoreBlock: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.35rem",
  },
  score: {
    fontSize: "2rem",
    fontWeight: 700,
    lineHeight: 1,
  },
  scoreMax: {
    fontSize: "0.8rem",
    color: "#475569",
  },
  delta: {
    fontSize: "0.85rem",
    fontWeight: 700,
    marginLeft: "0.25rem",
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
} as const;
