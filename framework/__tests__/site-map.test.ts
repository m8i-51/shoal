import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  emptySiteMap,
  normalizePath,
  collapseDynamicSegments,
  isExcludedPath,
  ensurePath,
  recordVisit,
  ingestDiscoveredPaths,
  computeSiteMapStats,
  formatSiteMapForPersona,
  seedFromSitemap,
  loadSiteMap,
  saveSiteMap,
  EXPLORED_THRESHOLD,
  MAX_DISCOVERED_PER_RUN,
} from "../site-map";

const ORIGIN = "https://app.example.com";

describe("collapseDynamicSegments", () => {
  it("collapses numeric segments to :id", () => {
    expect(collapseDynamicSegments("/products/123")).toBe("/products/:id");
    expect(collapseDynamicSegments("/products/123/edit")).toBe("/products/:id/edit");
  });

  it("collapses UUID segments to :id", () => {
    expect(collapseDynamicSegments("/users/a1b2c3d4-e5f6-4789-abcd-ef1234567890/edit")).toBe(
      "/users/:id/edit",
    );
  });

  it("leaves static segments alone", () => {
    expect(collapseDynamicSegments("/settings/profile")).toBe("/settings/profile");
  });
});

describe("normalizePath", () => {
  it("strips query and hash", () => {
    expect(normalizePath("/settings?tab=1#top", ORIGIN)).toBe("/settings");
  });

  it("accepts absolute same-origin URLs", () => {
    expect(normalizePath("https://app.example.com/dashboard", ORIGIN)).toBe("/dashboard");
  });

  it("rejects other origins", () => {
    expect(normalizePath("https://other.example.com/x", ORIGIN)).toBeNull();
  });

  it("collapses dynamic segments", () => {
    expect(normalizePath("/orders/42", ORIGIN)).toBe("/orders/:id");
  });

  it("normalizes trailing slash (except root)", () => {
    expect(normalizePath("/settings/", ORIGIN)).toBe("/settings");
    expect(normalizePath("/", ORIGIN)).toBe("/");
  });
});

describe("isExcludedPath", () => {
  it("excludes logout and oauth paths", () => {
    expect(isExcludedPath("/logout")).toBe(true);
    expect(isExcludedPath("/oauth/start")).toBe(true);
    expect(isExcludedPath("/auth/callback")).toBe(true);
  });

  it("excludes static asset extensions", () => {
    expect(isExcludedPath("/assets/app.js")).toBe(true);
    expect(isExcludedPath("/logo.png")).toBe(true);
  });

  it("does not exclude /api/ or normal app paths", () => {
    expect(isExcludedPath("/api/users")).toBe(false);
    expect(isExcludedPath("/settings")).toBe(false);
  });
});

describe("recordVisit", () => {
  it("transitions unvisited → reached → explored and does not demote", () => {
    const map = emptySiteMap(ORIGIN);
    ensurePath(map, "/a", "sitemap");
    expect(map.entries["/a"].status).toBe("unvisited");

    recordVisit(map, "/a", "run1", { isNewEntry: true, consecutiveIterations: 1 });
    expect(map.entries["/a"].status).toBe("reached");
    expect(map.entries["/a"].visitCount).toBe(1);

    recordVisit(map, "/a", "run1", {
      isNewEntry: false,
      consecutiveIterations: EXPLORED_THRESHOLD,
    });
    expect(map.entries["/a"].status).toBe("explored");
    expect(map.entries["/a"].visitCount).toBe(1);

    recordVisit(map, "/a", "run1", { isNewEntry: false, consecutiveIterations: 5 });
    expect(map.entries["/a"].status).toBe("explored");
    expect(map.entries["/a"].visitCount).toBe(1);
  });

  it("increments visitCount only on new entry", () => {
    const map = emptySiteMap(ORIGIN);
    recordVisit(map, "/b", "run1", { isNewEntry: true, consecutiveIterations: 1 });
    recordVisit(map, "/b", "run1", { isNewEntry: false, consecutiveIterations: 2 });
    recordVisit(map, "/b", "run1", { isNewEntry: true, consecutiveIterations: 1 });
    expect(map.entries["/b"].visitCount).toBe(2);
  });
});

describe("ingestDiscoveredPaths", () => {
  it("adds unvisited paths and respects run budget", () => {
    const map = emptySiteMap(ORIGIN);
    const first = ingestDiscoveredPaths(map, ["/a", "/b", "/c"], {
      runBudget: 2,
      usedBudget: 0,
    });
    expect(first.added).toBe(2);
    expect(first.usedBudget).toBe(2);
    expect(Object.keys(map.entries).sort()).toEqual(["/a", "/b"]);

    const second = ingestDiscoveredPaths(map, ["/c", "/d"], {
      runBudget: MAX_DISCOVERED_PER_RUN,
      usedBudget: first.usedBudget,
    });
    expect(second.added).toBe(2);
    expect(map.entries["/c"].status).toBe("unvisited");
    expect(map.entries["/c"].source).toBe("discovered");
  });

  it("does not consume budget for existing paths", () => {
    const map = emptySiteMap(ORIGIN);
    ensurePath(map, "/a", "sitemap");
    const result = ingestDiscoveredPaths(map, ["/a", "/b"], { runBudget: 10, usedBudget: 0 });
    expect(result.added).toBe(1);
    expect(result.usedBudget).toBe(1);
  });
});

describe("computeSiteMapStats", () => {
  it("computes explored rate and drops when known grows", () => {
    const map = emptySiteMap(ORIGIN);
    ensurePath(map, "/a", "sitemap");
    recordVisit(map, "/a", "run1", { isNewEntry: true, consecutiveIterations: 2 });
    const before = computeSiteMapStats(map);
    expect(before.explored).toBe(1);
    expect(before.exploredRate).toBe(1);

    ensurePath(map, "/b", "sitemap");
    ensurePath(map, "/c", "sitemap");
    const after = computeSiteMapStats(map);
    expect(after.known).toBe(3);
    expect(after.exploredRate).toBeCloseTo(1 / 3);
  });
});

describe("formatSiteMapForPersona", () => {
  it("includes rates, unvisited paths, and recent paths", () => {
    const map = emptySiteMap(ORIGIN);
    ensurePath(map, "/gone", "sitemap");
    ensurePath(map, "/seen", "sitemap");
    recordVisit(map, "/seen", "run1", { isNewEntry: true, consecutiveIterations: 1 });
    const text = formatSiteMapForPersona(map, { recentPaths: ["/seen"] });
    expect(text).toContain("Explored rate:");
    expect(text).toContain("/gone");
    expect(text).toContain("/seen");
    expect(text).toContain("Paths touched in the most recent run");
  });
});

describe("seedFromSitemap", () => {
  it("seeds paths from a urlset", async () => {
    const map = emptySiteMap(ORIGIN);
    const xml = `<?xml version="1.0"?>
      <urlset>
        <url><loc>https://app.example.com/home</loc></url>
        <url><loc>https://app.example.com/about</loc></url>
        <url><loc>https://other.com/skip</loc></url>
        <url><loc>https://app.example.com/logout</loc></url>
      </urlset>`;
    const result = await seedFromSitemap(map, async (url) => {
      if (url.endsWith("/sitemap.xml")) return { ok: true, status: 200, text: xml };
      return { ok: false, status: 404, text: "" };
    });
    expect(result.seeded).toBe(2);
    expect(map.entries["/home"]?.source).toBe("sitemap");
    expect(map.entries["/about"]?.status).toBe("unvisited");
    expect(map.entries["/logout"]).toBeUndefined();
  });

  it("handles 404 and broken XML without throwing", async () => {
    const map = emptySiteMap(ORIGIN);
    const missing = await seedFromSitemap(map, async () => ({ ok: false, status: 404, text: "" }));
    expect(missing.seeded).toBe(0);
    expect(missing.warnings.length).toBeGreaterThan(0);

    const broken = await seedFromSitemap(map, async () => ({
      ok: true,
      status: 200,
      text: "<html>not a sitemap</html>",
    }));
    expect(broken.seeded).toBe(0);
  });

  it("follows sitemap index with child cap", async () => {
    const map = emptySiteMap(ORIGIN);
    const index = `<?xml version="1.0"?>
      <sitemapindex>
        <sitemap><loc>https://app.example.com/s1.xml</loc></sitemap>
        <sitemap><loc>https://app.example.com/s2.xml</loc></sitemap>
      </sitemapindex>`;
    const child = (n: number) =>
      `<?xml version="1.0"?><urlset><url><loc>https://app.example.com/p${n}</loc></url></urlset>`;
    const result = await seedFromSitemap(map, async (url) => {
      if (url.endsWith("/sitemap.xml")) return { ok: true, status: 200, text: index };
      if (url.endsWith("/s1.xml")) return { ok: true, status: 200, text: child(1) };
      if (url.endsWith("/s2.xml")) return { ok: true, status: 200, text: child(2) };
      return { ok: false, status: 404, text: "" };
    });
    expect(result.seeded).toBe(2);
    expect(map.entries["/p1"]).toBeDefined();
    expect(map.entries["/p2"]).toBeDefined();
  });
});

describe("loadSiteMap / saveSiteMap", () => {
  const tmpDir = path.join(os.tmpdir(), `site-map-test-${Date.now()}`);
  const prevCwd = process.cwd();

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("round-trips through coverage/site-map.json", () => {
    const map = emptySiteMap(ORIGIN);
    ensurePath(map, "/x", "sitemap");
    recordVisit(map, "/x", "run9", { isNewEntry: true, consecutiveIterations: 2 });
    saveSiteMap(map);

    const loaded = loadSiteMap(ORIGIN);
    expect(loaded.entries["/x"].status).toBe("explored");
    expect(loaded.entries["/x"].visitCount).toBe(1);
    expect(loaded.entries["/x"].lastRunId).toBe("run9");
  });

  it("returns empty map when file is corrupt", () => {
    fs.mkdirSync(path.join(tmpDir, "coverage"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "coverage", "site-map.json"), "{not-json", "utf-8");
    const loaded = loadSiteMap(ORIGIN);
    expect(loaded.entries).toEqual({});
  });
});
