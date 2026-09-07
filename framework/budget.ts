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
import { estimateCostSync, warmPricingCache } from "./cost";
import * as log from "./log";

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
  /**
   * False when a cap is configured but the run's model has no price we can
   * resolve — the cap cannot fire, and the operator has to be told rather than
   * left believing they are covered.
   */
  enforceable: boolean;
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
    log.warn(`[budget] ignoring invalid SHOAL_MAX_USD "${raw}" — expected a positive number`);
    return null;
  }
  return parsed;
}

/**
 * One run's spend accounting.
 *
 * This was module-level `let state`, which made every test that touched the
 * cap order-dependent — a test that pushed spend past the limit left the
 * module "exceeded" for whatever ran next — and made two runs in one process
 * share one budget. The state now belongs to an instance; the module-level
 * functions below delegate to the process-wide one the CLI uses, so no caller
 * had to change, and a test constructs its own tracker instead of relying on
 * an `initBudget()` call for isolation.
 */
export class BudgetTracker {
  readonly state: BudgetState;

  constructor(limitUSD: number | null = null) {
    this.state = {
      limitUSD,
      spentUSD: 0,
      sawUnpricedCall: false,
      exceeded: false,
      enforceable: true,
    };
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): BudgetTracker {
    return new BudgetTracker(resolveBudgetLimit(env));
  }

  /**
   * Load the pricing the cap needs, and check the run's own model can be
   * priced. Returns a line to log when the cap cannot be enforced, or null.
   */
  async prepare(model: string, provider: string): Promise<string | null> {
    if (this.state.limitUSD == null) return null;

    let warmed: boolean;
    try {
      warmed = await warmPricingCache(provider);
    } catch {
      warmed = false;
    }

    const priced = estimateCostSync(model, provider, 1, 1) != null;
    if (warmed && priced) return null;

    this.state.enforceable = false;
    return (
      `[budget] WARNING: SHOAL_MAX_USD is set to $${this.state.limitUSD.toFixed(2)}, but no price is ` +
      `available for model "${model}" on provider "${provider}"${warmed ? "" : " (pricing lookup failed)"} — ` +
      "the cap cannot be enforced and this run is effectively uncapped."
    );
  }

  /**
   * Add one call's usage to the running estimate. Returns the new total.
   * Unpriced models add nothing but are remembered for the status line.
   */
  recordSpend(model: string, provider: string, inputTokens: number, outputTokens: number): number {
    const cost = estimateCostSync(model, provider, inputTokens, outputTokens);
    if (cost == null) {
      this.state.sawUnpricedCall = true;
      return this.state.spentUSD;
    }
    this.state.spentUSD += cost;
    if (this.state.limitUSD != null && this.state.spentUSD >= this.state.limitUSD) {
      this.state.exceeded = true;
    }
    return this.state.spentUSD;
  }

  /** True when the cap is configured and already reached. */
  get exceeded(): boolean {
    return this.state.exceeded;
  }

  /**
   * Throw when the cap has been reached. Call this *before* starting an LLM
   * request so the run stops instead of spending past the limit.
   */
  assertWithinBudget(): void {
    if (this.state.limitUSD != null && this.state.exceeded) {
      throw new BudgetExceededError(this.state.spentUSD, this.state.limitUSD);
    }
  }

  /** True when a cap is configured and can actually fire. */
  get enforceable(): boolean {
    return this.state.limitUSD != null && this.state.enforceable;
  }

  /** Startup line describing the configured cap, or null when there is none. */
  statusLine(): string | null {
    if (this.state.limitUSD == null) return null;
    return `[budget] cap: $${this.state.limitUSD.toFixed(2)} (estimated; models with no published price are not counted)`;
  }

  /** Line printed when the cap stops a run. */
  stopLine(): string {
    const limit = this.state.limitUSD != null ? `$${this.state.limitUSD.toFixed(2)}` : "—";
    const unpriced = this.state.sawUnpricedCall
      ? " (some calls used a model with no known price and were not counted)"
      : "";
    return `[budget] spend cap reached: ~$${this.state.spentUSD.toFixed(4)} of ${limit}${unpriced} — remaining work skipped`;
  }
}

/**
 * The tracker the CLI's single run uses. A test that needs isolation should
 * construct its own `BudgetTracker` rather than reaching for this.
 */
let current = new BudgetTracker();

export function initBudget(env: NodeJS.ProcessEnv = process.env): BudgetState {
  current = BudgetTracker.fromEnv(env);
  return current.state;
}

/** The process-wide tracker. */
export function getBudget(): BudgetTracker {
  return current;
}

export function prepareBudget(model: string, provider: string): Promise<string | null> {
  return current.prepare(model, provider);
}

export function getBudgetState(): BudgetState {
  return current.state;
}

export function isBudgetExceeded(): boolean {
  return current.exceeded;
}

export function recordSpend(
  model: string,
  provider: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return current.recordSpend(model, provider, inputTokens, outputTokens);
}

export function assertWithinBudget(): void {
  current.assertWithinBudget();
}

export function isBudgetEnforceable(): boolean {
  return current.enforceable;
}

export function budgetStatusLine(): string | null {
  return current.statusLine();
}

/** Line printed when the cap stops a run. */
export function budgetStopLine(): string {
  return current.stopLine();
}
