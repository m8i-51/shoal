/**
 * budget.ts — hard spend cap for a run.
 *
 * `estimateCost` in cost.ts reports what a run *did* cost, after the fact. That
 * is no help when a swarm is already running: the only brakes are the per-agent
 * iteration caps, and those are set in turns, not dollars.
 *
 * This module keeps a running estimate as responses come back and refuses to
 * start another LLM call once `SHOAL_MAX_USD` is reached. Every Messages-API
 * call in shoal goes through `createMessageWithRetry`, so guarding there covers
 * every lane (discovery, HR, explorers, browsers, thresholds, triage).
 *
 * Models with no known price contribute 0 to the estimate. That is deliberate —
 * the cap must never fire on a guess — but it means an unpriced model is
 * effectively uncapped, so `budgetStatusLine()` says so out loud.
 */
import { estimateCostSync } from "./cost";

export class BudgetExceededError extends Error {
  readonly spentUSD: number;
  readonly limitUSD: number;

  constructor(spentUSD: number, limitUSD: number) {
    super(
      `[budget] stopping: estimated spend $${spentUSD.toFixed(4)} reached the ` +
        `SHOAL_MAX_USD limit of $${limitUSD.toFixed(2)}`,
    );
    this.name = "BudgetExceededError";
    this.spentUSD = spentUSD;
    this.limitUSD = limitUSD;
  }
}

export interface BudgetState {
  /** Cap in USD, or null when no cap is configured. */
  limitUSD: number | null;
  /** Running estimate of what the run has spent so far. */
  spentUSD: number;
  /** True once a call was priced with a model we have no price for. */
  sawUnpricedCall: boolean;
  /** Set when the cap has been hit, so lanes can stop dispatching. */
  exceeded: boolean;
}

/**
 * Parse `SHOAL_MAX_USD`. Anything that is not a finite positive number means
 * "no cap" — a malformed value must not silently become a tiny budget that
 * kills the run on the first call.
 */
export function resolveBudgetLimit(env: NodeJS.ProcessEnv = process.env): number | null {
  const raw = (env.SHOAL_MAX_USD ?? "").trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(`[budget] ignoring invalid SHOAL_MAX_USD "${raw}" — expected a positive number`);
    return null;
  }
  return parsed;
}

let state: BudgetState = {
  limitUSD: null,
  spentUSD: 0,
  sawUnpricedCall: false,
  exceeded: false,
};

export function initBudget(env: NodeJS.ProcessEnv = process.env): BudgetState {
  state = {
    limitUSD: resolveBudgetLimit(env),
    spentUSD: 0,
    sawUnpricedCall: false,
    exceeded: false,
  };
  return state;
}

export function getBudgetState(): BudgetState {
  return state;
}

/** True when the cap is configured and already reached. */
export function isBudgetExceeded(): boolean {
  return state.exceeded;
}

/**
 * Add one call's usage to the running estimate. Returns the new total.
 * Unpriced models add nothing but are remembered for the status line.
 */
export function recordSpend(
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const cost = estimateCostSync(model, provider, inputTokens, outputTokens);
  if (cost == null) {
    state.sawUnpricedCall = true;
    return state.spentUSD;
  }
  state.spentUSD += cost;
  if (state.limitUSD != null && state.spentUSD >= state.limitUSD) {
    state.exceeded = true;
  }
  return state.spentUSD;
}

/**
 * Throw when the cap has been reached. Call this *before* starting an LLM
 * request so the run stops instead of spending past the limit.
 */
export function assertWithinBudget(): void {
  if (state.limitUSD != null && state.exceeded) {
    throw new BudgetExceededError(state.spentUSD, state.limitUSD);
  }
}

/** Startup line describing the configured cap, or null when there is none. */
export function budgetStatusLine(): string | null {
  if (state.limitUSD == null) return null;
  return `[budget] cap: $${state.limitUSD.toFixed(2)} (estimated; models with no published price are not counted)`;
}

/** Line printed when the cap stops a run. */
export function budgetStopLine(): string {
  const limit = state.limitUSD != null ? `$${state.limitUSD.toFixed(2)}` : "—";
  const unpriced = state.sawUnpricedCall
    ? " (some calls used a model with no known price and were not counted)"
    : "";
  return `[budget] spend cap reached: ~$${state.spentUSD.toFixed(4)} of ${limit}${unpriced} — remaining work skipped`;
}
