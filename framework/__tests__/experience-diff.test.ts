import { describe, it, expect, vi, beforeEach } from "vitest";

import { inferRoutesFromFiles, resolvePrNumber, formatDiffSummary, postPrComment } from "../experience-diff";
import type { Finding } from "../types";

describe("inferRoutesFromFiles", () => {
  it("Next.js pages router のファイルをルートにマッピングする", () => {
    expect(inferRoutesFromFiles([
      "pages/index.tsx",
      "pages/checkout.tsx",
      "src/pages/items/[id].tsx",
    ])).toEqual(["/", "/checkout", "/items/[id]"]);
  });

  it("pages/api と _app / _document は除外する", () => {
    expect(inferRoutesFromFiles([
      "pages/api/items.ts",
      "pages/_app.tsx",
      "pages/_document.tsx",
    ])).toEqual([]);
  });

  it("Next.js app router の page/layout をルートにマッピングし route group を除去する", () => {
    expect(inferRoutesFromFiles([
      "app/page.tsx",
      "src/app/dashboard/page.tsx",
      "app/(marketing)/pricing/page.tsx",
      "app/settings/layout.tsx",
    ])).toEqual(["/", "/dashboard", "/pricing", "/settings"]);
  });

  it("views/ や routes/ ディレクトリも汎用マッピングする", () => {
    expect(inferRoutesFromFiles(["src/views/orders.vue", "routes/reports/index.ts"]))
      .toEqual(["/orders", "/reports"]);
  });

  it("マッピングできないファイルは無視し、重複を除去する", () => {
    expect(inferRoutesFromFiles([
      "lib/utils.ts",
      "README.md",
      "pages/checkout.tsx",
      "src/pages/checkout.tsx",
    ])).toEqual(["/checkout"]);
  });
});

describe("resolvePrNumber", () => {
  it("SHOAL_PR_NUMBER を最優先する", () => {
    expect(resolvePrNumber({ SHOAL_PR_NUMBER: "42", GITHUB_REF: "refs/pull/7/merge" })).toBe(42);
  });

  it("GitHub Actions の GITHUB_REF から解決する", () => {
    expect(resolvePrNumber({ GITHUB_REF: "refs/pull/123/merge" })).toBe(123);
  });

  it("どちらもなければ null", () => {
    expect(resolvePrNumber({})).toBeNull();
    expect(resolvePrNumber({ GITHUB_REF: "refs/heads/main" })).toBeNull();
    expect(resolvePrNumber({ SHOAL_PR_NUMBER: "abc" })).toBeNull();
  });
});

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    runId: "run_1",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Checkout button unresponsive",
    body: "I tapped the checkout button and nothing happened.",
    category: "bug",
    timestamp: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

describe("formatDiffSummary", () => {
  const base = { runId: "run_1", baseRef: "origin/main", focusRoutes: ["/checkout"], findings: [], experience: null };

  it("スコア・ルート・findings を markdown にまとめる", () => {
    const runExp = { runId: "run_1", timestamp: "t", score: 64, achievementRate: 0.6, avgIterations: 5, regressionRate: null };
    const md = formatDiffSummary({
      ...base,
      findings: [makeFinding()],
      experience: { latest: runExp, delta: -8, trend: [runExp] },
    });
    expect(md).toContain("Experience Score: 64/100");
    expect(md).toContain("▼8");
    expect(md).toContain("`/checkout`");
    expect(md).toContain("[bug] Checkout button unresponsive");
    expect(md).toContain("run `run_1`");
  });

  it("findings ゼロなら成功メッセージ", () => {
    const md = formatDiffSummary(base);
    expect(md).toContain("without reporting any findings");
  });

  it("ルート未推定の場合はその旨を書く", () => {
    const md = formatDiffSummary({ ...base, focusRoutes: [] });
    expect(md).toContain("No route mapping could be inferred");
  });

  it("findings は 10 件で切り詰めて残数を表示する", () => {
    const findings = Array.from({ length: 13 }, (_, i) => makeFinding({ id: `f${i}`, title: `Finding ${i}` }));
    const md = formatDiffSummary({ ...base, findings });
    expect(md).toContain("Findings (13)");
    expect(md).toContain("…and 3 more");
    expect(md).not.toContain("Finding 12");
  });
});

describe("postPrComment", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  it("GitHub API に POST し成功で true を返す", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
    const ok = await postPrComment("body", { token: "tok", repo: "owner/repo", prNumber: 5 });
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.github.com/repos/owner/repo/issues/5/comments",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("失敗時は false を返す", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" } as Response);
    expect(await postPrComment("body", { token: "tok", repo: "o/r", prNumber: 5 })).toBe(false);
  });
});
