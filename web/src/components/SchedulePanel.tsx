import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";

interface ScheduleConfig {
  enabled: boolean;
  dayOfWeek: number;
  hour: number;
  minute: number;
  lastRunDate: string | null;
}

export function SchedulePanel() {
  const { t } = useTranslation();
  const [config, setConfig] = useState<ScheduleConfig | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((data: ScheduleConfig) => setConfig(data))
      .catch(() => {});
  }, []);

  const patch = async (partial: Partial<ScheduleConfig>) => {
    if (!config) return;
    const updated = { ...config, ...partial };
    setConfig(updated);
    try {
      const res = await fetch("/api/schedule", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(partial),
      });
      if (res.ok) {
        const data: ScheduleConfig = await res.json();
        setConfig(data);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } catch {}
  };

  if (!config) return null;

  const days = t("schedule.days", { returnObjects: true }) as string[];

  const nextRunLabel = (() => {
    if (!config.enabled) return null;
    const now = new Date();
    const target = new Date();
    target.setHours(config.hour, config.minute, 0, 0);
    const daysUntil = (config.dayOfWeek - now.getDay() + 7) % 7 || (
      now.getHours() * 60 + now.getMinutes() >= config.hour * 60 + config.minute ? 7 : 0
    );
    target.setDate(target.getDate() + daysUntil);
    return target.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  })();

  return (
    <div style={styles.panel}>
      <div style={styles.header}>
        <span style={styles.title}>{t("schedule.title")}</span>
        <button
          onClick={() => patch({ enabled: !config.enabled })}
          style={{ ...styles.toggle, background: config.enabled ? "#22c55e" : "#374151" }}
        >
          {config.enabled ? t("schedule.enabled") : t("schedule.disabled")}
        </button>
      </div>

      <div style={{ ...styles.fields, opacity: config.enabled ? 1 : 0.4, pointerEvents: config.enabled ? "auto" : "none" }}>
        <div style={styles.field}>
          <label style={styles.label}>{t("schedule.dayLabel")}</label>
          <div style={styles.dayRow}>
            {days.map((d, i) => (
              <button
                key={i}
                onClick={() => patch({ dayOfWeek: i })}
                style={{ ...styles.dayBtn, background: config.dayOfWeek === i ? "#6366f1" : "#1f2937" }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>

        <div style={styles.field}>
          <label style={styles.label}>{t("schedule.timeLabel")}</label>
          <div style={styles.timeRow}>
            <input
              type="number"
              min={0}
              max={23}
              value={config.hour}
              onChange={(e) => patch({ hour: parseInt(e.target.value) || 0 })}
              style={styles.timeInput}
            />
            <span style={styles.colon}>:</span>
            <input
              type="number"
              min={0}
              max={59}
              value={String(config.minute).padStart(2, "0")}
              onChange={(e) => patch({ minute: parseInt(e.target.value) || 0 })}
              style={styles.timeInput}
            />
          </div>
        </div>
      </div>

      <div style={styles.footer}>
        {saved && <span style={styles.savedLabel}>{t("schedule.saved")}</span>}
        {nextRunLabel && <span style={styles.nextRun}>{t("schedule.nextRun")}: {nextRunLabel}</span>}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  panel: {
    background: "#111827",
    border: "1px solid #1f2937",
    borderRadius: "8px",
    padding: "1rem 1.25rem",
    marginBottom: "1.5rem",
  },
  header: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: "0.875rem",
  },
  title: {
    color: "#e2e8f0",
    fontWeight: 600,
    fontSize: "0.9rem",
  },
  toggle: {
    border: "none",
    borderRadius: "6px",
    padding: "0.3rem 0.75rem",
    fontSize: "0.75rem",
    fontWeight: 600,
    color: "#fff",
    cursor: "pointer",
  },
  fields: {
    display: "flex",
    gap: "1.5rem",
    flexWrap: "wrap",
  },
  field: {
    display: "flex",
    flexDirection: "column",
    gap: "0.4rem",
  },
  label: {
    fontSize: "0.75rem",
    color: "#94a3b8",
  },
  dayRow: {
    display: "flex",
    gap: "0.25rem",
  },
  dayBtn: {
    border: "none",
    borderRadius: "4px",
    padding: "0.3rem 0.5rem",
    fontSize: "0.75rem",
    color: "#e2e8f0",
    cursor: "pointer",
  },
  timeRow: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
  },
  timeInput: {
    background: "#1f2937",
    border: "1px solid #374151",
    borderRadius: "4px",
    color: "#e2e8f0",
    padding: "0.3rem 0.5rem",
    width: "3.5rem",
    textAlign: "center",
    fontSize: "0.875rem",
  },
  colon: {
    color: "#94a3b8",
    fontWeight: 700,
  },
  footer: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: "0.75rem",
    minHeight: "1.2rem",
  },
  savedLabel: {
    fontSize: "0.75rem",
    color: "#22c55e",
  },
  nextRun: {
    fontSize: "0.75rem",
    color: "#64748b",
  },
};
