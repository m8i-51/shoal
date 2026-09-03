import { describe, it, expect } from "vitest";
import { computeCostStats, formatTokens } from "../cost-stats";
import type { RunSummary } from "../../types";

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run_1",
    startedAt: "2026-08-01T00:00:00.000Z",
    completedAt: "2026-08-01T00:10:00.000Z",
    status: "completed",
    agentCount: 3,
    completedAgents: 3,
    errorAgents: 0,
    findingCount: 2,
    findingsByCategory: { bug: 2 },
    hasReport: true,
    estimatedCostUSD: 1,
    inputTokens: 1000,
    outputTokens: 500,
    regressionChecked: 0,
    regressionFailed: 0,
    ...overrides,
  };
}

describe("computeCostStats", () => {
  it("推計コストのある run が1件も無ければ null", () => {
    expect(computeCostStats([])).toBeNull();
    expect(computeCostStats([makeRun({ estimatedCostUSD: null })])).toBeNull();
  });

  it("累計と平均を推計のある run だけで出す", () => {
    const stats = computeCostStats([
      makeRun({ runId: "run_3", estimatedCostUSD: 3 }),
      makeRun({ runId: "run_2", estimatedCostUSD: 1 }),
      makeRun({ runId: "run_1", estimatedCostUSD: null }),
    ])!;
    expect(stats.total).toBe(4);
    expect(stats.average).toBe(2);
    expect(stats.runsWithCost).toBe(2);
    expect(stats.runsWithoutCost).toBe(1);
  });

  it("実行中の run は「推計なし」に数えない（まだ終わっていないだけ）", () => {
    const stats = computeCostStats([
      makeRun({ runId: "run_2", estimatedCostUSD: null, isLive: true }),
      makeRun({ runId: "run_1", estimatedCostUSD: 2 }),
    ])!;
    expect(stats.runsWithoutCost).toBe(0);
    expect(stats.total).toBe(2);
  });

  it("直近 30 日は期間外の run を含めない", () => {
    const now = Date.now();
    const recent = new Date(now - 5 * 24 * 3600 * 1000).toISOString();
    const old = new Date(now - 90 * 24 * 3600 * 1000).toISOString();
    const stats = computeCostStats([
      makeRun({ runId: "run_2", startedAt: recent, estimatedCostUSD: 2 }),
      makeRun({ runId: "run_1", startedAt: old, estimatedCostUSD: 5 }),
    ])!;
    expect(stats.total).toBe(7);
    expect(stats.last30d).toBe(2);
  });

  it("トークンは推計の有無に関わらず全 run を合算する", () => {
    const stats = computeCostStats([
      makeRun({ runId: "run_2", estimatedCostUSD: 1, inputTokens: 100, outputTokens: 10 }),
      makeRun({ runId: "run_1", estimatedCostUSD: null, inputTokens: 200, outputTokens: 20 }),
    ])!;
    expect(stats.inputTokens).toBe(300);
    expect(stats.outputTokens).toBe(30);
  });

  it("trend は古い順（API は新しい順で返すため反転する）", () => {
    const stats = computeCostStats([
      makeRun({ runId: "run_3", estimatedCostUSD: 3 }),
      makeRun({ runId: "run_2", estimatedCostUSD: 2 }),
      makeRun({ runId: "run_1", estimatedCostUSD: 1 }),
    ])!;
    expect(stats.trend.map((t) => t.runId)).toEqual(["run_1", "run_2", "run_3"]);
  });

  it("trend は直近 20 run に絞る", () => {
    const runs = Array.from({ length: 25 }, (_, i) =>
      makeRun({ runId: `run_${25 - i}`, estimatedCostUSD: 1 }));
    const stats = computeCostStats(runs)!;
    expect(stats.trend).toHaveLength(20);
    // 最新 20 件を古い順に並べたもの
    expect(stats.trend[0].runId).toBe("run_6");
    expect(stats.trend[19].runId).toBe("run_25");
  });
});

describe("formatTokens", () => {
  it("桁に応じて K / M に丸める", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1_500)).toBe("2K");
    expect(formatTokens(12_400)).toBe("12K");
    expect(formatTokens(2_450_000)).toBe("2.5M");
  });
});
