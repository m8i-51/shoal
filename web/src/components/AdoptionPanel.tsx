import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../api";
import { CATEGORY_COLOR, safeExternalUrl } from "../utils/format";

interface AdoptionEntry {
  name: string;
  adopted: number;
  rejected: number;
  total: number;
  rate: number;
}

interface ResolvedIssue {
  title: string;
  url: string;
  category: string;
  resolution: "adopted" | "rejected";
  resolvedAt: string | null;
}

interface AdoptionView {
  overall: { adopted: number; rejected: number; total: number; rate: number | null };
  byLens: AdoptionEntry[];
  byCategory: AdoptionEntry[];
  pending: number;
  recent: ResolvedIssue[];
}

type Tab = "lens" | "category" | "recent";

// Darker than the plain "500" shade of green — this doubles as text color
// (the ✓ mark below) on a white background, where the lighter green fails
// WCAG AA contrast (2.3:1, need 4.5:1). Still reads fine as a bar/dot fill.
const ADOPTED_COLOR = "#15803d";
const REJECTED_COLOR = "#cbd5e1";

function rateColor(rate: number): string {
  return rate >= 0.7 ? "#15803d" : rate >= 0.4 ? "#b45309" : "#dc2626";
}

function pct(rate: number): string {
  return `${Math.round(rate * 100)}%`;
}

/** Adopted vs rejected as one track — the same idiom as the site-map coverage bar. */
function RateBar({ entry }: { entry: AdoptionEntry }) {
  const adoptedPct = (entry.adopted / entry.total) * 100;
  return (
    <div style={styles.barTrack} aria-hidden="true">
      {adoptedPct > 0 && (
        <div style={{ ...styles.barSegment, width: `${adoptedPct}%`, background: ADOPTED_COLOR }} />
      )}
      {adoptedPct < 100 && (
        <div style={{ ...styles.barSegment, width: `${100 - adoptedPct}%`, background: REJECTED_COLOR }} />
      )}
    </div>
  );
}

function EntryRow({ entry, chipColor }: { entry: AdoptionEntry; chipColor?: string }) {
  return (
    <div style={styles.row}>
      <span style={styles.rowName}>
        {chipColor && <span style={{ ...styles.dot, background: chipColor }} />}
        {entry.name}
      </span>
      <RateBar entry={entry} />
      <span style={{ ...styles.rowRate, color: rateColor(entry.rate) }}>{pct(entry.rate)}</span>
      <span style={styles.rowCount}>{entry.adopted}/{entry.total}</span>
    </div>
  );
}

export function AdoptionPanel() {
  const { t } = useTranslation();
  const [view, setView] = useState<AdoptionView | null>(null);
  const [tab, setTab] = useState<Tab>("lens");

  useEffect(() => {
    apiFetch("/api/adoption")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: AdoptionView | null) => { if (data) setView(data); })
      .catch(() => {});
  }, []);

  if (!view) return null;

  const { overall } = view;
  // Nothing has come back from the tracker yet: show the pipeline, not a 0%.
  const awaitingFirstResolution = overall.total === 0;

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: "lens", label: t("adoption.byLens"), count: view.byLens.length },
    { key: "category", label: t("adoption.byCategory"), count: view.byCategory.length },
    { key: "recent", label: t("adoption.recent"), count: view.recent.length },
  ];

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>{t("adoption.title")}</span>
        <span style={styles.pending}>{t("adoption.pending", { count: view.pending })}</span>
      </div>

      {awaitingFirstResolution ? (
        <p style={styles.awaiting}>{t("adoption.awaiting")}</p>
      ) : (
        <>
          <div style={styles.summary}>
            <div style={styles.overallBlock}>
              <span style={{ ...styles.overallRate, color: rateColor(overall.rate ?? 0) }}>
                {pct(overall.rate ?? 0)}
              </span>
              <span style={styles.overallLabel}>{t("adoption.overall")}</span>
            </div>
            <div style={styles.counts}>
              <span style={styles.count}>
                <span style={{ ...styles.dot, background: ADOPTED_COLOR }} />
                {t("adoption.adopted", { count: overall.adopted })}
              </span>
              <span style={styles.count}>
                <span style={{ ...styles.dot, background: REJECTED_COLOR }} />
                {t("adoption.rejected", { count: overall.rejected })}
              </span>
            </div>
          </div>

          <p style={styles.hint}>{t("adoption.hint")}</p>

          <div style={styles.tabs}>
            {tabs.map(({ key, label, count }) => (
              <button
                key={key}
                onClick={() => setTab(key)}
                style={{ ...styles.tab, ...(tab === key ? styles.tabActive : {}) }}
              >
                {label} <span style={styles.tabCount}>{count}</span>
              </button>
            ))}
          </div>

          <div style={styles.list}>
            {tab === "lens" && (
              view.byLens.length > 0
                ? view.byLens.map((e) => <EntryRow key={e.name} entry={e} />)
                : <p style={styles.empty}>{t("adoption.noLens")}</p>
            )}
            {tab === "category" && view.byCategory.map((e) => (
              <EntryRow key={e.name} entry={e} chipColor={CATEGORY_COLOR[e.name] ?? "#6b7280"} />
            ))}
            {tab === "recent" && view.recent.map((issue) => (
              <div key={issue.url} style={styles.recentRow}>
                <span
                  style={{
                    ...styles.mark,
                    color: issue.resolution === "adopted" ? ADOPTED_COLOR : "#475569",
                  }}
                >
                  {issue.resolution === "adopted" ? "✓" : "✕"}
                </span>
                {safeExternalUrl(issue.url) ? (
                  <a href={safeExternalUrl(issue.url)!} target="_blank" rel="noreferrer noopener" style={styles.recentLink}>
                    {issue.title}
                  </a>
                ) : (
                  <span style={styles.recentLink}>{issue.title}</span>
                )}
                <span style={styles.recentState}>
                  {issue.resolution === "adopted" ? t("adoption.markAdopted") : t("adoption.markRejected")}
                </span>
              </div>
            ))}
          </div>
        </>
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
  pending: {
    fontSize: "0.7rem",
    color: "#475569",
  },
  awaiting: {
    fontSize: "0.8rem",
    color: "#64748b",
    lineHeight: 1.6,
    margin: 0,
  },
  summary: {
    display: "flex",
    alignItems: "center",
    gap: "1.5rem",
    flexWrap: "wrap" as const,
  },
  overallBlock: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.4rem",
  },
  overallRate: {
    fontSize: "2rem",
    fontWeight: 700,
    lineHeight: 1,
  },
  overallLabel: {
    fontSize: "0.75rem",
    color: "#475569",
  },
  counts: {
    display: "flex",
    gap: "1rem",
    fontSize: "0.8rem",
    color: "#64748b",
  },
  count: {
    display: "inline-flex",
    alignItems: "center",
    gap: "0.35rem",
    whiteSpace: "nowrap" as const,
  },
  dot: {
    display: "inline-block",
    width: "8px",
    height: "8px",
    borderRadius: "2px",
    marginRight: "0.35rem",
  },
  hint: {
    fontSize: "0.72rem",
    color: "#475569",
    lineHeight: 1.6,
    margin: "0.7rem 0 0.9rem",
  },
  tabs: {
    display: "flex",
    gap: "0.4rem",
    marginBottom: "0.6rem",
  },
  tab: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    borderRadius: "999px",
    padding: "0.2rem 0.7rem",
    fontSize: "0.72rem",
    color: "#64748b",
    cursor: "pointer",
  },
  tabActive: {
    background: "#f1f5f9",
    borderColor: "#cbd5e1",
    color: "#0f172a",
    fontWeight: 600,
  },
  tabCount: {
    color: "#475569",
    marginLeft: "0.2rem",
  },
  list: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.35rem",
  },
  empty: {
    fontSize: "0.75rem",
    color: "#475569",
    margin: 0,
  },
  row: {
    display: "grid",
    gridTemplateColumns: "minmax(6rem, 12rem) 1fr 2.5rem 3rem",
    alignItems: "center",
    gap: "0.6rem",
    fontSize: "0.78rem",
  },
  rowName: {
    color: "#334155",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  rowRate: {
    fontWeight: 700,
    textAlign: "right" as const,
  },
  rowCount: {
    color: "#475569",
    fontSize: "0.72rem",
    textAlign: "right" as const,
  },
  barTrack: {
    display: "flex",
    height: "6px",
    borderRadius: "3px",
    overflow: "hidden",
    background: "#f1f5f9",
  },
  barSegment: {
    height: "100%",
  },
  recentRow: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
    fontSize: "0.78rem",
  },
  mark: {
    fontWeight: 700,
  },
  recentLink: {
    color: "#334155",
    textDecoration: "none",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap" as const,
  },
  recentState: {
    color: "#475569",
    fontSize: "0.72rem",
    marginLeft: "auto",
    whiteSpace: "nowrap" as const,
  },
} as const;
