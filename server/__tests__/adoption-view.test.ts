import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../framework/adoption.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../framework/adoption.js")>();
  return { ...actual, loadAdoptionStats: vi.fn(), loadIssueLinks: vi.fn() };
});

import { loadAdoptionStats, loadIssueLinks, type IssueLink } from "../../framework/adoption.js";
import { buildAdoptionView } from "../adoption-view.js";

function makeLink(overrides: Partial<IssueLink> = {}): IssueLink {
  return {
    url: "https://github.com/o/r/issues/12",
    title: "[bug] Login broken",
    category: "bug",
    lenses: ["Security"],
    scenarios: [],
    runId: "run_1",
    createdAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(loadAdoptionStats).mockReturnValue({ byLens: {}, byCategory: {} });
  vi.mocked(loadIssueLinks).mockReturnValue([]);
});

describe("buildAdoptionView", () => {
  it("起票実績も集計も無ければ null（新規インストールで 0% と見せない）", () => {
    expect(buildAdoptionView()).toBeNull();
  });

  it("起票済みだが未 close なら pending だけのビューを返す", () => {
    vi.mocked(loadIssueLinks).mockReturnValue([makeLink(), makeLink({ url: "https://github.com/o/r/issues/13" })]);
    const view = buildAdoptionView()!;
    expect(view.pending).toBe(2);
    expect(view.overall).toEqual({ adopted: 0, rejected: 0, total: 0, rate: null });
    expect(view.recent).toEqual([]);
  });

  it("overall は lens ではなく category を基準に数える（lens は重複するため）", () => {
    vi.mocked(loadAdoptionStats).mockReturnValue({
      // 1件の issue に 2 つの lens が紐づくと lens 側は 2 回数えられる
      byLens: { Security: { adopted: 1, rejected: 0 }, Accessibility: { adopted: 1, rejected: 0 } },
      byCategory: { bug: { adopted: 1, rejected: 1 } },
    });
    const view = buildAdoptionView()!;
    expect(view.overall).toEqual({ adopted: 1, rejected: 1, total: 2, rate: 0.5 });
    expect(view.byLens.map((e) => e.name).sort()).toEqual(["Accessibility", "Security"]);
  });

  it("採用率つきで件数の多い順に並べる", () => {
    vi.mocked(loadAdoptionStats).mockReturnValue({
      byLens: {
        Security: { adopted: 1, rejected: 3 },
        Accessibility: { adopted: 4, rejected: 1 },
      },
      byCategory: { bug: { adopted: 5, rejected: 4 } },
    });
    const view = buildAdoptionView()!;
    expect(view.byLens[0]).toEqual({ name: "Accessibility", adopted: 4, rejected: 1, total: 5, rate: 0.8 });
    expect(view.byLens[1]).toEqual({ name: "Security", adopted: 1, rejected: 3, total: 4, rate: 0.25 });
  });

  it("解決済み issue を新しい順に返し、未解決は含めない", () => {
    vi.mocked(loadAdoptionStats).mockReturnValue({ byLens: {}, byCategory: { bug: { adopted: 1, rejected: 1 } } });
    vi.mocked(loadIssueLinks).mockReturnValue([
      makeLink({ url: "https://x/1", title: "old", resolution: "adopted", resolvedAt: "2026-06-01T00:00:00.000Z" }),
      makeLink({ url: "https://x/2", title: "new", resolution: "rejected", resolvedAt: "2026-07-01T00:00:00.000Z" }),
      makeLink({ url: "https://x/3", title: "open" }),
    ]);
    const view = buildAdoptionView()!;
    expect(view.recent.map((r) => r.title)).toEqual(["new", "old"]);
    expect(view.recent[0].resolution).toBe("rejected");
    expect(view.pending).toBe(1);
  });

  it("解決済みが 8 件を超えたら直近 8 件に絞る", () => {
    vi.mocked(loadAdoptionStats).mockReturnValue({ byLens: {}, byCategory: { bug: { adopted: 10, rejected: 0 } } });
    vi.mocked(loadIssueLinks).mockReturnValue(
      Array.from({ length: 10 }, (_, i) => makeLink({
        url: `https://x/${i}`,
        title: `issue ${i}`,
        resolution: "adopted",
        resolvedAt: `2026-06-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      })),
    );
    const view = buildAdoptionView()!;
    expect(view.recent).toHaveLength(8);
    expect(view.recent[0].title).toBe("issue 9");
  });
});
