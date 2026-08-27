import * as fs from "fs";
import * as path from "path";

export type PathStatus = "unvisited" | "reached" | "explored";
export type PathSource = "sitemap" | "discovered";

export interface SiteMapEntry {
  path: string;
  source: PathSource;
  status: PathStatus;
  /** Times an agent entered this path (not consecutive stays). */
  visitCount: number;
  maxConsecutiveIterations: number;
  lastVisitedAt: string | null;
  lastRunId: string | null;
}

export interface SiteMap {
  origin: string;
  updatedAt: string;
  entries: Record<string, SiteMapEntry>;
}

export interface SiteMapStats {
  known: number;
  unvisited: number;
  reached: number;
  explored: number;
  exploredRate: number;
  reachedRate: number;
}

export interface RecordVisitOptions {
  /** True when the agent just entered this path (path changed). */
  isNewEntry: boolean;
  consecutiveIterations: number;
}

export interface IngestOptions {
  runBudget: number;
  usedBudget: number;
}

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number; text: string }>;

export const EXPLORED_THRESHOLD = 2;
export const MAX_SITEMAP_PATHS = 2000;
export const MAX_SITEMAP_INDEX_CHILDREN = 20;
export const MAX_DISCOVERED_PER_RUN = 500;
export const DEFAULT_PERSONA_TOP_N = 12;

function siteMapFilePath(): string {
  return path.join(process.cwd(), "coverage", "site-map.json");
}

const EXCLUDED_EXACT = new Set([
  "/logout",
  "/signout",
  "/sign-out",
  "/oauth",
  "/auth/callback",
  "/callback",
]);

const EXCLUDED_EXTENSIONS = new Set([
  ".css", ".js", ".mjs", ".cjs", ".map",
  ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
  ".woff", ".woff2", ".ttf", ".eot",
  ".mp4", ".webm", ".mp3", ".wav",
  ".pdf", ".zip", ".gz", ".tgz",
]);

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMERIC_RE = /^\d+$/;

export function emptySiteMap(origin: string): SiteMap {
  return {
    origin: origin.replace(/\/$/, ""),
    updatedAt: new Date().toISOString(),
    entries: {},
  };
}

export function collapseDynamicSegments(pathname: string): string {
  const parts = pathname.split("/").map((seg) => {
    if (!seg) return seg;
    if (NUMERIC_RE.test(seg) || UUID_RE.test(seg)) return ":id";
    return seg;
  });
  const collapsed = parts.join("/");
  return collapsed === "" ? "/" : collapsed;
}

export function isExcludedPath(pathname: string): boolean {
  const lower = pathname.toLowerCase();
  if (EXCLUDED_EXACT.has(lower)) return true;
  if (lower.startsWith("/oauth/") || lower.startsWith("/auth/callback")) return true;
  const ext = path.posix.extname(lower);
  if (ext && EXCLUDED_EXTENSIONS.has(ext)) return true;
  return false;
}

/**
 * Normalize a URL or path to a map key: same-origin path only, query/hash stripped,
 * dynamic segments collapsed. Returns null when out of scope.
 */
export function normalizePath(urlOrPath: string, origin: string): string | null {
  const base = origin.replace(/\/$/, "");
  try {
    let pathname: string;
    if (/^https?:\/\//i.test(urlOrPath)) {
      const u = new URL(urlOrPath);
      if (u.origin !== base) return null;
      pathname = u.pathname || "/";
    } else {
      const pathOnly = urlOrPath.split("#")[0].split("?")[0];
      pathname = pathOnly.startsWith("/") ? pathOnly : `/${pathOnly}`;
    }
    if (pathname.length > 1 && pathname.endsWith("/")) {
      pathname = pathname.slice(0, -1);
    }
    if (!pathname) pathname = "/";
    const collapsed = collapseDynamicSegments(pathname);
    if (isExcludedPath(collapsed)) return null;
    return collapsed;
  } catch {
    return null;
  }
}

export function loadSiteMap(origin: string): SiteMap {
  const expectedOrigin = origin.replace(/\/$/, "");
  try {
    const filePath = siteMapFilePath();
    if (fs.existsSync(filePath)) {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as SiteMap;
      if (parsed && typeof parsed === "object" && parsed.entries && typeof parsed.entries === "object") {
        if (!parsed.origin || parsed.origin === expectedOrigin) {
          return {
            origin: expectedOrigin,
            updatedAt: parsed.updatedAt ?? new Date().toISOString(),
            entries: parsed.entries,
          };
        }
        return emptySiteMap(expectedOrigin);
      }
    }
  } catch {
    /* ignore corrupt file */
  }
  return emptySiteMap(expectedOrigin);
}

export function saveSiteMap(map: SiteMap): void {
  map.updatedAt = new Date().toISOString();
  const filePath = siteMapFilePath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(map, null, 2), "utf-8");
}

export function ensurePath(map: SiteMap, pathname: string, source: PathSource): SiteMapEntry | null {
  if (!pathname || isExcludedPath(pathname)) return null;
  const existing = map.entries[pathname];
  if (existing) return existing;
  const entry: SiteMapEntry = {
    path: pathname,
    source,
    status: "unvisited",
    visitCount: 0,
    maxConsecutiveIterations: 0,
    lastVisitedAt: null,
    lastRunId: null,
  };
  map.entries[pathname] = entry;
  return entry;
}

export function recordVisit(
  map: SiteMap,
  pathname: string,
  runId: string,
  options: RecordVisitOptions,
): SiteMapEntry | null {
  const entry = ensurePath(map, pathname, "discovered");
  if (!entry) return null;

  if (options.isNewEntry) {
    entry.visitCount += 1;
  }

  entry.maxConsecutiveIterations = Math.max(
    entry.maxConsecutiveIterations,
    options.consecutiveIterations,
  );
  entry.lastVisitedAt = new Date().toISOString();
  entry.lastRunId = runId;

  if (entry.status === "unvisited") {
    entry.status = "reached";
  }
  if (options.consecutiveIterations >= EXPLORED_THRESHOLD) {
    entry.status = "explored";
  }

  return entry;
}

/**
 * Add discovered paths as unvisited. Returns how many were newly added
 * and the updated usedBudget (only new paths consume budget).
 */
export function ingestDiscoveredPaths(
  map: SiteMap,
  paths: string[],
  options: IngestOptions,
): { added: number; usedBudget: number } {
  let added = 0;
  let usedBudget = options.usedBudget;
  for (const raw of paths) {
    if (usedBudget >= options.runBudget) break;
    if (!raw || map.entries[raw]) continue;
    if (isExcludedPath(raw)) continue;
    ensurePath(map, raw, "discovered");
    added += 1;
    usedBudget += 1;
  }
  return { added, usedBudget };
}

export function computeSiteMapStats(map: SiteMap): SiteMapStats {
  let unvisited = 0;
  let reached = 0;
  let explored = 0;
  for (const entry of Object.values(map.entries)) {
    if (entry.status === "unvisited") unvisited += 1;
    else if (entry.status === "reached") reached += 1;
    else explored += 1;
  }
  const known = unvisited + reached + explored;
  return {
    known,
    unvisited,
    reached,
    explored,
    exploredRate: known === 0 ? 0 : explored / known,
    reachedRate: known === 0 ? 0 : (reached + explored) / known,
  };
}

function pct(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

export function formatSiteMapForPersona(
  map: SiteMap,
  opts?: { recentPaths?: string[]; topN?: number },
): string {
  const topN = opts?.topN ?? DEFAULT_PERSONA_TOP_N;
  const stats = computeSiteMapStats(map);
  if (stats.known === 0) {
    return "(site map is empty — no sitemap seed and no discovered paths yet. Recruit agents who will naturally explore diverse areas of the app.)";
  }

  const entries = Object.values(map.entries);
  const unvisited = entries
    .filter((e) => e.status === "unvisited")
    .map((e) => e.path)
    .sort()
    .slice(0, topN);
  const thin = entries
    .filter((e) => e.status === "reached")
    .sort((a, b) => a.visitCount - b.visitCount || a.path.localeCompare(b.path))
    .map((e) => `${e.path} (visits:${e.visitCount})`)
    .slice(0, topN);

  const recent = (opts?.recentPaths ?? [])
    .map((p) => normalizePath(p, map.origin) ?? p)
    .filter((p, i, arr) => arr.indexOf(p) === i)
    .slice(0, topN);

  const lines = [
    `Site map coverage for ${map.origin}:`,
    `Known: ${stats.known} | unvisited: ${stats.unvisited} | reached: ${stats.reached} | explored: ${stats.explored}`,
    `Explored rate: ${pct(stats.exploredRate)} | Reached rate: ${pct(stats.reachedRate)}`,
    `(Explored rate may drop when the map grows — that means the known world expanded.)`,
    unvisited.length > 0
      ? `Unvisited paths (recruit agents who would naturally go here):\n${unvisited.map((p) => `- ${p}`).join("\n")}`
      : "Unvisited paths: (none)",
    thin.length > 0
      ? `Thinly visited (reached only):\n${thin.map((p) => `- ${p}`).join("\n")}`
      : "Thinly visited: (none)",
    recent.length > 0
      ? `Paths touched in the most recent run:\n${recent.map((p) => `- ${p}`).join("\n")}`
      : "Paths touched in the most recent run: (none recorded)",
  ];
  return lines.join("\n");
}

export function formatSiteMapLogLine(map: SiteMap): string {
  const s = computeSiteMapStats(map);
  return `[site-map] known=${s.known} explored=${s.explored} (${pct(s.exploredRate)})`;
}

function extractLocs(xml: string): string[] {
  const locs: string[] = [];
  const re = /<loc>\s*([^<]+?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    locs.push(m[1].trim());
  }
  return locs;
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

async function defaultFetch(url: string): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/xml,text/xml,*/*" },
      redirect: "follow",
    });
    const contentLength = Number(res.headers.get("content-length") ?? "0");
    if (contentLength > 5_000_000) {
      return { ok: false, status: res.status, text: "" };
    }
    const text = await res.text();
    if (text.length > 5_000_000) {
      return { ok: false, status: res.status, text: "" };
    }
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Seed map from sitemap.xml / sitemap_index.xml. Never throws.
 */
export async function seedFromSitemap(
  map: SiteMap,
  fetchFn: FetchFn = defaultFetch,
): Promise<{ seeded: number; warnings: string[] }> {
  const warnings: string[] = [];
  const origin = map.origin;
  const candidates = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];

  let xml: string | null = null;
  for (const url of candidates) {
    const res = await fetchFn(url);
    if (res.ok && res.text && /<urlset|<sitemapindex/i.test(res.text)) {
      xml = res.text;
      break;
    }
    if (res.status > 0 && res.status !== 404) {
      warnings.push(`sitemap fetch ${url} returned ${res.status}`);
    }
  }

  if (!xml) {
    warnings.push("no usable sitemap.xml found — starting with empty/discovered map only");
    return { seeded: 0, warnings };
  }

  let locUrls: string[] = [];
  if (isSitemapIndex(xml)) {
    const childUrls = extractLocs(xml).slice(0, MAX_SITEMAP_INDEX_CHILDREN);
    for (const child of childUrls) {
      if (locUrls.length >= MAX_SITEMAP_PATHS) break;
      const res = await fetchFn(child);
      if (!res.ok) {
        warnings.push(`child sitemap ${child} failed (${res.status})`);
        continue;
      }
      locUrls.push(...extractLocs(res.text));
    }
  } else {
    locUrls = extractLocs(xml);
  }

  let seeded = 0;
  for (const loc of locUrls) {
    if (seeded >= MAX_SITEMAP_PATHS) {
      warnings.push(`sitemap path cap ${MAX_SITEMAP_PATHS} reached`);
      break;
    }
    const normalized = normalizePath(loc, origin);
    if (!normalized) continue;
    if (map.entries[normalized]) continue;
    ensurePath(map, normalized, "sitemap");
    seeded += 1;
  }

  return { seeded, warnings };
}

/** Collect same-origin pathnames from anchor tags on a Playwright page. */
export async function collectSameOriginHrefs(
  page: { evaluate: (fn: (origin: string) => string[], origin: string) => Promise<string[]> },
  origin: string,
): Promise<string[]> {
  try {
    return await page.evaluate((orig) => {
      const out: string[] = [];
      for (const a of Array.from(document.querySelectorAll("a[href]"))) {
        const href = (a as HTMLAnchorElement).href;
        if (!href) continue;
        try {
          const u = new URL(href);
          if (u.origin === orig) out.push(u.pathname);
        } catch { /* skip */ }
      }
      return out;
    }, origin.replace(/\/$/, ""));
  } catch {
    return [];
  }
}
