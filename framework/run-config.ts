/**
 * run-config.ts — timings, limits, and viewport used by the run pipeline.
 *
 * These values were literals scattered through run.ts. Collecting them here
 * gives them names, one place to change them, and an env override for the ones
 * operators actually need to tune (agent turn budget, explorer concurrency,
 * viewport) without editing source.
 */

/** Default browser viewport for every non-persona context (discovery, accounts, agents). */
export const DEFAULT_VIEWPORT = { width: 1024, height: 640 } as const;

export interface RunTimings {
  /** Settle time after `navigate` before reading the page. */
  afterNavigateMs: number;
  /** Settle time after a click. */
  afterClickMs: number;
  /** Settle time after filling or selecting a form control. */
  afterInputMs: number;
  /** Initial load wait when an agent's browser session starts. */
  agentStartupMs: number;
  /** Pause between explorer batches, to spread API load. */
  betweenExplorerBatchesMs: number;
  /** Pause before the regression lane starts. */
  beforeRegressionMs: number;
  /** Pause before launching the browser/threshold lanes. */
  beforeBrowserLaneMs: number;
  /** Pause before triage. */
  beforeTriageMs: number;
}

export const RUN_TIMINGS: RunTimings = {
  afterNavigateMs: 3000,
  afterClickMs: 500,
  afterInputMs: 300,
  agentStartupMs: 5000,
  betweenExplorerBatchesMs: 5000,
  beforeRegressionMs: 3000,
  beforeBrowserLaneMs: 2000,
  beforeTriageMs: 2000,
};

/** Turn budget per agent lane. */
export const DEFAULT_BROWSER_ITERATIONS = 12;
export const DEFAULT_THRESHOLD_ITERATIONS = 12;
export const DEFAULT_PERSONA_DESIGNER_ITERATIONS = 8;

/** How many explorer agents run at once. */
export const DEFAULT_EXPLORER_CONCURRENCY = 2;

/**
 * Read a positive integer from the environment, falling back to `fallback`
 * when unset, unparseable, or out of range. Out-of-range values warn rather
 * than failing the run — a typo in .env should not cost an operator a swarm.
 */
export function positiveIntFromEnv(
  name: string,
  fallback: number,
  opts: { min?: number; max?: number; env?: NodeJS.ProcessEnv } = {},
): number {
  const env = opts.env ?? process.env;
  const raw = (env[name] ?? "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  const min = opts.min ?? 1;
  const max = opts.max ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    console.warn(
      `[config] ignoring invalid ${name}="${raw}" — expected an integer between ${min} and ${max}; using ${fallback}`,
    );
    return fallback;
  }
  return parsed;
}

/** Turns a browser agent may take (`SHOAL_BROWSER_ITERATIONS`). */
export function browserIterations(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv("SHOAL_BROWSER_ITERATIONS", DEFAULT_BROWSER_ITERATIONS, { max: 100, env });
}

/** Turns a threshold agent may take (`SHOAL_THRESHOLD_ITERATIONS`). */
export function thresholdIterations(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv("SHOAL_THRESHOLD_ITERATIONS", DEFAULT_THRESHOLD_ITERATIONS, { max: 100, env });
}

/** Explorer agents run in parallel batches of this size (`SHOAL_EXPLORER_CONCURRENCY`). */
export function explorerConcurrency(env: NodeJS.ProcessEnv = process.env): number {
  return positiveIntFromEnv("SHOAL_EXPLORER_CONCURRENCY", DEFAULT_EXPLORER_CONCURRENCY, { max: 16, env });
}

/** Viewport for agent contexts (`SHOAL_VIEWPORT=1280x800`). */
export function resolveViewport(
  env: NodeJS.ProcessEnv = process.env,
): { width: number; height: number } {
  const raw = (env.SHOAL_VIEWPORT ?? "").trim();
  if (!raw) return { ...DEFAULT_VIEWPORT };
  const m = raw.match(/^(\d{2,5})\s*[x×]\s*(\d{2,5})$/i);
  if (!m) {
    console.warn(`[config] ignoring invalid SHOAL_VIEWPORT "${raw}" — expected WIDTHxHEIGHT (e.g. 1280x800)`);
    return { ...DEFAULT_VIEWPORT };
  }
  return { width: Number(m[1]), height: Number(m[2]) };
}
