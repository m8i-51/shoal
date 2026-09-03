/**
 * triage-view.ts — what triage did with a run's findings, shaped for the dashboard.
 *
 * The dashboard used to show raw findings only: every reader of `findings/` in
 * this server skips `triage_result.json` by name, so the step that actually
 * decides what the team receives — several reports merged into one ticket, a
 * finding skipped as a duplicate, an issue flagged as blunting a declared
 * product edge — left no trace in the UI. Declaring a product edge and never
 * seeing which tickets it marked is a loop that does not close.
 *
 * This joins `triage_result.json` back to the findings it refers to, so the UI
 * can render titles instead of opaque IDs without a second round trip.
 *
 * Results written before per-issue records existed carry only ID lists. Those
 * still load; `legacy` says the per-issue detail is absent rather than empty,
 * so the UI can explain the difference instead of showing a blank panel.
 */
import * as fs from "fs";
import * as path from "path";
import { isFinding, type Finding } from "../framework/types.js";

export interface TriageFindingRef {
  id: string;
  /** null when the finding file is gone but the ID is still referenced. */
  title: string | null;
  agentName: string | null;
  category: string | null;
}

export interface TriageIssueView {
  title: string;
  category: string;
  url: string | null;
  edgeRisk: { edge: string; why: string } | null;
  createdAt: string | null;
  mergedFindings: TriageFindingRef[];
}

export interface TriageSkipView extends TriageFindingRef {
  reason: string | null;
}

export interface TriageView {
  runId: string;
  completedAt: string | null;
  issues: TriageIssueView[];
  skips: TriageSkipView[];
  unprocessed: TriageFindingRef[];
  stats: {
    issuesCreated: number;
    findingsIssued: number;
    findingsSkipped: number;
    findingsUnprocessed: number;
    edgeRisks: number;
  };
  /** True when the stored result predates per-issue records (ID lists only). */
  legacy: boolean;
}

const RUN_ID_RE = /^run_\d+$/;

/**
 * Resolve `name` under `root`, or return null if it can escape the directory.
 * Dot-dot and separator checks must sit next to the path sink; CodeQL does not
 * treat a `/^run_\d+$/` helper as a TaintedPath sanitizer.
 */
function containedPath(root: string, name: string): string | null {
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, name);
  if (!resolved.startsWith(resolvedRoot + path.sep)) return null;
  return resolved;
}

function runDir(runId: string): string | null {
  if (runId.includes("..") || runId.includes("/") || runId.includes("\\")) return null;
  if (!RUN_ID_RE.test(runId)) return null;
  return containedPath(path.join(process.cwd(), "findings"), runId);
}

/** Findings for one run, keyed by ID, so the view can name what triage acted on. */
function loadFindingsById(dir: string): Map<string, Finding> {
  const byId = new Map<string, Finding>();
  let files: string[];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return byId;
  }
  for (const file of files) {
    if (file.includes("..") || file.includes("/") || file.includes("\\")) continue;
    if (path.basename(file) !== file) continue;
    if (!file.endsWith(".json") || file === "triage_result.json") continue;
    const fullPath = containedPath(dir, file);
    if (!fullPath) continue;
    try {
      const f: unknown = JSON.parse(fs.readFileSync(fullPath, "utf-8"));
      if (!isFinding(f)) continue;
      byId.set(f.id, f);
    } catch { /* skip malformed */ }
  }
  return byId;
}

/** Everything the reader is allowed to assume about a stored triage result. */
interface StoredTriageResult {
  completedAt?: unknown;
  issued?: unknown;
  skipped?: unknown;
  unprocessed?: unknown;
  edgeRisks?: unknown;
  issues?: unknown;
  skips?: unknown;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function edgeRiskOf(value: unknown): { edge: string; why: string } | null {
  if (!value || typeof value !== "object") return null;
  const { edge, why } = value as { edge?: unknown; why?: unknown };
  if (typeof edge !== "string" || typeof why !== "string") return null;
  if (!edge.trim() || !why.trim()) return null;
  return { edge, why };
}

function readTriageResult(dir: string): StoredTriageResult | null {
  const filePath = containedPath(dir, "triage_result.json");
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as StoredTriageResult;
  } catch {
    return null;
  }
}

function refFor(id: string, findings: Map<string, Finding>): TriageFindingRef {
  const f = findings.get(id);
  return {
    id,
    title: f?.title ?? null,
    agentName: f?.agentName ?? null,
    category: f?.category ?? null,
  };
}

/**
 * Build the dashboard view for one run, or null when the run has no triage
 * result — a run that never reached triage, or one whose findings were all
 * handled as re-report comments.
 */
export function buildTriageView(runId: string): TriageView | null {
  const dir = runDir(runId);
  if (!dir || !fs.existsSync(dir)) return null;

  const stored = readTriageResult(dir);
  if (!stored) return null;

  const findings = loadFindingsById(dir);
  const issued = stringArray(stored.issued);
  const skipped = stringArray(stored.skipped);
  const unprocessed = stringArray(stored.unprocessed);
  const edgeRisks = stringArray(stored.edgeRisks);

  const rawIssues = Array.isArray(stored.issues) ? stored.issues : [];
  const issues: TriageIssueView[] = rawIssues.flatMap((raw): TriageIssueView[] => {
    if (!raw || typeof raw !== "object") return [];
    const { title, category, url, mergedFindingIds, edgeRisk, createdAt } = raw as Record<string, unknown>;
    if (typeof title !== "string" || typeof category !== "string") return [];
    return [{
      title,
      category,
      url: typeof url === "string" && url ? url : null,
      edgeRisk: edgeRiskOf(edgeRisk),
      createdAt: typeof createdAt === "string" ? createdAt : null,
      mergedFindings: stringArray(mergedFindingIds).map((id) => refFor(id, findings)),
    }];
  });

  const rawSkips = Array.isArray(stored.skips) ? stored.skips : [];
  const reasonById = new Map<string, string>();
  for (const raw of rawSkips) {
    if (!raw || typeof raw !== "object") continue;
    const { findingId, reason } = raw as Record<string, unknown>;
    if (typeof findingId !== "string") continue;
    reasonById.set(findingId, typeof reason === "string" ? reason : "");
  }

  const skips: TriageSkipView[] = skipped.map((id) => ({
    ...refFor(id, findings),
    reason: reasonById.get(id) || null,
  }));

  return {
    runId,
    completedAt: typeof stored.completedAt === "string" ? stored.completedAt : null,
    issues,
    skips,
    unprocessed: unprocessed.map((id) => refFor(id, findings)),
    stats: {
      // A pre-`issues` result can still say how many findings were filed, but
      // not how many tickets they became — report what is actually known.
      issuesCreated: issues.length,
      findingsIssued: issued.length,
      findingsSkipped: skipped.length,
      findingsUnprocessed: unprocessed.length,
      edgeRisks: edgeRisks.length,
    },
    legacy: issued.length > 0 && rawIssues.length === 0,
  };
}
