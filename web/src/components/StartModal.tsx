import { useState } from "react";
import { useTranslation } from "react-i18next";

interface Props {
  onClose: () => void;
  onStarted: (runId: string) => void;
}

export function StartModal({ onClose, onStarted }: Props) {
  const { t } = useTranslation();
  const [baseUrl, setBaseUrl] = useState("http://localhost:3000");
  const [maxBrowsers, setMaxBrowsers] = useState(2);
  const [maxExplorers, setMaxExplorers] = useState(0);
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmModel, setLlmModel] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleStart = async () => {
    setLoading(true);
    const body: Record<string, unknown> = { baseUrl, maxBrowsers, maxExplorers };
    if (llmBaseUrl) body.llmBaseUrl = llmBaseUrl;
    if (llmApiKey) body.llmApiKey = llmApiKey;
    if (llmModel) body.llmModel = llmModel;

    try {
      const res = await fetch("/api/runs/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error("[start] failed to start run:", res.status);
        return;
      }
      const { sessionId } = await res.json();
      onStarted(sessionId);
    } catch (e) {
      console.error("[start] failed to start run:", e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={styles.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={styles.modal}>
        <h2 style={styles.title}>{t("startModal.title")}</h2>

        <div style={styles.form}>
          <label style={styles.label}>
            {t("startModal.baseUrl")}
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder={t("startModal.baseUrlPlaceholder")}
              style={styles.input}
            />
          </label>

          <div style={styles.row}>
            <label style={styles.label}>
              {t("startModal.maxBrowsers")}
              <input
                type="number"
                min={0}
                max={8}
                value={maxBrowsers}
                onChange={(e) => setMaxBrowsers(Number(e.target.value))}
                style={{ ...styles.input, width: "80px" }}
              />
            </label>
            <label style={styles.label}>
              {t("startModal.maxExplorers")}
              <input
                type="number"
                min={0}
                max={8}
                value={maxExplorers}
                onChange={(e) => setMaxExplorers(Number(e.target.value))}
                style={{ ...styles.input, width: "80px" }}
              />
            </label>
          </div>

          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            style={styles.advancedToggle}
          >
            {showAdvanced ? "▾" : "▸"} {t("startModal.advanced")}
          </button>

          {showAdvanced && (
            <div style={styles.advancedBox}>
              <label style={styles.label}>
                {t("startModal.llmBaseUrl")}
                <input
                  type="text"
                  value={llmBaseUrl}
                  onChange={(e) => setLlmBaseUrl(e.target.value)}
                  placeholder="http://localhost:11434/v1"
                  style={styles.input}
                />
              </label>
              <div style={styles.row}>
                <label style={styles.label}>
                  {t("startModal.llmModel")}
                  <input
                    type="text"
                    value={llmModel}
                    onChange={(e) => setLlmModel(e.target.value)}
                    placeholder="gemma4:e4b"
                    style={styles.input}
                  />
                </label>
                <label style={styles.label}>
                  {t("startModal.llmApiKey")}
                  <input
                    type="text"
                    value={llmApiKey}
                    onChange={(e) => setLlmApiKey(e.target.value)}
                    placeholder="ollama"
                    style={styles.input}
                  />
                </label>
              </div>
            </div>
          )}

          <div style={styles.buttons}>
            <button onClick={onClose} style={styles.cancelBtn} disabled={loading}>
              {t("startModal.cancel")}
            </button>
            <button onClick={handleStart} style={styles.startBtn} disabled={loading}>
              {loading ? "…" : t("startModal.start")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: "fixed" as const,
    inset: 0,
    background: "rgba(15,23,42,0.5)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1000,
  },
  modal: {
    background: "#fff",
    borderRadius: "12px",
    padding: "1.75rem",
    width: "520px",
    maxWidth: "calc(100vw - 2rem)",
    boxShadow: "0 20px 60px rgba(0,0,0,0.2)",
  },
  title: {
    fontSize: "1rem",
    fontWeight: 700,
    marginBottom: "1.25rem",
  },
  form: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "1rem",
  },
  row: {
    display: "flex",
    gap: "1rem",
  },
  label: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.375rem",
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#475569",
    flex: 1,
  },
  input: {
    border: "1px solid #e2e8f0",
    borderRadius: "6px",
    padding: "8px 10px",
    fontSize: "0.875rem",
    outline: "none",
    width: "100%",
    color: "#1e293b",
    background: "#fff",
  },
  advancedToggle: {
    background: "none",
    border: "none",
    padding: 0,
    color: "#94a3b8",
    fontSize: "0.8rem",
    fontWeight: 600,
    textAlign: "left" as const,
    cursor: "pointer",
  },
  advancedBox: {
    display: "flex",
    flexDirection: "column" as const,
    gap: "0.75rem",
    padding: "0.875rem",
    background: "#f8fafc",
    borderRadius: "6px",
    border: "1px solid #e2e8f0",
  },
  buttons: {
    display: "flex",
    gap: "0.5rem",
    justifyContent: "flex-end",
    marginTop: "0.25rem",
  },
  cancelBtn: {
    background: "transparent",
    border: "1px solid #e2e8f0",
    color: "#64748b",
    borderRadius: "6px",
    padding: "8px 16px",
    fontWeight: 600,
    cursor: "pointer",
  },
  startBtn: {
    background: "#1e293b",
    color: "#fff",
    border: "none",
    borderRadius: "6px",
    padding: "8px 20px",
    fontWeight: 600,
    cursor: "pointer",
  },
} as const;
