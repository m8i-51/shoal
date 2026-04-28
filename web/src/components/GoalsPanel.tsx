import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

interface ProductSpec {
  appName: string;
  appGoals?: string[];
}

export function GoalsPanel() {
  const { t } = useTranslation();
  const [spec, setSpec] = useState<ProductSpec | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/spec")
      .then((r) => {
        if (r.status === 404) { setNotFound(true); return null; }
        return r.json();
      })
      .then((data: ProductSpec | null) => {
        if (data) setSpec(data);
      })
      .catch(() => {});
  }, []);

  const startEdit = () => {
    setDraft(spec?.appGoals?.length ? [...spec.appGoals] : [""]);
    setEditing(true);
  };

  const cancelEdit = () => setEditing(false);

  const saveEdit = async () => {
    const goals = draft.map((g) => g.trim()).filter(Boolean);
    setSaving(true);
    try {
      await fetch("/api/spec/goals", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ goals }),
      });
      setSpec((prev) => prev ? { ...prev, appGoals: goals } : prev);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const updateGoal = (i: number, val: string) => {
    setDraft((prev) => prev.map((g, idx) => idx === i ? val : g));
  };

  const removeGoal = (i: number) => {
    setDraft((prev) => prev.filter((_, idx) => idx !== i));
  };

  const addGoal = () => setDraft((prev) => [...prev, ""]);

  if (notFound) {
    return (
      <div style={styles.panel}>
        <div style={styles.header}>
          <span style={styles.title}>{t("goals.title")}</span>
        </div>
        <p style={styles.hint}>{t("goals.noSpec")}</p>
      </div>
    );
  }

  if (!spec) return null;

  const goals = spec.appGoals ?? [];

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>
          {t("goals.title")}
          {spec.appName && <span style={styles.appName}> — {spec.appName}</span>}
        </span>
        {!editing && (
          <button onClick={startEdit} style={styles.editBtn}>{t("goals.edit")}</button>
        )}
      </div>

      {!editing ? (
        <>
          {goals.length === 0 ? (
            <p style={styles.hint}>{t("goals.noGoals")}</p>
          ) : (
            <ul style={styles.list}>
              {goals.map((g, i) => (
                <li key={i} style={styles.goalItem}>{g}</li>
              ))}
            </ul>
          )}
          <p style={styles.subHint}>{t("goals.goalGapHint")}</p>
        </>
      ) : (
        <div style={styles.editArea}>
          {draft.map((g, i) => (
            <div key={i} style={styles.inputRow}>
              <input
                style={styles.input}
                value={g}
                placeholder={t("goals.placeholder")}
                onChange={(e) => updateGoal(i, e.target.value)}
                autoFocus={i === draft.length - 1 && g === ""}
              />
              <button onClick={() => removeGoal(i)} style={styles.removeBtn}>×</button>
            </div>
          ))}
          <button onClick={addGoal} style={styles.addBtn}>{t("goals.add")}</button>
          <div style={styles.editActions}>
            <button onClick={cancelEdit} style={styles.cancelBtn}>{t("goals.cancel")}</button>
            <button onClick={saveEdit} style={styles.saveBtn} disabled={saving}>
              {saving ? "…" : t("goals.save")}
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
  list: {
    margin: "0 0 0.5rem 0",
    paddingLeft: "1.25rem",
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.3rem",
  },
  goalItem: {
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
