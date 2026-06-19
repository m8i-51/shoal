import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const CACHE_DIR = path.join(process.cwd(), "cache", "page-hashes");

function cacheFilePath(host: string): string {
  const safe = host.replace(/[^a-zA-Z0-9.-]/g, "-");
  return path.join(CACHE_DIR, `${safe}.json`);
}

export function loadPageHashes(host: string): Record<string, string> {
  try {
    const p = cacheFilePath(host);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch { /* ignore */ }
  return {};
}

export function updatePageHashes(host: string, updates: Record<string, string>): void {
  if (Object.keys(updates).length === 0) return;
  const existing = loadPageHashes(host);
  const merged = { ...existing, ...updates };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cacheFilePath(host), JSON.stringify(merged, null, 2), "utf-8");
}

export function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}
