import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

type PathStatus = "unvisited" | "reached" | "explored";
type PathSource = "sitemap" | "discovered";

interface SiteMapStats {
  known: number;
  unvisited: number;
  reached: number;
  explored: number;
  exploredRate: number;
  reachedRate: number;
}

interface SiteMapPathRow {
  path: string;
  status: PathStatus;
  visitCount: number;
  source: PathSource;
  lastVisitedAt: string | null;
  lastRunId: string | null;
}

interface SiteMapDashboardView {
  origin: string;
  updatedAt: string;
  stats: SiteMapStats;
  unvisited: string[];
  thin: Array<{ path: string; visitCount: number }>;
  entries: SiteMapPathRow[];
}

type Tab = "unvisited" | "thin" | "all";

function exploredColor(rate: number): string {
  return rate >= 0.7 ? "#22c55e" : rate >= 0.4 ? "#f59e0b" : "#ef4444";
}

function statusColor(status: PathStatus): string {
  if (status === "explored") return "#22c55e";
  if (status === "reached") return "#f59e0b";
  return "#94a3b8";
}

function CoverageBar({ stats }: { stats: SiteMapStats }) {
  if (stats.known === 0) return null;
  const exploredPct = (stats.explored / stats.known) * 100;
  const reachedPct = (stats.reached / stats.known) * 100;
  const unvisitedPct = (stats.unvisited / stats.known) * 100;

  return (
    <div style={styles.barTrack} aria-hidden="true">
      {exploredPct > 0 && (
        <div style={{ ...styles.barSegment, width: `${exploredPct}%`, background: "#22c55e" }} />
      )}
      {reachedPct > 0 && (
        <div style={{ ...styles.barSegment, width: `${reachedPct}%`, background: "#f59e0b" }} />
      )}
      {unvisitedPct > 0 && (
        <div style={{ ...styles.barSegment, width: `${unvisitedPct}%`, background: "#cbd5e1" }} />
      )}
    </div>
  );
}

export function SiteMapPanel() {
  const { t } = useTranslation();
  const [view, setView] = useState<SiteMapDashboardView | null>(null);
  const [empty, setEmpty] = useState(false);
  const [tab, setTab] = useState<Tab>("unvisited");

  const fetchSiteMap = useCallback(() => {
    fetch("/api/site-map")
      .then((r) => {
        if (r.status === 404) {
          setEmpty(true);
          setView(null);
          return null;
        }
        return r.ok ? r.json() : null;
      })
      .then((data: SiteMapDashboardView | null) => {
        if (data) {
          setEmpty(false);
          setView(data);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetchSiteMap();
    const id = setInterval(fetchSiteMap, 5000);
    return () => clearInterval(id);
  }, [fetchSiteMap]);

  const exploredPct = view ? Math.round(view.stats.exploredRate * 1000) / 10 : 0;

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>{t("siteMap.title")}</span>
        {view && (
          <span style={styles.updatedAt}>
            {t("siteMap.updatedAt")}: {new Date(view.updatedAt).toLocaleString()}
          </span>
        )}
      </div>

      {empty && !view && (
        <div style={styles.empty}>
          <p style={styles.emptyTitle}>{t("siteMap.emptyTitle")}</p>
          <p style={styles.emptyHint}>{t("siteMap.emptyHint")}</p>
        </div>
      )}

      {view && (
        <>
          <div style={styles.summaryRow}>
            <div style={styles.rateBlock}>
              <span style={{ ...styles.rate, color: exploredColor(view.stats.exploredRate) }}>
                {exploredPct}%
              </span>
              <span style={styles.rateLabel}>{t("siteMap.exploredRate")}</span>
            </div>
            <div style={styles.statsCol}>
              <CoverageBar stats={view.stats} />
              <div style={styles.counts}>
                <span style={styles.countItem}>
                  {t("siteMap.known")}: <strong>{view.stats.known}</strong>
                </span>
                <span style={styles.countItem}>
                  {t("siteMap.unvisited")}: <strong>{view.stats.unvisited}</strong>
                </span>
                <span style={styles.countItem}>
                  {t("siteMap.reached")}: <strong>{view.stats.reached}</strong>
                </span>
                <span style={styles.countItem}>
                  {t("siteMap.explored")}: <strong>{view.stats.explored}</strong>
                </span>
              </div>
            </div>
          </div>

          <div style={styles.tabs}>
            {(
              [
                { key: "unvisited" as const, label: t("siteMap.tabUnvisited") },
                { key: "thin" as const, label: t("siteMap.tabThin") },
                { key: "all" as const, label: t("siteMap.tabAll") },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                style={{ ...styles.tabBtn, ...(tab === key ? styles.tabBtnActive : {}) }}
              >
                {label}
              </button>
            ))}
          </div>

          <div style={styles.list}>
            {tab === "unvisited" &&
              (view.unvisited.length === 0 ? (
                <p style={styles.listEmpty}>{t("siteMap.noUnvisited")}</p>
              ) : (
                view.unvisited.map((p) => (
                  <div key={p} style={styles.row}>
                    <code style={styles.path}>{p}</code>
                    <StatusBadge status="unvisited" />
                  </div>
                ))
              ))}

            {tab === "thin" &&
              (view.thin.length === 0 ? (
                <p style={styles.listEmpty}>{t("siteMap.noThin")}</p>
              ) : (
                view.thin.map((item) => (
                  <div key={item.path} style={styles.row}>
                    <code style={styles.path}>{item.path}</code>
                    <span style={styles.meta}>
                      {t("siteMap.visits", { count: item.visitCount })}
                    </span>
                    <StatusBadge status="reached" />
                  </div>
                ))
              ))}

            {tab === "all" &&
              view.entries.map((entry) => (
                <div key={entry.path} style={styles.row}>
                  <code style={styles.path}>{entry.path}</code>
                  <span style={styles.meta}>
                    {entry.source === "sitemap" ? t("siteMap.sourceSitemap") : t("siteMap.sourceDiscovered")}
                    {entry.visitCount > 0 && ` · ${t("siteMap.visits", { count: entry.visitCount })}`}
                  </span>
                  <StatusBadge status={entry.status} />
                </div>
              ))}
          </div>
        </>
      )}
    </div>
  );

  function StatusBadge({ status }: { status: PathStatus }) {
    return (
      <span
        style={{
          ...styles.badge,
          background: statusColor(status),
        }}
      >
        {t(`siteMap.status.${status}`)}
      </span>
    );
  }
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
    gap: "1rem",
    flexWrap: "wrap" as const,
  },
  title: {
    fontSize: "0.7rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "#64748b",
  },
  updatedAt: {
    fontSize: "0.7rem",
    color: "#94a3b8",
  },
  empty: {
    padding: "0.5rem 0",
    color: "#64748b",
  },
  emptyTitle: {
    fontSize: "0.875rem",
    fontWeight: 600,
    marginBottom: "0.35rem",
  },
  emptyHint: {
    fontSize: "0.8rem",
    color: "#94a3b8",
    margin: 0,
  },
  summaryRow: {
    display: "flex",
    alignItems: "center",
    gap: "1.5rem",
    flexWrap: "wrap" as const,
    marginBottom: "1rem",
  },
  rateBlock: {
    display: "flex",
    flexDirection: "column" as const,
    alignItems: "flex-start",
    gap: "0.15rem",
  },
  rate: {
    fontSize: "2rem",
    fontWeight: 700,
    lineHeight: 1,
  },
  rateLabel: {
    fontSize: "0.75rem",
    color: "#64748b",
  },
  statsCol: {
    flex: 1,
    minWidth: "200px",
  },
  barTrack: {
    display: "flex",
    height: "10px",
    borderRadius: "9999px",
    overflow: "hidden",
    background: "#f1f5f9",
    marginBottom: "0.5rem",
  },
  barSegment: {
    height: "100%",
    minWidth: "2px",
  },
  counts: {
    display: "flex",
    gap: "1rem",
    flexWrap: "wrap" as const,
    fontSize: "0.8rem",
    color: "#64748b",
  },
  countItem: {
    whiteSpace: "nowrap" as const,
  },
  tabs: {
    display: "flex",
    gap: "0.35rem",
    marginBottom: "0.75rem",
  },
  tabBtn: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    padding: "4px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#64748b",
    cursor: "pointer",
  },
  tabBtnActive: {
    background: "#f1f5f9",
    color: "#1e293b",
    borderColor: "#cbd5e1",
  },
  list: {
    maxHeight: "220px",
    overflowY: "auto" as const,
    border: "1px solid #f1f5f9",
    borderRadius: "6px",
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.45rem 0.75rem",
    borderBottom: "1px solid #f1f5f9",
    fontSize: "0.8rem",
    flexWrap: "wrap" as const,
  },
  path: {
    flex: 1,
    minWidth: "120px",
    fontFamily: "ui-monospace, monospace",
    fontSize: "0.78rem",
    color: "#334155",
  },
  meta: {
    fontSize: "0.72rem",
    color: "#94a3b8",
    whiteSpace: "nowrap" as const,
  },
  badge: {
    display: "inline-block",
    padding: "0.1rem 0.45rem",
    borderRadius: "9999px",
    fontSize: "0.62rem",
    fontWeight: 700,
    color: "#fff",
    whiteSpace: "nowrap" as const,
  },
  listEmpty: {
    padding: "0.75rem",
    margin: 0,
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
} as const;
