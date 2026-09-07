import * as fs from "fs";
import * as path from "path";
import * as log from "./log";

/**
 * atomic-write.ts — durable writes (and loud, non-fatal recovery from bad reads)
 * for shoal's on-disk state files.
 *
 * shoal keeps its important state — the agent roster, coverage history, the
 * site map, adoption stats, the schedule — as plain JSON files written with
 * `fs.writeFileSync`. That call is NOT atomic: it opens the file, streams
 * the bytes, and returns. If the process dies partway through (a `SIGKILL`
 * from `shoal serve`'s shutdown timeout, an OOM kill, `kill -9`, a crashed
 * host), the file on disk is whatever prefix of the new content had been
 * flushed — often just `{` or a truncated line. The next read then hits a
 * `JSON.parse` failure. Every reader used to treat that failure exactly like
 * "file does not exist yet" and silently fall back to an empty value — for
 * `agents.json` that means the entire persona roster (built from LLM calls,
 * carrying per-agent memory) quietly resets to nothing, with no warning, and
 * the next run re-spends the LLM budget rebuilding it from scratch.
 *
 * This module fixes both halves of that:
 *
 *   - `writeFileAtomic` makes the write itself atomic, so a kill mid-write
 *     can no longer produce a truncated file in the first place.
 *   - `quarantineCorruptFile` makes it impossible for a corrupt file to be
 *     silently forgotten: it logs a clear warning naming the file and what
 *     was lost, and moves the bad file aside (rather than leaving it where
 *     the next successful save would overwrite it) so an operator can
 *     inspect or recover it. Callers still return their normal empty value
 *     afterward — a corrupt file must never crash a run.
 */

/**
 * Write `data` to `filePath` durably: after this call returns (or throws),
 * `filePath` holds either its previous complete contents or the new
 * complete contents — never a partial write, no matter when the process is
 * killed.
 *
 * How: write the new content to a temporary file, fsync it so the bytes are
 * actually on disk rather than sitting in a buffer, then `rename()` the
 * temp file over `filePath`. POSIX (and Windows, via `MoveFileEx` with
 * replace-existing) guarantee that a rename onto an existing path is
 * atomic: any reader that opens `filePath` sees either the old inode's full
 * bytes or the new inode's full bytes, never a mix. `fs.writeFileSync`
 * alone gives none of that — it can be interrupted after any number of
 * bytes.
 *
 * The temp file MUST be a sibling of `filePath` (same directory), not e.g.
 * something under `os.tmpdir()`: the atomicity of `rename()` only holds
 * *within a single filesystem*. Renaming across filesystems (a different
 * mount, a different device) has no atomic primitive on POSIX — Node falls
 * back to a non-atomic copy-then-unlink, which reopens exactly the
 * truncation window this helper exists to close. Writing the temp file next
 * to the target is the simplest way to guarantee "same filesystem" without
 * the caller having to know anything about the mount layout.
 *
 * We do not fsync the parent directory (which some durability guides also
 * recommend, to ensure the rename's directory-entry update survives a hard
 * power loss). That guards against a failure mode this fix doesn't target
 * — shoal's threat here is a killed process, not a power outage — it has no
 * equivalent on Windows, and every write site in this codebase writes to
 * ordinary local disk, not a network filesystem. Fsyncing the file's own
 * contents before the rename is the part that matters for "a killed process
 * never sees a truncated file", so that's the part we pay for.
 *
 * On any failure the temp file is removed on a best-effort basis and the
 * original error is re-thrown; `filePath` itself is left untouched.
 */
export function writeFileAtomic(
  filePath: string,
  data: string,
  encoding: BufferEncoding = "utf-8",
): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(
    dir,
    `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );

  try {
    fs.writeFileSync(tmpPath, data, encoding);

    // Force the bytes to disk before the rename that makes them visible.
    // Without this, on some filesystems the rename can be durable before
    // the data it points to is, which reopens a (smaller, rarer) version of
    // the same truncation risk this helper exists to close.
    let fd: number | undefined;
    try {
      fd = fs.openSync(tmpPath, "r");
      fs.fsyncSync(fd);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      /* best-effort cleanup — the write already failed, don't mask that error with a cleanup one */
    }
    throw err;
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Called from a `load*()` function's catch block when a stored JSON file
 * exists but failed to parse. Two things happen, both intentionally loud:
 *
 *   1. A warning naming the file and what was lost, via the shared logger
 *      (so it shows up like any other shoal diagnostic, and is suppressed
 *      only by `SHOAL_LOG_LEVEL=silent` — never silently by default).
 *   2. The corrupt file is renamed aside to a `<name>.corrupt-<timestamp>`
 *      sibling instead of being left in place. Left alone, the very next
 *      successful save would overwrite it and destroy the only evidence
 *      (and the only chance at manual recovery) that this happened.
 *
 * This never throws: quarantining is a best-effort courtesy on top of an
 * already-bad situation, and a failure to move the file aside must not
 * become a new reason for the run to crash. Callers keep returning their
 * normal empty/default value regardless of what this function does.
 */
export function quarantineCorruptFile(filePath: string, whatWasLost: string, err: unknown): void {
  const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
  log.warn(
    `[atomic-write] ${filePath} is corrupt and could not be read (${errorMessage(err)}). ` +
      `Treating ${whatWasLost} as empty for this run so it can continue, rather than losing it — ` +
      `moving the corrupt file to ${quarantinePath} for inspection/recovery instead of leaving it to be overwritten.`,
  );
  try {
    fs.renameSync(filePath, quarantinePath);
  } catch (renameErr) {
    log.warn(
      `[atomic-write] could not move corrupt file ${filePath} aside (${errorMessage(renameErr)}); ` +
        `it may be silently overwritten by the next save.`,
    );
  }
}
