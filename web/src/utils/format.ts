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

// Darker than the "500" shade of each hue on purpose: these are used as a
// badge background under white text, and the lighter shade fails WCAG AA
// contrast (white on #ef4444/#f97316/#3b82f6/#8b5cf6 is 2.8-4.2:1, all below
// the required 4.5:1).
export const CATEGORY_COLOR: Record<string, string> = {
  bug: "#dc2626",
  ux: "#c2410c",
  "feature-request": "#2563eb",
  "goal-gap": "#7c3aed",
};

export function formatCostUSD(usd: number | null | undefined): string {
  if (usd == null) return "—";
  if (usd < 0.0001) return "< $0.0001";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Only http(s) URLs become links. Issue URLs come from a tracker response and
 * are stored on disk, so they are not attacker-controlled today — but an
 * href is one of the few places in this UI where a string becomes executable
 * (`javascript:`), and the check costs nothing.
 */
export function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : null;
  } catch {
    return null;
  }
}
