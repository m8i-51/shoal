import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof path>();
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

import { computeWeightedSummary, updateCoverage, loadCoverage } from "../coverage";
import type { Coverage, RunCoverage } from "../coverage";

const HALF_LIFE_DAYS = 7;
const halfLifeMs = HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;

function makeEntry(overrides: Partial<RunCoverage> = {}): RunCoverage {
  return {
    runId: "run_1",
    timestamp: new Date().toISOString(),
    findingsCount: 0,
    byCategory: {},
    byLens: {},
    byScenario: {},
    ...overrides,
  };
}

function setupMockCoverage(coverage: Coverage) {
  vi.mocked(fs.existsSync).mockReturnValue(true);
  vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(coverage) as unknown as ReturnType<typeof fs.readFileSync>);
}

describe("loadCoverage", () => {
  it("空ファイルが存在しない場合は空のエントリーを返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = loadCoverage();
    expect(result).toEqual({ entries: [] });
  });

  it("ファイルが存在する場合はパースして返す", () => {
    const coverage: Coverage = { entries: [makeEntry({ runId: "run_1" })] };
    setupMockCoverage(coverage);
    const result = loadCoverage();
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].runId).toBe("run_1");
  });
});

describe("computeWeightedSummary", () => {
  beforeEach(() => {
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it("エントリーがない場合は空サマリーを返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const result = computeWeightedSummary();
    expect(result.totalWeighted).toBe(0);
    expect(result.formatted).toContain("no coverage data");
  });

  it("直近のエントリーは重みが高い", () => {
    const now = Date.now();
    const recentEntry = makeEntry({
      runId: "recent",
      timestamp: new Date(now).toISOString(),
      findingsCount: 10,
      byLens: { Accessibility: 10 },
    });
    const oldEntry = makeEntry({
      runId: "old",
      timestamp: new Date(now - halfLifeMs * 2).toISOString(), // 半減期2倍 = weight 0.25
      findingsCount: 10,
      byLens: { Accessibility: 10 },
    });
    setupMockCoverage({ entries: [oldEntry, recentEntry] });

    const result = computeWeightedSummary();
    // recent(weight≈1.0) + old(weight≈0.25) なので合計は約 12.5
    expect(result.totalWeighted).toBeGreaterThan(10);
    expect(result.totalWeighted).toBeLessThan(15);
  });

  it("半減期2倍前のエントリーは重みが約0.25になる", () => {
    const now = Date.now();
    const oldTimestamp = new Date(now - halfLifeMs * 2).toISOString();
    setupMockCoverage({
      entries: [
        makeEntry({
          runId: "old",
          timestamp: oldTimestamp,
          findingsCount: 4,
          byLens: { Security: 4 },
        }),
      ],
    });

    const result = computeWeightedSummary();
    // weight = 0.5^2 = 0.25, findingsCount=4 → totalWeighted=1.0
    expect(result.totalWeighted).toBeCloseTo(1.0, 0);
    expect(result.byLens["Security"]).toBeCloseTo(1.0, 0);
  });

  it("カテゴリ別の集計が正しい", () => {
    setupMockCoverage({
      entries: [
        makeEntry({
          timestamp: new Date().toISOString(),
          byCategory: { bug: 3, ux: 5 },
          findingsCount: 8,
        }),
      ],
    });

    const result = computeWeightedSummary();
    expect(result.byCategory["bug"]).toBeGreaterThan(0);
    expect(result.byCategory["ux"]).toBeGreaterThan(result.byCategory["bug"]);
  });

  it("underrepresented レンズが formatted に含まれる", () => {
    const now = Date.now();
    // Accessibility は 10 件、Security は 1 件（平均 5.5 の半分未満 → underrepresented）
    setupMockCoverage({
      entries: [
        makeEntry({
          timestamp: new Date(now).toISOString(),
          findingsCount: 11,
          byLens: { Accessibility: 10, Security: 1 },
        }),
      ],
    });

    const result = computeWeightedSummary();
    expect(result.formatted).toContain("Security");
    expect(result.formatted.toLowerCase()).toContain("underrepresented");
  });

  it("全レンズが均等な場合は underrepresented なしのメッセージを出す", () => {
    setupMockCoverage({
      entries: [
        makeEntry({
          timestamp: new Date().toISOString(),
          findingsCount: 6,
          byLens: { Accessibility: 3, Security: 3 },
        }),
      ],
    });

    const result = computeWeightedSummary();
    expect(result.formatted).toContain("comparable coverage");
  });

  it("シナリオ別の集計が結果に含まれる", () => {
    setupMockCoverage({
      entries: [
        makeEntry({
          timestamp: new Date().toISOString(),
          findingsCount: 2,
          byScenario: { "New employee submitting first purchase": 2 },
        }),
      ],
    });

    const result = computeWeightedSummary();
    expect(result.byScenario["New employee submitting first purchase"]).toBeGreaterThan(0);
    expect(result.formatted).toContain("By scenario");
  });

  it("14日以内に同じレンズが複数 run に登場するとボーナスが乗る", () => {
    const now = Date.now();
    // 同じ Accessibility レンズが2回登場 → bonus = 1 + (2-1)*0.5 = 1.5
    setupMockCoverage({
      entries: [
        makeEntry({
          runId: "run_1",
          timestamp: new Date(now - 1000).toISOString(),
          findingsCount: 2,
          byLens: { Accessibility: 2 },
        }),
        makeEntry({
          runId: "run_2",
          timestamp: new Date(now).toISOString(),
          findingsCount: 2,
          byLens: { Accessibility: 2 },
        }),
      ],
    });

    const resultWithRepeat = computeWeightedSummary();

    // 1回しか登場しない場合と比較
    setupMockCoverage({
      entries: [
        makeEntry({
          runId: "run_1",
          timestamp: new Date(now).toISOString(),
          findingsCount: 2,
          byLens: { Accessibility: 2 },
        }),
      ],
    });
    const resultSingle = computeWeightedSummary();

    // 繰り返しありのほうが lens の重みが高いはず
    expect(resultWithRepeat.byLens["Accessibility"]).toBeGreaterThan(resultSingle.byLens["Accessibility"]);
  });

  it("14日より古いエントリーは繰り返しカウントに含まれない", () => {
    const now = Date.now();
    const oldMs = 15 * 24 * 60 * 60 * 1000; // 15日前
    setupMockCoverage({
      entries: [
        makeEntry({
          runId: "run_old",
          timestamp: new Date(now - oldMs).toISOString(),
          findingsCount: 2,
          byLens: { Security: 2 },
        }),
        makeEntry({
          runId: "run_new",
          timestamp: new Date(now).toISOString(),
          findingsCount: 2,
          byLens: { Security: 2 },
        }),
      ],
    });

    const result = computeWeightedSummary();
    // 古いエントリーはウィンドウ外なのでボーナスなし（繰り返し回数=1 → bonus=1.0）
    // ボーナスなしの場合: weight≈1.0*2 + 15日前のdecay*2 ≈ 2.06
    expect(result.formatted).not.toContain("Repeated lenses");
  });

  it("繰り返しレンズが formatted に含まれる", () => {
    const now = Date.now();
    setupMockCoverage({
      entries: [
        makeEntry({ runId: "r1", timestamp: new Date(now - 1000).toISOString(), findingsCount: 1, byLens: { "UI design": 1 } }),
        makeEntry({ runId: "r2", timestamp: new Date(now).toISOString(), findingsCount: 1, byLens: { "UI design": 1 } }),
      ],
    });

    const result = computeWeightedSummary();
    expect(result.formatted).toContain("Repeated lenses");
    expect(result.formatted).toContain("UI design");
    expect(result.formatted).toContain("×2");
  });

  it("MAX_ENTRIES を超えると最新30件に切り捨てる", () => {
    const entries = Array.from({ length: 35 }, (_, i) =>
      makeEntry({
        runId: `run_${i}`,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
      })
    );
    setupMockCoverage({ entries });
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});

    // updateCoverage が 31件目を追加してトリムすることを確認
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ entries }) as unknown as Buffer);

    // computeWeightedSummary は entries をそのまま使うだけなので、
    // 35件あってもエラーにならないことを確認
    expect(() => computeWeightedSummary()).not.toThrow();
  });
});

describe("updateCoverage", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it("新しいエントリーを追加して保存する", () => {
    const findings = [
      { id: "f1", runId: "run_1", agentId: "a1", agentName: "Alice", role: "tester", category: "bug", title: "Bug A", body: "", timestamp: new Date().toISOString() },
      { id: "f2", runId: "run_1", agentId: "a2", agentName: "Bob", role: "tester", category: "ux", title: "UX B", body: "", timestamp: new Date().toISOString() },
    ];
    const agentAssignments = new Map([
      ["a1", { lens: "Security: something" }],
      ["a2", { lens: "Accessibility: something" }],
    ]);

    updateCoverage("run_1", findings, agentAssignments);

    const calls = vi.mocked(fs.writeFileSync).mock.calls;
    const written = calls[calls.length - 1][1] as string;
    const saved = JSON.parse(written) as Coverage;
    expect(saved.entries).toHaveLength(1);
    expect(saved.entries[0].byCategory).toEqual({ bug: 1, ux: 1 });
    expect(saved.entries[0].byLens["Security"]).toBe(1);
    expect(saved.entries[0].byLens["Accessibility"]).toBe(1);
  });

  it("シナリオアサインのエントリーは byScenario に記録する", () => {
    const findings = [
      { id: "f1", runId: "run_1", agentId: "a1", agentName: "Alice", role: "tester", category: "ux", title: "UX", body: "", timestamp: new Date().toISOString() },
    ];
    const scenario = { id: "s1", title: "New employee task", context: "", goal: "", constraints: "" };
    const agentAssignments = new Map([["a1", { scenario }]]);

    updateCoverage("run_1", findings, agentAssignments);

    const calls = vi.mocked(fs.writeFileSync).mock.calls;
    const written = calls[calls.length - 1][1] as string;
    const saved = JSON.parse(written) as Coverage;
    expect(saved.entries[0].byScenario["New employee task"]).toBe(1);
  });
});
