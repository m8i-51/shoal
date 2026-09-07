/**
 * log.ts — leveled logging.
 *
 * shoal printed everything through `console.log` at one volume: a CI job that
 * only wanted the summary got several hundred progress lines, and an operator
 * debugging a stuck agent had no way to ask for more. `SHOAL_LOG_LEVEL` makes
 * that a setting, defaulting to exactly what previous releases printed.
 *
 * The distinction that matters here is *diagnostics vs. output*. The run
 * summary, the report path and the findings count are not progress chatter —
 * they are the reason the command was run. Those go through `print`, which
 * only `silent` suppresses, so `SHOAL_LOG_LEVEL=error` gives a quiet run that
 * still tells you what happened rather than a blank terminal.
 */

export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

export const DEFAULT_LOG_LEVEL: LogLevel = "info";

const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Resolve `SHOAL_LOG_LEVEL`. An unrecognised value warns and falls back to the
 * default rather than silencing the run — a typo must not cost an operator
 * the output they were relying on.
 */
export function resolveLogLevel(env: NodeJS.ProcessEnv = process.env): LogLevel {
  const raw = (env.SHOAL_LOG_LEVEL ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_LOG_LEVEL;
  if ((LOG_LEVELS as readonly string[]).includes(raw)) return raw as LogLevel;
  console.warn(
    `[log] ignoring invalid SHOAL_LOG_LEVEL "${raw}" — expected one of ${LOG_LEVELS.join(", ")}`,
  );
  return DEFAULT_LOG_LEVEL;
}

/**
 * Read on each call rather than cached at import.
 *
 * The dashboard spawns runs as children whose env is built per request, and
 * tests set the variable after this module is already loaded; a level captured
 * at import time would be wrong in both.
 */
function currentRank(): number {
  return RANK[resolveLogLevel()];
}

/** Errors. Suppressed only by `silent`. */
export function error(...args: unknown[]): void {
  if (currentRank() >= RANK.error) console.error(...args);
}

/** Warnings — something is off but the run continues. */
export function warn(...args: unknown[]): void {
  if (currentRank() >= RANK.warn) console.warn(...args);
}

/** Progress. This is where the bulk of shoal's output lives. */
export function info(...args: unknown[]): void {
  if (currentRank() >= RANK.info) console.log(...args);
}

/** Detail worth having only when something is being diagnosed. */
export function debug(...args: unknown[]): void {
  if (currentRank() >= RANK.debug) console.log(...args);
}

/**
 * Program output rather than diagnostics: the run summary, the report path,
 * the findings count. Shown at every level except `silent`, so a quiet run
 * still says what it did.
 */
export function print(...args: unknown[]): void {
  if (currentRank() >= RANK.error) console.log(...args);
}

/** True when `debug` output would be printed — for skipping expensive formatting. */
export function isDebug(): boolean {
  return currentRank() >= RANK.debug;
}
