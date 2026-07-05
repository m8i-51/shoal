import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof path>();
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

import { scoreRun, computeExperienceScore, formatExperienceLine } from "../experience-score";
import type { Coverage, RunCoverage } from "../coverage";

function makeEntry(overrides: Partial<RunCoverage> = {}): RunCoverage {
  return {
    runId: "run_1",
    timestamp: new Date().toISOString(),
    findingsCount: 0,
    byCategory: {},
    byLens: {},
    byScenario: {},
    visitedPaths: [],
    ...overrides,
  };
}

function setupMockCoverage(coverage: Coverage) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(coverage) as unknown as ReturnType<typeof fs.readFileSync>);
}

describe("scoreRun", () => {
  it("outcome も regression もないエントリーは null を返す", () => {
    expect(scoreRun(makeEntry())).toBeNull();
  });

  it("シナリオ達成率と摩擦（平均手数）からスコアを計算する", () => {
    // 達成 2/4 = 0.5、達成分の平均手数 (4+8)/2 = 6 → friction = 1 - 6/12 = 0.5
    // score = (0.5*0.6 + 0.5*0.2) / 0.8 * 100 = 50
    const entry = makeEntry({
      scenarioOutcomes: [
        { scenarioTitle: "A", achieved: true, iterations: 4 },
        { scenarioTitle: "B", achieved: true, iterations: 8 },
        { scenarioTitle: "C", achieved: false, iterations: 12 },
        { scenarioTitle: "D", achieved: false, iterations: null },
      ],
    });
    const result = scoreRun(entry);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(50);
    expect(result!.achievementRate).toBe(0.5);
    expect(result!.avgIterations).toBe(6);
    expect(result!.regressionRate).toBeNull();
  });

  it("regression のみのエントリーもスコア対象になる", () => {
    // 1/4 regressed → value 0.75 → score 75
    const entry = makeEntry({ regression: { checked: 4, regressed: 1 } });
    const result = scoreRun(entry);
    expect(result).not.toBeNull();
    expect(result!.score).toBe(75);
    expect(result!.achievementRate).toBeNull();
    expect(result!.regressionRate).toBe(0.25);
  });

  it("全成分が揃った場合は 60/20/20 の加重平均になる", () => {
    // achievement 1.0 (0.6) + friction 1-3/12=0.75 (0.2) + regression 1.0 (0.2)
    // = 0.6 + 0.15 + 0.2 = 0.95 → 95
    const entry = makeEntry({
      scenarioOutcomes: [
        { scenarioTitle: "A", achieved: true, iterations: 3 },
        { scenarioTitle: "B", achieved: true, iterations: 3 },
      ],
      regression: { checked: 2, regressed: 0 },
    });
    expect(scoreRun(entry)!.score).toBe(95);
  });

  it("iterations が null や 0 の outcome は摩擦計算から除外する", () => {
    const entry = makeEntry({
      scenarioOutcomes: [
        { scenarioTitle: "A", achieved: true, iterations: null },
        { scenarioTitle: "B", achieved: true, iterations: 0 },
      ],
    });
    const result = scoreRun(entry);
    // 摩擦成分なし → achievement のみ → 100
    expect(result!.score).toBe(100);
    expect(result!.avgIterations).toBeNull();
  });

  it("手数が予算(12)を超えても friction は 0 で下げ止まる", () => {
    const entry = makeEntry({
      scenarioOutcomes: [{ scenarioTitle: "A", achieved: true, iterations: 20 }],
    });
    // achievement 1.0 (0.6) + friction 0 (0.2) = 0.6/0.8 = 75
    expect(scoreRun(entry)!.score).toBe(75);
  });
});

describe("computeExperienceScore", () => {
  it("coverage がない場合は null を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(computeExperienceScore()).toBeNull();
  });

  it("スコア対象データのないエントリーだけの場合は null を返す", () => {
    setupMockCoverage({ entries: [makeEntry(), makeEntry({ runId: "run_2" })] });
    expect(computeExperienceScore()).toBeNull();
  });

  it("最新スコアと直前 run との delta を返す", () => {
    setupMockCoverage({
      entries: [
        makeEntry({
          runId: "run_1",
          scenarioOutcomes: [
            { scenarioTitle: "A", achieved: true, iterations: null },
            { scenarioTitle: "B", achieved: false, iterations: null },
          ], // 50
        }),
        makeEntry({ runId: "run_2" }), // スコア対象外 — trend から除外される
        makeEntry({
          runId: "run_3",
          scenarioOutcomes: [
            { scenarioTitle: "A", achieved: true, iterations: null },
          ], // 100
        }),
      ],
    });
    const result = computeExperienceScore();
    expect(result).not.toBeNull();
    expect(result!.latest.runId).toBe("run_3");
    expect(result!.latest.score).toBe(100);
    expect(result!.delta).toBe(50);
    expect(result!.trend.map((t) => t.runId)).toEqual(["run_1", "run_3"]);
  });

  it("スコア対象 run が 1 件のときは delta が null になる", () => {
    setupMockCoverage({
      entries: [
        makeEntry({
          scenarioOutcomes: [{ scenarioTitle: "A", achieved: true, iterations: null }],
        }),
      ],
    });
    const result = computeExperienceScore();
    expect(result!.delta).toBeNull();
  });
});

describe("formatExperienceLine", () => {
  it("スコア・delta・成分をまとめた 1 行を生成する", () => {
    setupMockCoverage({
      entries: [
        makeEntry({
          runId: "run_1",
          scenarioOutcomes: [{ scenarioTitle: "A", achieved: false, iterations: null }], // 0
        }),
        makeEntry({
          runId: "run_2",
          scenarioOutcomes: [
            { scenarioTitle: "A", achieved: true, iterations: 6 },
            { scenarioTitle: "B", achieved: true, iterations: 6 },
          ],
          regression: { checked: 2, regressed: 1 },
        }),
      ],
    });
    const line = formatExperienceLine(computeExperienceScore()!);
    expect(line).toContain("experience score:");
    expect(line).toContain("scenarios 100% achieved");
    expect(line).toContain("avg 6 iterations");
    expect(line).toContain("regression rate 50%");
    expect(line).toMatch(/\(\+\d+\)/);
  });
});
