/**
 * adoption-view.ts — did the team act on what the swarm reported?
 *
 * `framework/adoption.ts` already matches filed issues against closed ones and
 * feeds the result back into persona hiring and scenario design: lenses whose
 * findings get fixed are leaned into, lenses whose findings are closed as
 * "not planned" are dialled back. It is the only signal shoal has that says
 * whether running it repeatedly is worth anything — and until now it existed
 * only as prompt text for the next run's designers, never on screen.
 *
 * This turns that store into a dashboard view. Nothing here recomputes
 * adoption; it reads what triage and the tracker reconciliation already wrote.
 */
import {
  loadAdoptionStats,
  loadIssueLinks,
  adoptionRate,
  type AdoptionStats,
  type IssueLink,
} from "../framework/adoption.js";

export interface AdoptionEntry {
  name: string;
  adopted: number;
  rejected: number;
  total: number;
  /** 0–1, always defined here: an entry only exists once something resolved. */
  rate: number;
}

export interface ResolvedIssue {
  title: string;
  url: string;
  category: string;
  resolution: "adopted" | "rejected";
  resolvedAt: string | null;
}

export interface AdoptionView {
  overall: { adopted: number; rejected: number; total: number; rate: number | null };
  /** A lens can contribute to several issues, so these do not sum to `overall`. */
  byLens: AdoptionEntry[];
  byCategory: AdoptionEntry[];
  /** Filed issues the tracker has not closed yet — the pipeline, not a failure. */
  pending: number;
  /** Most recently resolved issues, newest first. */
  recent: ResolvedIssue[];
}

const MAX_RECENT = 8;

function toEntries(bucket: AdoptionStats["byLens"]): AdoptionEntry[] {
  return Object.entries(bucket)
    .map(([name, count]) => ({
      name,
      adopted: count.adopted,
      rejected: count.rejected,
      total: count.adopted + count.rejected,
      rate: adoptionRate(count) ?? 0,
    }))
    .filter((e) => e.total > 0)
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

function isResolved(link: IssueLink): boolean {
  return link.resolution === "adopted" || link.resolution === "rejected";
}

/**
 * Build the dashboard view, or null when nothing has ever been filed — a fresh
 * install should not show an empty adoption panel that looks like a 0% score.
 */
export function buildAdoptionView(): AdoptionView | null {
  const stats = loadAdoptionStats();
  const links = loadIssueLinks();

  const byLens = toEntries(stats.byLens ?? {});
  const byCategory = toEntries(stats.byCategory ?? {});

  if (byLens.length === 0 && byCategory.length === 0 && links.length === 0) return null;

  // Each issue carries exactly one category, so the category buckets — unlike
  // the lens buckets — count every resolved issue exactly once.
  const adopted = byCategory.reduce((sum, e) => sum + e.adopted, 0);
  const rejected = byCategory.reduce((sum, e) => sum + e.rejected, 0);
  const total = adopted + rejected;

  const recent = links
    .filter(isResolved)
    .sort((a, b) => (b.resolvedAt ?? "").localeCompare(a.resolvedAt ?? ""))
    .slice(0, MAX_RECENT)
    .map((link): ResolvedIssue => ({
      title: link.title,
      url: link.url,
      category: link.category,
      resolution: link.resolution as "adopted" | "rejected",
      resolvedAt: link.resolvedAt ?? null,
    }));

  return {
    overall: { adopted, rejected, total, rate: total > 0 ? adopted / total : null },
    byLens,
    byCategory,
    pending: links.filter((l) => !isResolved(l)).length,
    recent,
  };
}
