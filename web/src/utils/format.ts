import type { TFunction } from "i18next";

export function formatDuration(startedAt: string, completedAt: string | null, t: TFunction): string {
  if (!completedAt) return t("duration.inProgress");
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const s = Math.round(ms / 1000);
  if (s < 60) return t("duration.seconds", { count: s });
  return t("duration.minutes", { m: Math.floor(s / 60), s: s % 60 });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const CATEGORY_COLOR: Record<string, string> = {
  bug: "#ef4444",
  ux: "#f97316",
  "feature-request": "#3b82f6",
  "goal-gap": "#8b5cf6",
};

export function formatCostUSD(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd < 0.0001) return "< $0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
