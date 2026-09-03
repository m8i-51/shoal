import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../api";
import { CATEGORY_COLOR, safeExternalUrl } from "../utils/format";

interface TriageFindingRef {
  id: string;
  title: string | null;
  agentName: string | null;
  category: string | null;
}

interface TriageIssue {
  title: string;
  category: string;
  url: string | null;
  edgeRisk: { edge: string; why: string } | null;
  createdAt: string | null;
  mergedFindings: TriageFindingRef[];
}

interface TriageSkip extends TriageFindingRef {
  reason: string | null;
}

interface TriageView {
  runId: string;
  completedAt: string | null;
  issues: TriageIssue[];
  skips: TriageSkip[];
  unprocessed: TriageFindingRef[];
  stats: {
    issuesCreated: number;
    findingsIssued: number;
    findingsSkipped: number;
    findingsUnprocessed: number;
    edgeRisks: number;
  };
  legacy: boolean;
}

const EDGE_RISK_COLOR = "#a855f7";

function CategoryChip({ category }: { category: string }) {
  return (
    <span style={{ ...styles.chip, background: CATEGORY_COLOR[category] ?? "#6b7280" }}>
      {category}
    </span>
  );
}

/** A finding as triage saw it — title when we still have the file, ID otherwise. */
function FindingLine({ finding }: { finding: TriageFindingRef }) {
  return (
    <li style={styles.mergedItem}>
      <span style={styles.mergedTitle}>{finding.title ?? finding.id}</span>
      {finding.agentName && <span style={styles.mergedAgent}>— {finding.agentName}</span>}
    </li>
  );
}

/**
 * `refreshKey` re-fetches when the run finishes, so a tab opened mid-run picks
 * up the triage result instead of showing the "not triaged yet" notice forever.
 */
export function TriageResultPanel({ runId, refreshKey }: { runId: string; refreshKey?: string }) {
  const { t } = useTranslation();
  const [view, setView] = useState<TriageView | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty">("loading");

  useEffect(() => {
    let cancelled = false;
    apiFetch(`/api/runs/${runId}/triage`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: TriageView | null) => {
        if (cancelled) return;
        if (data) {
          setView(data);
          setState("ready");
        } else {
          setState("empty");
        }
      })
      .catch(() => { if (!cancelled) setState("empty"); });
    return () => { cancelled = true; };
  }, [runId, refreshKey]);

  if (state === "loading") return <div style={styles.notice}>{t("triage.loading")}</div>;
  if (state === "empty" || !view) return <div style={styles.notice}>{t("triage.none")}</div>;

  const { stats } = view;

  return (
    <div style={styles.wrapper}>
      <div style={styles.stats}>
        <Stat label={t("triage.statIssues")} value={stats.issuesCreated} />
        <Stat label={t("triage.statIssued")} value={stats.findingsIssued} />
        <Stat label={t("triage.statSkipped")} value={stats.findingsSkipped} />
        <Stat label={t("triage.statUnprocessed")} value={stats.findingsUnprocessed} />
        {stats.edgeRisks > 0 && (
          <Stat label={t("triage.statEdgeRisks")} value={stats.edgeRisks} color={EDGE_RISK_COLOR} />
        )}
      </div>

      {view.legacy && <p style={styles.legacy}>{t("triage.legacy")}</p>}

      {view.issues.length > 0 && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>{t("triage.issuesTitle")}</h3>
          {view.issues.map((issue, i) => (
            <article key={`${issue.title}-${i}`} style={styles.issue}>
              <div style={styles.issueHead}>
                <CategoryChip category={issue.category} />
                {safeExternalUrl(issue.url) ? (
                  <a href={safeExternalUrl(issue.url)!} target="_blank" rel="noreferrer noopener" style={styles.issueLink}>
                    {issue.title}
                  </a>
                ) : (
                  <span style={styles.issueTitle}>{issue.title}</span>
                )}
                {issue.edgeRisk && <span style={styles.edgeBadge}>edge-risk</span>}
              </div>

              {issue.edgeRisk && (
                <div style={styles.edgeBox}>
                  <div style={styles.edgeLabel}>{t("triage.edgeAtStake")}</div>
                  <div style={styles.edgeValue}>{issue.edgeRisk.edge}</div>
                  <div style={styles.edgeWhy}>{issue.edgeRisk.why}</div>
                </div>
              )}

              <div style={styles.mergedHead}>
                {t("triage.mergedFrom", { count: issue.mergedFindings.length })}
              </div>
              <ul style={styles.mergedList}>
                {issue.mergedFindings.map((f) => <FindingLine key={f.id} finding={f} />)}
              </ul>

              {!issue.url && <div style={styles.noTracker}>{t("triage.noTracker")}</div>}
            </article>
          ))}
        </section>
      )}

      {view.skips.length > 0 && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>{t("triage.skippedTitle")}</h3>
          <ul style={styles.plainList}>
            {view.skips.map((s) => (
              <li key={s.id} style={styles.plainItem}>
                <span style={styles.plainTitle}>{s.title ?? s.id}</span>
                <span style={styles.plainReason}>{s.reason ?? t("triage.noReason")}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.unprocessed.length > 0 && (
        <section style={styles.section}>
          <h3 style={styles.sectionTitle}>{t("triage.unprocessedTitle")}</h3>
          <p style={styles.sectionHint}>{t("triage.unprocessedHint")}</p>
          <ul style={styles.plainList}>
            {view.unprocessed.map((f) => (
              <li key={f.id} style={styles.plainItem}>
                <span style={styles.plainTitle}>{f.title ?? f.id}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div style={styles.stat}>
      <span style={{ ...styles.statValue, ...(color ? { color } : {}) }}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
    </div>
  );
}

const styles = {
  wrapper: {
    flex: 1,
    overflowY: "auto" as const,
    padding: "1.5rem 2rem",
    background: "#f8fafc",
  },
  notice: {
    flex: 1,
    padding: "2.5rem 2rem",
    color: "#94a3b8",
    fontSize: "0.85rem",
    textAlign: "center" as const,
  },
  stats: {
    display: "flex",
    gap: "2rem",
    flexWrap: "wrap" as const,
    padding: "0.9rem 1.25rem",
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
    marginBottom: "1.25rem",
  },
  stat: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.15rem",
  },
  statValue: {
    fontSize: "1.4rem",
    fontWeight: 700,
    lineHeight: 1,
    color: "#0f172a",
  },
  statLabel: {
    fontSize: "0.7rem",
    color: "#64748b",
  },
  legacy: {
    fontSize: "0.75rem",
    color: "#92400e",
    background: "#fef3c7",
    border: "1px solid #fde68a",
    borderRadius: "6px",
    padding: "0.6rem 0.85rem",
    margin: "0 0 1.25rem",
  },
  section: {
    marginBottom: "1.75rem",
  },
  sectionTitle: {
    fontSize: "0.7rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "#64748b",
    margin: "0 0 0.6rem",
  },
  sectionHint: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    margin: "0 0 0.6rem",
  },
  issue: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
    padding: "0.9rem 1.1rem",
    marginBottom: "0.75rem",
  },
  issueHead: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    flexWrap: "wrap" as const,
  },
  chip: {
    fontSize: "0.65rem",
    fontWeight: 700,
    color: "#fff",
    borderRadius: "4px",
    padding: "0.1rem 0.4rem",
    letterSpacing: "0.02em",
  },
  issueTitle: {
    fontSize: "0.9rem",
    fontWeight: 600,
    color: "#0f172a",
  },
  issueLink: {
    fontSize: "0.9rem",
    fontWeight: 600,
    color: "#2563eb",
    textDecoration: "none",
  },
  edgeBadge: {
    fontSize: "0.65rem",
    fontWeight: 700,
    color: EDGE_RISK_COLOR,
    border: `1px solid ${EDGE_RISK_COLOR}`,
    borderRadius: "4px",
    padding: "0.05rem 0.35rem",
  },
  edgeBox: {
    marginTop: "0.6rem",
    padding: "0.6rem 0.75rem",
    background: "#faf5ff",
    border: "1px solid #e9d5ff",
    borderRadius: "6px",
  },
  edgeLabel: {
    fontSize: "0.65rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.06em",
    color: EDGE_RISK_COLOR,
  },
  edgeValue: {
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#0f172a",
    marginTop: "0.15rem",
  },
  edgeWhy: {
    fontSize: "0.78rem",
    color: "#475569",
    marginTop: "0.25rem",
    lineHeight: 1.5,
  },
  mergedHead: {
    fontSize: "0.7rem",
    color: "#94a3b8",
    marginTop: "0.7rem",
  },
  mergedList: {
    listStyle: "none",
    margin: "0.3rem 0 0",
    padding: 0,
  },
  mergedItem: {
    fontSize: "0.8rem",
    color: "#334155",
    padding: "0.15rem 0",
  },
  mergedTitle: {
    marginRight: "0.4rem",
  },
  mergedAgent: {
    color: "#94a3b8",
    fontSize: "0.75rem",
  },
  noTracker: {
    fontSize: "0.7rem",
    color: "#94a3b8",
    marginTop: "0.5rem",
  },
  plainList: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
  },
  plainItem: {
    display: "flex",
    gap: "0.75rem",
    alignItems: "baseline",
    flexWrap: "wrap" as const,
    padding: "0.55rem 1.1rem",
    borderBottom: "1px solid #f1f5f9",
    fontSize: "0.8rem",
  },
  plainTitle: {
    color: "#334155",
  },
  plainReason: {
    color: "#94a3b8",
    fontSize: "0.75rem",
  },
} as const;
