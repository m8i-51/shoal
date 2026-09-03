/**
 * cost-stats.ts — cross-run LLM spend, derived from what /api/runs already returns.
 *
 * Spend is shown per run everywhere else in the dashboard, but the question
 * people ask about a tool they run weekly is what it costs to keep running.
 * Deriving that here rather than adding an endpoint keeps the figure and the
 * run table below it from ever disagreeing.
 */
import type { RunSummary } from "../types";

/** How many recent runs the per-run bars show. */
const TREND_RUNS = 20;

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

export interface CostStats {
  total: number;
  average: number;
  last30d: number;
  runsWithCost: number;
  /** Runs whose cost could not be estimated — they are not in `total`. */
  runsWithoutCost: number;
  inputTokens: number;
  outputTokens: number;
  /** Oldest to newest, so the bars read left-to-right in time. */
  trend: { runId: string; cost: number }[];
}

export function computeCostStats(runs: RunSummary[]): CostStats | null {
  const withCost = runs.filter((r) => r.estimatedCostUSD != null);
  if (withCost.length === 0) return null;

  const total = withCost.reduce((sum, r) => sum + (r.estimatedCostUSD ?? 0), 0);
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const last30d = withCost
    .filter((r) => new Date(r.startedAt).getTime() >= cutoff)
    .reduce((sum, r) => sum + (r.estimatedCostUSD ?? 0), 0);

  return {
    total,
    average: total / withCost.length,
    last30d,
    runsWithCost: withCost.length,
    // A run with no estimate is excluded from the total, so say how many —
    // otherwise the figure quietly understates what was actually spent.
    runsWithoutCost: runs.filter((r) => r.estimatedCostUSD == null && !r.isLive).length,
    inputTokens: runs.reduce((sum, r) => sum + r.inputTokens, 0),
    outputTokens: runs.reduce((sum, r) => sum + r.outputTokens, 0),
    trend: withCost
      .slice(0, TREND_RUNS)
      .map((r) => ({ runId: r.runId, cost: r.estimatedCostUSD ?? 0 }))
      .reverse(),
  };
}
