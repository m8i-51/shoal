/**
 * Candidate data for boundary probing — not an agent lane.
 *
 * Product Discovery stores `thresholdCandidates` on the product spec.
 * This module normalizes and sorts that data. A boundary-pushing browser
 * persona may visit `area` first. `signal` and `howToProbe` stay on the
 * candidate so a cached ProductSpec still loads; they are not instructions.
 */

export type ThresholdKind = "input" | "business" | "experience";

export interface ThresholdCandidate {
  id: string;
  kind: ThresholdKind;
  area: string;
  signal: string;
  howToProbe: string;
  priority: 1 | 2 | 3;
  /** Future: expected behavior at the boundary (unused in MVP). */
  expectedBehavior?: string;
}

const KINDS: ThresholdKind[] = ["business", "input", "experience"];
const KIND_RANK: Record<ThresholdKind, number> = {
  business: 0,
  input: 1,
  experience: 2,
};

function asKind(v: unknown): ThresholdKind | null {
  if (typeof v !== "string") return null;
  const k = v.trim().toLowerCase();
  return (KINDS as string[]).includes(k) ? (k as ThresholdKind) : null;
}

function asPriority(v: unknown): 1 | 2 | 3 | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (n === 1 || n === 2 || n === 3) return n;
  return null;
}

/** Sanitize raw discovery output into valid candidates (drops invalid rows). */
export function normalizeThresholdCandidates(raw: unknown): ThresholdCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: ThresholdCandidate[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    const area = typeof o.area === "string" ? o.area.trim() : "";
    const signal = typeof o.signal === "string" ? o.signal.trim() : "";
    const howToProbe = typeof o.howToProbe === "string" ? o.howToProbe.trim() : "";
    const kind = asKind(o.kind);
    const priority = asPriority(o.priority);
    if (!id || !area || !signal || !howToProbe || !kind || priority == null) continue;
    const candidate: ThresholdCandidate = { id, kind, area, signal, howToProbe, priority };
    if (typeof o.expectedBehavior === "string" && o.expectedBehavior.trim()) {
      candidate.expectedBehavior = o.expectedBehavior.trim();
    }
    out.push(candidate);
  }
  return out;
}

/** Sort by priority asc, then business → input → experience. */
export function sortThresholdCandidates(candidates: ThresholdCandidate[]): ThresholdCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return KIND_RANK[a.kind] - KIND_RANK[b.kind];
  });
}

/**
 * Places the boundary-pushing persona should open first, in priority order.
 * Duplicate areas collapse to the highest-priority occurrence.
 * `signal` and `howToProbe` are not returned.
 */
export function boundaryVisitAreas(candidates: ThresholdCandidate[]): string[] {
  const seen = new Set<string>();
  const areas: string[] = [];
  for (const candidate of sortThresholdCandidates(candidates)) {
    if (seen.has(candidate.area)) continue;
    seen.add(candidate.area);
    areas.push(candidate.area);
  }
  return areas;
}

/**
 * Hint for one browser persona. Names places only — never probe instructions.
 */
export function formatBoundaryAreaHint(personName: string, areas: string[]): string {
  if (areas.length === 0) return "";
  const list = areas.map((area) => `- ${area}`).join("\n");
  return `
[Where ${personName} looks first]
If nobody gave you a specific task, open these places before you wander. They look like they might have a limit:
${list}
You are still ${personName}. When an input suggests a limit, try that limit once. Also send it empty, and try one huge number. Press a control that looks finished a second time.
If the app breaks, stays silent, loses what you typed, or the message does not say what went wrong, call post_feedback as what happened to you ("I …"). That is your experience. If the limit is clear, do not invent a finding.`;
}
