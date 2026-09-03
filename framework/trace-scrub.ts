/**
 * trace-scrub.ts — strips known secrets (test-account passwords, values typed
 * into password fields) out of Playwright trace zips before they land on disk.
 *
 * `tracing.start({ snapshots: true })` records every value a `fill()` call
 * writes into the page, including passwords — that ends up verbatim inside
 * `trace.trace` / `*.network` entries of the zip even though redact.ts already
 * masks the same value everywhere else (console, run JSON, HTML report). This
 * module rewrites the zip in place immediately after it is saved so the
 * plaintext never survives on disk.
 */
import * as fs from "fs";
import { zipSync, unzipSync } from "fflate";

const MIN_SECRET_LENGTH = 4;
export const REDACTED = "********";

/**
 * Run-level registry of secrets to scrub. Populated with known credentials
 * (test-accounts/accounts.json, target.credentials) at startup, and with
 * whatever value the `fill` browser tool wrote into a field it detected as a
 * password field, as it happens.
 */
const knownSecrets = new Set<string>();

/** Register one secret value (ignored if shorter than the minimum length). */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.length >= MIN_SECRET_LENGTH) {
    knownSecrets.add(value);
  }
}

/** Register several secret values at once (undefined/short entries are skipped). */
export function registerSecrets(values: Array<string | undefined | null>): void {
  for (const value of values) registerSecret(value);
}

/** Currently known secrets — what the next `scrubTraceZip` call will redact. */
export function getKnownSecrets(): string[] {
  return [...knownSecrets];
}

/** Test-only: reset the registry between runs/tests. */
export function clearKnownSecrets(): void {
  knownSecrets.clear();
}

function isBinaryEntry(entryName: string): boolean {
  return entryName.startsWith("resources/") || entryName.startsWith("resources\\");
}

function replaceAllLiteral(haystack: string, needle: string): { text: string; count: number } {
  if (!needle) return { text: haystack, count: 0 };
  const parts = haystack.split(needle);
  const count = parts.length - 1;
  if (count === 0) return { text: haystack, count: 0 };
  return { text: parts.join(REDACTED), count };
}

/**
 * Unzips `zipPath`, replaces every occurrence of each secret (>= 4 chars) in
 * every entry except those under `resources/` (screenshots/snapshots blobs),
 * and rewrites the zip in place. Entries under `resources/` are copied through
 * unchanged. Returns how many occurrences were replaced across all entries.
 */
export async function scrubTraceZip(zipPath: string, secrets: string[]): Promise<{ replaced: number }> {
  const usable = [...new Set(secrets.filter((s) => typeof s === "string" && s.length >= MIN_SECRET_LENGTH))];
  if (usable.length === 0) return { replaced: 0 };

  const input = fs.readFileSync(zipPath);
  const entries = unzipSync(new Uint8Array(input));

  let replaced = 0;
  const output: Record<string, Uint8Array> = {};
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const encoder = new TextEncoder();

  for (const [name, data] of Object.entries(entries)) {
    if (isBinaryEntry(name)) {
      output[name] = data;
      continue;
    }
    const text = decoder.decode(data);
    let next = text;
    for (const secret of usable) {
      const { text: replacedText, count } = replaceAllLiteral(next, secret);
      next = replacedText;
      replaced += count;
    }
    output[name] = next === text ? data : encoder.encode(next);
  }

  if (replaced > 0) {
    fs.writeFileSync(zipPath, zipSync(output, { level: 6 }));
  }
  return { replaced };
}

/**
 * Scrubs a trace zip using the run's known-secrets registry, never throwing —
 * a scrub failure is logged and otherwise ignored so it can never fail a run.
 */
export async function scrubTraceZipSafely(zipPath: string, label: string): Promise<void> {
  try {
    const secrets = getKnownSecrets();
    if (secrets.length === 0) return;
    const { replaced } = await scrubTraceZip(zipPath, secrets);
    if (replaced > 0) {
      console.log(`  [trace-scrub] redacted ${replaced} occurrence(s) in ${label}`);
    }
  } catch (e) {
    console.warn(`  [trace-scrub] failed to scrub ${label}:`, e);
  }
}
