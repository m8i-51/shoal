/**
 * severity.ts — how badly a filed issue hurts.
 *
 * Category ("bug", "ux", "feature-request", "goal-gap") says what kind of
 * thing was found; it says nothing about whether to drop everything or get to
 * it next quarter. A team looking at thirty auto-filed issues has no way to
 * order them, which is the fastest way for an auto-filing tool to become noise
 * a team mutes.
 *
 * The vocabulary is deliberately four wide. Five or more and a model spreads
 * its choices thin; three collapses "this blocks the user" into "this is
 * annoying".
 */

export const SEVERITIES = ["critical", "major", "minor", "trivial"] as const;

export type Severity = (typeof SEVERITIES)[number];

/**
 * What each level means, in the words the triage prompt shows the model.
 * Anchored to user impact rather than engineering effort — the model cannot
 * see the codebase, so "hard to fix" is not something it can judge.
 */
export const SEVERITY_GUIDANCE: Record<Severity, string> = {
  critical: "blocks the core task entirely, loses data, or exposes something it should not — nobody can work around it",
  major: "the task can be completed, but only via a workaround, and a real user would likely give up first",
  minor: "noticeable friction or a wrong detail that does not stop the task",
  trivial: "cosmetic, or an improvement that nobody is currently blocked by",
};

/**
 * Synonyms accepted from a model that reached for a different vocabulary.
 * Being liberal here costs one map entry; being strict costs a dropped
 * severity on every issue a model labels "high" instead of "major".
 */
const SEVERITY_ALIASES: Record<string, Severity> = {
  blocker: "critical",
  p0: "critical",
  s0: "critical",
  sev0: "critical",
  urgent: "critical",
  high: "major",
  p1: "major",
  s1: "major",
  sev1: "major",
  medium: "minor",
  moderate: "minor",
  normal: "minor",
  p2: "minor",
  s2: "minor",
  sev2: "minor",
  low: "trivial",
  cosmetic: "trivial",
  nit: "trivial",
  p3: "trivial",
  s3: "trivial",
  sev3: "trivial",
};

/**
 * Coerce whatever the model supplied into the vocabulary, or null.
 *
 * Null rather than a default on purpose: a fabricated severity is worse than
 * an absent one, because a team sorting by it cannot tell the two apart.
 */
export function normalizeSeverity(raw: unknown): Severity | null {
  if (typeof raw !== "string") return null;
  const key = raw.trim().toLowerCase().replace(/[\s_-]+/g, "");
  if ((SEVERITIES as readonly string[]).includes(key)) return key as Severity;
  return SEVERITY_ALIASES[key] ?? null;
}

/** Tracker label for a severity, so an issue list can be filtered by it. */
export function severityLabel(severity: Severity): string {
  return `severity:${severity}`;
}

/** Ordering key — 0 is the most severe. Unknown sorts last. */
export function severityRank(severity: Severity | null): number {
  if (severity == null) return SEVERITIES.length;
  return SEVERITIES.indexOf(severity);
}

/** The `severity` block of the triage `create_issue` tool schema. */
export function severitySchemaProperty(): Record<string, unknown> {
  return {
    type: "string",
    enum: [...SEVERITIES],
    description:
      "How badly this hurts the user, judged from impact you observed — not from how hard it looks to fix. " +
      SEVERITIES.map((s) => `"${s}": ${SEVERITY_GUIDANCE[s]}`).join("; ") +
      ".",
  };
}

/** The line rendered into the issue body, or "" when the model gave none. */
export function formatSeverityLine(severity: Severity | null): string {
  if (!severity) return "";
  return `**Severity:** ${severity} — ${SEVERITY_GUIDANCE[severity]}\n`;
}
