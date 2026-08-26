/**
 * Parse `npm pack --dry-run --json` and fail if CLI entrypoints are missing
 * from the published tarball.
 *
 * npm 10 emits an array of pack objects; npm 12 emits `{ [packageName]: pack }`.
 */

import { readFileSync } from "node:fs";

export const REQUIRED_PACK_ENTRYPOINTS = [
  "run.ts",
  "diff.ts",
  "triage-only.ts",
  "server/index.ts",
  "server/mcp.ts",
] as const;

export type PackFile = { path: string };
export type PackInfo = { files: PackFile[] };

function isPackInfo(value: unknown): value is PackInfo {
  if (!value || typeof value !== "object") return false;
  const files = (value as { files?: unknown }).files;
  return Array.isArray(files) && files.every(
    (f) => !!f && typeof f === "object" && typeof (f as PackFile).path === "string",
  );
}

export function packInfoFromNpmPackJson(data: unknown): PackInfo {
  if (Array.isArray(data)) {
    const first = data[0];
    if (isPackInfo(first)) return first;
  } else if (isPackInfo(data)) {
    return data;
  } else if (data && typeof data === "object") {
    for (const value of Object.values(data as Record<string, unknown>)) {
      if (isPackInfo(value)) return value;
    }
  }

  const keys = data && typeof data === "object" ? Object.keys(data as object) : typeof data;
  throw new Error(`unexpected npm pack --json shape: ${JSON.stringify(keys)}`);
}

export function missingEntrypoints(pack: PackInfo): string[] {
  const files = new Set(pack.files.map((f) => f.path));
  return REQUIRED_PACK_ENTRYPOINTS.filter((f) => !files.has(f));
}

export function verifyPackJson(raw: string): { ok: true } | { ok: false; error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `npm pack --json was not valid JSON: ${(err as Error).message}` };
  }

  let pack: PackInfo;
  try {
    pack = packInfoFromNpmPackJson(data);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }

  const missing = missingEntrypoints(pack);
  if (missing.length > 0) {
    return {
      ok: false,
      error: missing
        .map((f) => `published package is missing CLI entrypoint: ${f} (add it to package.json "files")`)
        .join("\n"),
    };
  }

  return { ok: true };
}

function isDirectRun(): boolean {
  const entry = process.argv[1]?.replaceAll("\\", "/");
  return !!entry && /verify-pack-entrypoints\.(ts|js)$/.test(entry);
}

if (isDirectRun()) {
  const result = verifyPackJson(readFileSync(0, "utf8"));
  if (!result.ok) {
    for (const line of result.error.split("\n")) {
      console.error(`::error::${line}`);
    }
    process.exit(1);
  }
  console.log("All CLI entrypoints are present in the package.");
}
