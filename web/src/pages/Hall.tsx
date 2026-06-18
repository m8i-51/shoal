import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

interface HallFinding {
  id: string;
  runId: string;
  title: string;
  body: string;
  category: string;
  agentName: string;
  role: string;
  timestamp: string;
}

interface ExportBundle {
  version: string;
  exportedAt: string;
  source: string;
  findings: HallFinding[];
}

type CategoryFilter = "all" | "bug" | "ux" | "feature-request" | "goal-gap";

const CAT_COLOR: Record<string, string> = {
  bug: "#ef4444",
  ux: "#f97316",
  "feature-request": "#3b82f6",
  "goal-gap": "#8b5cf6",
};

export function Hall() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const [findings, setFindings] = useState<HallFinding[]>([]);
  const [imported, setImported] = useState<HallFinding[]>([]);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<CategoryFilter>("all");
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState(false);

  useEffect(() => {
    fetch("/api/findings")
      .then((r) => (r.ok ? r.json() : []))
      .then(setFindings)
      .catch(() => {});
  }, []);

  const allFindings = [...findings, ...imported];

  const filtered = allFindings.filter((f) => {
    if (category !== "all" && f.category !== category) return false;
    if (query) {
      const q = query.toLowerCase();
      return f.title.toLowerCase().includes(q) || f.body.toLowerCase().includes(q);
    }
    return true;
  });

  const categories = Array.from(new Set(allFindings.map((f) => f.category)));

  const handleExport = async () => {
    const res = await fetch("/api/findings/export");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `shoal-findings-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImport = async () => {
    if (!importUrl.trim()) return;
    setImporting(true);
    setImportError(false);
    try {
      const res = await fetch("/api/findings/proxy-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: importUrl.trim() }),
      });
      if (!res.ok) { setImportError(true); return; }
      const data: ExportBundle = await res.json();
      if (Array.isArray(data.findings)) {
        setImported(data.findings.map((f) => ({ ...f, runId: f.runId ?? "imported" })));
      } else {
        setImportError(true);
      }
    } catch {
      setImportError(true);
    } finally {
      setImporting(false);
    }
  };

  const cats: CategoryFilter[] = ["all", ...Array.from(new Set(["bug", "ux", "feature-request", "goal-gap", ...categories])) as CategoryFilter[]];

  return (
    <div style={styles.page}>
      {/* ページヘッダー */}
      <div style={styles.pageHeader}>
        <button onClick={() => navigate("/")} style={styles.backBtn}>
          {t("detail.back")}
        </button>
        <div style={styles.headerMain}>
          <h1 style={styles.title}>{t("hall.title")}</h1>
          <span style={styles.subtitle}>{t("hall.subtitle")}</span>
        </div>
        <div style={styles.headerActions}>
          <span style={styles.totalCount}>{allFindings.length} findings</span>
          <button
            onClick={handleExport}
            style={styles.exportBtn}
            disabled={findings.length === 0}
          >
            {t("hall.export")}
          </button>
        </div>
      </div>

      {/* 検索 + カテゴリフィルタ */}
      <div style={styles.toolbar}>
        <input
          style={styles.search}
          placeholder={t("hall.searchPlaceholder")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div style={styles.filters}>
          {cats.map((cat) => (
            <button
              key={cat}
              style={{
                ...styles.filterBtn,
                ...(category === cat ? styles.filterBtnActive : {}),
                ...(cat !== "all" && CAT_COLOR[cat]
                  ? { borderColor: category === cat ? CAT_COLOR[cat] : "transparent", color: category === cat ? CAT_COLOR[cat] : "#64748b" }
                  : {}),
              }}
              onClick={() => setCategory(cat)}
            >
              {cat === "all" ? t("hall.filterAll") : cat}
            </button>
          ))}
        </div>
      </div>

      {/* URL インポート */}
      <div style={styles.importBar}>
        <input
          style={styles.importInput}
          placeholder={t("hall.importPlaceholder")}
          value={importUrl}
          onChange={(e) => setImportUrl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleImport()}
        />
        <button
          onClick={handleImport}
          style={styles.importBtn}
          disabled={importing || !importUrl.trim()}
        >
          {importing ? t("hall.importing") : t("hall.import")}
        </button>
        {importError && <span style={styles.importError}>{t("hall.importError")}</span>}
        {imported.length > 0 && (
          <span style={styles.importedBadge}>
            +{imported.length} imported
          </span>
        )}
      </div>

      {/* Findings リスト */}
      <div style={styles.list}>
        {filtered.length === 0 ? (
          <p style={styles.empty}>
            {allFindings.length === 0 ? t("hall.noFindings") : t("hall.noResults")}
          </p>
        ) : (
          filtered.map((f) => (
            <FindingCard
              key={`${f.runId}:${f.id}`}
              finding={f}
              onRunClick={f.runId !== "imported" ? () => navigate(`/runs/${f.runId}`) : undefined}
            />
          ))
        )}
      </div>
    </div>
  );
}

function FindingCard({
  finding,
  onRunClick,
}: {
  finding: HallFinding;
  onRunClick?: () => void;
}) {
  const color = CAT_COLOR[finding.category] ?? "#6b7280";
  const date = new Date(finding.timestamp).toLocaleDateString("ja-JP");
  const [expanded, setExpanded] = useState(false);
  const bodyPreview = finding.body.length > 160 ? finding.body.slice(0, 160) + "…" : finding.body;

  return (
    <div style={styles.card} onClick={() => setExpanded((e) => !e)}>
      <div style={styles.cardHeader}>
        <span style={{ ...styles.catBadge, background: color }}>{finding.category}</span>
        <div style={styles.cardMeta}>
          {onRunClick ? (
            <button
              onClick={(e) => { e.stopPropagation(); onRunClick(); }}
              style={styles.runLink}
            >
              {finding.runId}
            </button>
          ) : (
            <span style={styles.importedTag}>imported</span>
          )}
          <span style={styles.metaSep}>·</span>
          <span style={styles.metaDate}>{date}</span>
        </div>
      </div>
      <h3 style={styles.cardTitle}>{finding.title}</h3>
      <p style={styles.cardBody}>{expanded ? finding.body : bodyPreview}</p>
      {finding.body.length > 160 && (
        <span style={styles.expandHint}>{expanded ? "▲" : "▼"}</span>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: "calc(100vh - 52px)",
    background: "#f8fafc",
  },
  pageHeader: {
    display: "flex",
    alignItems: "center",
    gap: "1rem",
    padding: "1rem 2rem",
    background: "#fff",
    borderBottom: "1px solid #e2e8f0",
  },
  backBtn: {
    background: "transparent",
    border: "none",
    color: "#475569",
    fontSize: "0.875rem",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
    flexShrink: 0,
  },
  headerMain: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "2px",
    flex: 1,
  },
  title: {
    fontSize: "1.1rem",
    fontWeight: 700,
    color: "#1e293b",
    margin: 0,
  },
  subtitle: {
    fontSize: "0.75rem",
    color: "#94a3b8",
  },
  headerActions: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
  },
  totalCount: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    fontFamily: "monospace",
  },
  exportBtn: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    color: "#475569",
    borderRadius: "6px",
    padding: "5px 12px",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  toolbar: {
    display: "flex",
    alignItems: "center",
    gap: "0.75rem",
    padding: "0.75rem 2rem",
    background: "#fff",
    borderBottom: "1px solid #e2e8f0",
    flexWrap: "wrap" as const,
  },
  search: {
    flex: "1 1 200px",
    border: "1px solid #e2e8f0",
    borderRadius: "8px",
    padding: "6px 12px",
    fontSize: "0.875rem",
    outline: "none",
    color: "#1e293b",
    background: "#f8fafc",
  },
  filters: {
    display: "flex",
    gap: "0.25rem",
    flexWrap: "wrap" as const,
  },
  filterBtn: {
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: "6px",
    padding: "4px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#64748b",
    cursor: "pointer",
  },
  filterBtnActive: {
    background: "#f1f5f9",
    borderColor: "#cbd5e1",
    color: "#1e293b",
  },
  importBar: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    padding: "0.6rem 2rem",
    background: "#f8fafc",
    borderBottom: "1px solid #e2e8f0",
    flexWrap: "wrap" as const,
  },
  importInput: {
    flex: "1 1 300px",
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    padding: "5px 10px",
    fontSize: "0.8rem",
    outline: "none",
    color: "#475569",
    background: "#fff",
    fontFamily: "monospace",
  },
  importBtn: {
    background: "#1e293b",
    color: "#f8fafc",
    border: "none",
    borderRadius: "6px",
    padding: "5px 14px",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  importError: {
    fontSize: "0.75rem",
    color: "#ef4444",
  },
  importedBadge: {
    fontSize: "0.7rem",
    fontWeight: 700,
    color: "#8b5cf6",
    background: "#ede9fe",
    borderRadius: "10px",
    padding: "2px 8px",
  },
  list: {
    maxWidth: "800px",
    margin: "0 auto",
    padding: "1.5rem 2rem",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.75rem",
  },
  empty: {
    textAlign: "center" as const,
    color: "#94a3b8",
    fontSize: "0.875rem",
    padding: "3rem 0",
  },
  card: {
    background: "#fff",
    border: "1px solid #e2e8f0",
    borderRadius: "10px",
    padding: "1rem 1.25rem",
    cursor: "pointer",
    transition: "box-shadow 0.15s ease",
  },
  cardHeader: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    marginBottom: "0.5rem",
  },
  catBadge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "9999px",
    fontSize: "0.65rem",
    fontWeight: 700,
    color: "#fff",
    flexShrink: 0,
  },
  cardMeta: {
    display: "flex",
    alignItems: "center",
    gap: "0.35rem",
    marginLeft: "auto",
  },
  runLink: {
    background: "transparent",
    border: "none",
    color: "#3b82f6",
    fontSize: "0.7rem",
    fontFamily: "monospace",
    cursor: "pointer",
    padding: 0,
    textDecoration: "underline",
  },
  importedTag: {
    fontSize: "0.65rem",
    color: "#8b5cf6",
    fontFamily: "monospace",
  },
  metaSep: {
    color: "#cbd5e1",
    fontSize: "0.75rem",
  },
  metaDate: {
    fontSize: "0.7rem",
    color: "#94a3b8",
  },
  cardTitle: {
    fontSize: "0.9rem",
    fontWeight: 600,
    color: "#1e293b",
    margin: "0 0 0.3rem",
    lineHeight: 1.4,
  },
  cardBody: {
    fontSize: "0.8rem",
    color: "#475569",
    lineHeight: 1.6,
    margin: 0,
  },
  expandHint: {
    fontSize: "0.6rem",
    color: "#cbd5e1",
    display: "block",
    textAlign: "right" as const,
    marginTop: "0.25rem",
  },
} as const;
