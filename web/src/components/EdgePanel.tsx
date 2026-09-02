import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { apiFetch } from "../api";

interface ProductEdge {
  sharpEdges: string[];
  tradeoffs: string[];
  source: "discovered" | "human";
  updatedAt?: string;
}

interface ProductSpec {
  appName: string;
  productEdge?: ProductEdge;
}

type ListKey = "sharpEdges" | "tradeoffs";

export function EdgePanel() {
  const { t } = useTranslation();
  const [spec, setSpec] = useState<ProductSpec | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<ListKey, string[]>>({ sharpEdges: [], tradeoffs: [] });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch("/api/spec")
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data: ProductSpec | null) => {
        if (data) setSpec(data);
      })
      .catch(() => {});
  }, []);

  const edge = spec?.productEdge;

  const startEdit = () => {
    setDraft({
      sharpEdges: edge?.sharpEdges.length ? [...edge.sharpEdges] : [""],
      tradeoffs: edge?.tradeoffs.length ? [...edge.tradeoffs] : [""],
    });
    setEditing(true);
  };

  const saveEdit = async () => {
    const clean = (list: string[]) => list.map((v) => v.trim()).filter(Boolean);
    const payload = { sharpEdges: clean(draft.sharpEdges), tradeoffs: clean(draft.tradeoffs) };
    setSaving(true);
    try {
      const res = await apiFetch("/api/spec/edge", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        console.error("[edge] failed to save:", res.status);
        return;
      }
      const data = await res.json() as { productEdge: ProductEdge | null };
      setSpec((prev) => prev ? { ...prev, productEdge: data.productEdge ?? undefined } : prev);
      setEditing(false);
    } catch (e) {
      console.error("[edge] failed to save:", e);
    } finally {
      setSaving(false);
    }
  };

  const updateItem = (key: ListKey, i: number, val: string) => {
    setDraft((prev) => ({ ...prev, [key]: prev[key].map((v, idx) => idx === i ? val : v) }));
  };
  const removeItem = (key: ListKey, i: number) => {
    setDraft((prev) => ({ ...prev, [key]: prev[key].filter((_, idx) => idx !== i) }));
  };
  const addItem = (key: ListKey) => {
    setDraft((prev) => ({ ...prev, [key]: [...prev[key], ""] }));
  };

  if (notFound) {
    return (
      <div style={styles.panel}>
        <div style={styles.header}>
          <span style={styles.title}>{t("edge.title")}</span>
        </div>
        <p style={styles.hint}>{t("edge.noSpec")}</p>
      </div>
    );
  }

  if (!spec) return null;

  const renderList = (key: ListKey, items: string[]) => (
    <div style={styles.group}>
      <div style={styles.groupLabel}>{t(`edge.${key}`)}</div>
      {items.length === 0 ? (
        <p style={styles.hint}>{t("edge.empty")}</p>
      ) : (
        <ul style={styles.list}>
          {items.map((item, i) => <li key={i} style={styles.item}>{item}</li>)}
        </ul>
      )}
    </div>
  );

  const renderEditor = (key: ListKey) => (
    <div style={styles.group}>
      <div style={styles.groupLabel}>{t(`edge.${key}`)}</div>
      {draft[key].map((v, i) => (
        <div key={i} style={styles.inputRow}>
          <input
            style={styles.input}
            value={v}
            placeholder={t(`edge.${key}Placeholder`)}
            onChange={(e) => updateItem(key, i, e.target.value)}
          />
          <button onClick={() => removeItem(key, i)} style={styles.removeBtn}>×</button>
        </div>
      ))}
      <button onClick={() => addItem(key)} style={styles.addBtn}>{t("edge.add")}</button>
    </div>
  );

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>
          {t("edge.title")}
          {spec.appName && <span style={styles.appName}> — {spec.appName}</span>}
        </span>
        {!editing && (
          <button onClick={startEdit} style={styles.editBtn}>{t("edge.edit")}</button>
        )}
      </div>

      {!editing ? (
        <>
          {edge?.source === "discovered" && <p style={styles.draftBadge}>{t("edge.draft")}</p>}
          {!edge ? (
            <p style={styles.hint}>{t("edge.none")}</p>
          ) : (
            <>
              {renderList("sharpEdges", edge.sharpEdges)}
              {renderList("tradeoffs", edge.tradeoffs)}
            </>
          )}
          <p style={styles.subHint}>{t("edge.hint")}</p>
          <p style={styles.subHint}>{t("edge.triageHint")}</p>
        </>
      ) : (
        <div style={styles.editArea}>
          <p style={styles.subHint}>{t("edge.hint")}</p>
          {renderEditor("sharpEdges")}
          {renderEditor("tradeoffs")}
          <div style={styles.editActions}>
            <button onClick={() => setEditing(false)} style={styles.cancelBtn}>{t("edge.cancel")}</button>
            <button onClick={saveEdit} style={styles.saveBtn} disabled={saving}>
              {saving ? "…" : t("edge.save")}
            </button>
          </div>
        </div>
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
  appName: {
    fontWeight: 400,
    textTransform: "none" as const,
    letterSpacing: 0,
  },
  editBtn: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    color: "#475569",
    borderRadius: "5px",
    padding: "3px 10px",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
  },
  draftBadge: {
    display: "inline-block",
    background: "#fef3c7",
    color: "#92400e",
    borderRadius: "4px",
    padding: "2px 8px",
    fontSize: "0.72rem",
    margin: "0 0 0.6rem",
  },
  group: {
    marginBottom: "0.75rem",
  },
  groupLabel: {
    fontSize: "0.72rem",
    fontWeight: 700,
    color: "#475569",
    marginBottom: "0.3rem",
  },
  list: {
    margin: 0,
    paddingLeft: "1.25rem",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.3rem",
  },
  item: {
    fontSize: "0.875rem",
    color: "#1e293b",
    lineHeight: 1.5,
  },
  hint: {
    fontSize: "0.8rem",
    color: "#94a3b8",
    margin: "0 0 0.4rem",
  },
  subHint: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    margin: "0.5rem 0 0",
  },
  editArea: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.4rem",
  },
  inputRow: {
    display: "flex",
    gap: "0.4rem",
    alignItems: "center",
    marginBottom: "0.3rem",
  },
  input: {
    flex: 1,
    padding: "6px 10px",
    fontSize: "0.875rem",
    border: "1px solid #cbd5e1",
    borderRadius: "5px",
    color: "#1e293b",
    outline: "none",
  },
  removeBtn: {
    background: "transparent",
    border: "none",
    color: "#94a3b8",
    fontSize: "1rem",
    cursor: "pointer",
    padding: "0 4px",
    lineHeight: 1,
  },
  addBtn: {
    alignSelf: "flex-start",
    background: "transparent",
    border: "none",
    color: "#3b82f6",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
    padding: "2px 0",
  },
  editActions: {
    display: "flex",
    gap: "0.5rem",
    justifyContent: "flex-end",
    marginTop: "0.25rem",
  },
  cancelBtn: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    color: "#64748b",
    borderRadius: "5px",
    padding: "5px 12px",
    fontSize: "0.8rem",
    cursor: "pointer",
  },
  saveBtn: {
    background: "#1e293b",
    border: "none",
    color: "#f8fafc",
    borderRadius: "5px",
    padding: "5px 14px",
    fontSize: "0.8rem",
    fontWeight: 600,
    cursor: "pointer",
  },
} as const;
