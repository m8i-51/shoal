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
 * Distribute sorted candidates across agents (round-robin),
 * preferring not to give the same area to the same agent.
 */
export function assignThresholdCandidates(
  candidates: ThresholdCandidate[],
  agentCount: number,
): ThresholdCandidate[][] {
  if (agentCount <= 0) return [];
  const buckets: ThresholdCandidate[][] = Array.from({ length: agentCount }, () => []);
  const areas: Set<string>[] = Array.from({ length: agentCount }, () => new Set());
  let rr = 0;

  for (const c of candidates) {
    let placed = false;
    for (let i = 0; i < agentCount; i++) {
      const idx = (rr + i) % agentCount;
      if (!areas[idx].has(c.area)) {
        buckets[idx].push(c);
        areas[idx].add(c.area);
        rr = (idx + 1) % agentCount;
        placed = true;
        break;
      }
    }
    if (!placed) {
      buckets[rr].push(c);
      areas[rr].add(c.area);
      rr = (rr + 1) % agentCount;
    }
  }
  return buckets;
}
