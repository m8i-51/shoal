import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useImeEnterHandler } from "../utils/ime-enter";
import { apiFetch } from "../api";

interface Persona {
  id: string;
  name: string;
  role: string;
  persona: string;
  seed?: string;
  lenses?: string[];
  status?: "active" | "archived";
  origin?: string;
  accountRole?: string;
}

async function fetchPersonas(): Promise<Persona[] | null> {
  try {
    const res = await apiFetch("/api/personas?archived=1");
    if (!res.ok) return null;
    return (await res.json()) as Persona[];
  } catch {
    return null;
  }
}

export function PersonasPanel() {
  const { t } = useTranslation();
  const [active, setActive] = useState<Persona[]>([]);
  const [archived, setArchived] = useState<Persona[]>([]);
  const [showArchived, setShowArchived] = useState(false);
  const [seed, setSeed] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ name: string; role: string; persona: string; lenses: string; accountRole: string }>({
    name: "",
    role: "",
    persona: "",
    lenses: "",
    accountRole: "",
  });
  const [saving, setSaving] = useState(false);

  const applyPersonas = useCallback((all: Persona[]) => {
    setActive(all.filter((p) => (p.status ?? "active") !== "archived"));
    setArchived(all.filter((p) => p.status === "archived"));
  }, []);

  const load = useCallback(async () => {
    const all = await fetchPersonas();
    if (all) applyPersonas(all);
  }, [applyPersonas]);

  useEffect(() => {
    // The mount fetch runs inside the effect and is guarded by `ignore`, so a
    // response landing after unmount is dropped instead of setting state.
    let ignore = false;
    async function loadOnMount() {
      const all = await fetchPersonas();
      if (!ignore && all) applyPersonas(all);
    }
    void loadOnMount();
    return () => {
      ignore = true;
    };
  }, [applyPersonas]);

  const createFromSeed = useCallback(async () => {
    const trimmed = seed.trim();
    if (!trimmed) return;
    setCreating(true);
    setError(null);
    try {
      const res = await apiFetch("/api/personas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ seed: trimmed }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(typeof body.error === "string" ? body.error : t("personas.createFailed"));
        return;
      }
      setSeed("");
      await load();
    } catch {
      setError(t("personas.createFailed"));
    } finally {
      setCreating(false);
    }
  }, [seed, t, load]);

  const seedEnterHandlers = useImeEnterHandler(() => {
    void createFromSeed();
  });

  const startEdit = (p: Persona) => {
    setEditingId(p.id);
    setDraft({
      name: p.name,
      role: p.role,
      persona: p.persona,
      lenses: (p.lenses ?? []).join(", "),
      accountRole: p.accountRole ?? "",
    });
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setSaving(true);
    setError(null);
    try {
      const lenses = draft.lenses
        .split(",")
        .map((l) => l.trim())
        .filter(Boolean);
      const res = await apiFetch(`/api/personas/${editingId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          role: draft.role,
          persona: draft.persona,
          lenses,
          accountRole: draft.accountRole.trim() === "" ? null : draft.accountRole.trim(),
        }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(typeof body.error === "string" ? body.error : t("personas.saveFailed"));
        return;
      }
      setEditingId(null);
      await load();
    } catch {
      setError(t("personas.saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const archive = async (id: string) => {
    await apiFetch(`/api/personas/${id}/archive`, { method: "POST" });
    if (editingId === id) setEditingId(null);
    await load();
  };

  const restore = async (id: string) => {
    await apiFetch(`/api/personas/${id}/restore`, { method: "POST" });
    await load();
  };

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>{t("personas.title")}</span>
      </div>
      <p style={styles.subHint}>{t("personas.hint")}</p>

      <div style={styles.createRow}>
        <input
          style={styles.input}
          value={seed}
          placeholder={t("personas.seedPlaceholder")}
          onChange={(e) => setSeed(e.target.value)}
          onCompositionStart={seedEnterHandlers.onCompositionStart}
          onCompositionEnd={seedEnterHandlers.onCompositionEnd}
          onKeyDown={seedEnterHandlers.onKeyDown}
        />
        <button
          type="button"
          onClick={() => void createFromSeed()}
          style={styles.saveBtn}
          disabled={creating || !seed.trim()}
        >
          {creating ? "…" : t("personas.create")}
        </button>
      </div>
      {error && <p style={styles.error}>{error}</p>}

      {active.length === 0 ? (
        <p style={styles.hint}>{t("personas.empty")}</p>
      ) : (
        <ul style={styles.list}>
          {active.map((p) => (
            <li key={p.id} style={styles.item}>
              {editingId === p.id ? (
                <div style={styles.editArea}>
                  <input
                    style={styles.input}
                    value={draft.name}
                    onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                    placeholder={t("personas.name")}
                  />
                  <input
                    style={styles.input}
                    value={draft.role}
                    onChange={(e) => setDraft((d) => ({ ...d, role: e.target.value }))}
                    placeholder={t("personas.role")}
                  />
                  <input
                    style={styles.input}
                    value={draft.accountRole}
                    onChange={(e) => setDraft((d) => ({ ...d, accountRole: e.target.value }))}
                    placeholder={t("personas.accountRolePlaceholder")}
                    aria-label={t("personas.accountRole")}
                  />
                  <textarea
                    style={styles.textarea}
                    value={draft.persona}
                    onChange={(e) => setDraft((d) => ({ ...d, persona: e.target.value }))}
                    rows={3}
                  />
                  <input
                    style={styles.input}
                    value={draft.lenses}
                    onChange={(e) => setDraft((d) => ({ ...d, lenses: e.target.value }))}
                    placeholder={t("personas.lensesPlaceholder")}
                  />
                  <div style={styles.editActions}>
                    <button onClick={() => setEditingId(null)} style={styles.cancelBtn}>
                      {t("personas.cancel")}
                    </button>
                    <button onClick={() => void saveEdit()} style={styles.saveBtn} disabled={saving}>
                      {saving ? "…" : t("personas.save")}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={styles.itemHeader}>
                    <strong style={styles.name}>{p.name}</strong>
                    <span style={styles.role}>{p.role}</span>
                    {p.accountRole && (
                      <span style={styles.role}>{t("personas.accountRole")}: {p.accountRole}</span>
                    )}
                  </div>
                  {p.seed && <p style={styles.seed}>{t("personas.seedLabel")}: {p.seed}</p>}
                  <p style={styles.persona}>{p.persona}</p>
                  {(p.lenses?.length ?? 0) > 0 && (
                    <p style={styles.lenses}>{(p.lenses ?? []).join(" · ")}</p>
                  )}
                  <div style={styles.itemActions}>
                    <button onClick={() => startEdit(p)} style={styles.editBtn}>
                      {t("personas.edit")}
                    </button>
                    <button onClick={() => void archive(p.id)} style={styles.archiveBtn}>
                      {t("personas.archive")}
                    </button>
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <div style={styles.archivedBlock}>
          <button
            type="button"
            onClick={() => setShowArchived((v) => !v)}
            style={styles.archivedToggle}
          >
            {showArchived ? t("personas.hideArchived") : t("personas.showArchived")} ({archived.length})
          </button>
          {showArchived && (
            <ul style={styles.list}>
              {archived.map((p) => (
                <li key={p.id} style={{ ...styles.item, opacity: 0.75 }}>
                  <div style={styles.itemHeader}>
                    <strong style={styles.name}>{p.name}</strong>
                    <span style={styles.role}>{p.role}</span>
                  </div>
                  <div style={styles.itemActions}>
                    <button onClick={() => void restore(p.id)} style={styles.editBtn}>
                      {t("personas.restore")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
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
    marginBottom: "0.4rem",
  },
  title: {
    fontSize: "0.7rem",
    fontWeight: 700,
    textTransform: "uppercase" as const,
    letterSpacing: "0.08em",
    color: "#64748b",
  },
  subHint: {
    fontSize: "0.75rem",
    color: "#94a3b8",
    margin: "0 0 0.75rem",
  },
  hint: {
    fontSize: "0.8rem",
    color: "#94a3b8",
    margin: "0.5rem 0 0",
  },
  createRow: {
    display: "flex",
    gap: "0.5rem",
    marginBottom: "0.75rem",
  },
  input: {
    flex: 1,
    padding: "6px 10px",
    fontSize: "0.875rem",
    border: "1px solid #cbd5e1",
    borderRadius: "5px",
    color: "#1e293b",
    outline: "none",
    width: "100%",
    boxSizing: "border-box" as const,
  },
  textarea: {
    width: "100%",
    padding: "6px 10px",
    fontSize: "0.875rem",
    border: "1px solid #cbd5e1",
    borderRadius: "5px",
    color: "#1e293b",
    outline: "none",
    resize: "vertical" as const,
    boxSizing: "border-box" as const,
    fontFamily: "inherit",
  },
  list: {
    listStyle: "none",
    margin: 0,
    padding: 0,
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.75rem",
  },
  item: {
    borderTop: "1px solid #f1f5f9",
    paddingTop: "0.75rem",
  },
  itemHeader: {
    display: "flex",
    gap: "0.5rem",
    alignItems: "baseline",
    flexWrap: "wrap" as const,
  },
  name: {
    fontSize: "0.9rem",
    color: "#1e293b",
  },
  role: {
    fontSize: "0.75rem",
    color: "#64748b",
  },
  seed: {
    fontSize: "0.7rem",
    color: "#94a3b8",
    margin: "0.25rem 0 0",
  },
  persona: {
    fontSize: "0.8rem",
    color: "#334155",
    margin: "0.35rem 0 0",
    lineHeight: 1.45,
  },
  lenses: {
    fontSize: "0.7rem",
    color: "#64748b",
    margin: "0.35rem 0 0",
  },
  itemActions: {
    display: "flex",
    gap: "0.4rem",
    marginTop: "0.5rem",
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
  archiveBtn: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    color: "#94a3b8",
    borderRadius: "5px",
    padding: "3px 10px",
    fontSize: "0.75rem",
    cursor: "pointer",
  },
  editArea: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.4rem",
  },
  editActions: {
    display: "flex",
    gap: "0.5rem",
    justifyContent: "flex-end",
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
    whiteSpace: "nowrap" as const,
  },
  error: {
    fontSize: "0.8rem",
    color: "#dc2626",
    margin: "0 0 0.5rem",
  },
  archivedBlock: {
    marginTop: "1rem",
  },
  archivedToggle: {
    background: "transparent",
    border: "none",
    color: "#64748b",
    fontSize: "0.75rem",
    fontWeight: 600,
    cursor: "pointer",
    padding: 0,
  },
} as const;
