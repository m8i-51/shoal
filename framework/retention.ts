/**
 * retention.ts — deletes old per-run artifact directories so `logs/screenshots/`
 * and `logs/traces/` don't grow unbounded run after run. Findings JSON,
 * report HTML, and run logs are left untouched — this only prunes the two
 * directory trees that accumulate one subdirectory per run.
 */
import * as fs from "fs";
import * as path from "path";

export const DEFAULT_RETENTION_DAYS = 30;

const RUN_DIR_RE = /^run_(\d+)$/;

export function getRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.SHOAL_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_RETENTION_DAYS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_RETENTION_DAYS;
  return parsed;
}

function pruneDir(dir: string, cutoffMs: number): number {
  if (!fs.existsSync(dir)) return 0;
  let removed = 0;
  for (const entry of fs.readdirSync(dir)) {
    const match = RUN_DIR_RE.exec(entry);
    if (!match) continue;
    const runEpochMs = Number(match[1]);
    if (!Number.isFinite(runEpochMs) || runEpochMs >= cutoffMs) continue;
    const full = path.join(dir, entry);
    try {
      const stat = fs.statSync(full);
      if (!stat.isDirectory()) continue;
      fs.rmSync(full, { recursive: true, force: true });
      removed++;
    } catch {
      // best-effort — a file locked/removed concurrently is not fatal
    }
  }
  return removed;
}

/**
 * Deletes `logs/screenshots/run_*` and `logs/traces/run_*` directories whose
 * run id timestamp is older than `retentionDays`. `retentionDays <= 0`
 * disables pruning entirely. Returns how many directories were removed.
 */
export function pruneRunArtifacts(cwd: string, retentionDays: number, now: number = Date.now()): number {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
  const cutoffMs = now - retentionDays * 24 * 60 * 60 * 1000;
  const screenshotsRemoved = pruneDir(path.join(cwd, "logs", "screenshots"), cutoffMs);
  const tracesRemoved = pruneDir(path.join(cwd, "logs", "traces"), cutoffMs);
  return screenshotsRemoved + tracesRemoved;
}
