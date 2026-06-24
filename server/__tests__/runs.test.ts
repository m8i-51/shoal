import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");

import * as fs from "fs";
import { listRuns, getReportPath } from "../runs";
import type { RunLog, Finding } from "../../framework/types";

function mockRunLog(overrides: Partial<RunLog> = {}): RunLog {
  return {
    runId: "run_1",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:05:00.000Z",
    repo: "test",
    agents: [],
    summary: {
      totalAgents: 0,
      completed: 0,
      errors: 0,
      iterationLimitReached: 0,
      totalActions: 0,
      totalIssuesPosted: 0,
      regressionChecked: 0,
      regressionFailed: 0,
      rateLimitRetries: 0,
      cost: { inputTokens: 0, outputTokens: 0, estimatedUSD: null },
    },
    ...overrides,
  };
}

function mockFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    runId: "run_1",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "title",
    body: "body",
    category: "bug",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
  vi.mocked(fs.readFileSync).mockReturnValue("{}" as unknown as ReturnType<typeof fs.readFileSync>);
});

describe("listRuns", () => {
  it("logs ディレクトリがない → 空配列", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(listRuns()).toEqual([]);
  });

  it("running_*.json から実行中の run を isLive:true で返す", () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("logs"));
    vi.mocked(fs.readdirSync).mockReturnValue(["running_run_live.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ runId: "run_live", startedAt: "2026-06-01T00:00:00.000Z" }) as unknown as ReturnType<typeof fs.readFileSync>
    );
    const result = listRuns();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ runId: "run_live", status: "running", isLive: true });
  });

  it("report_ プレフィックスのファイルは run ログとして扱わない", () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("logs"));
    vi.mocked(fs.readdirSync).mockReturnValue(["report_run_1.html"] as unknown as ReturnType<typeof fs.readdirSync>);
    expect(listRuns()).toEqual([]);
  });

  it("通常の run ログを完了状態のサマリーに変換する", () => {
    const log = mockRunLog({
      runId: "run_done",
      agents: [
        { agentType: "explorer", agentId: "a1", agentName: "A", role: "r", startedAt: "", completedAt: null, status: "completed", iterations: 1, actions: [], visitedPaths: [], issuesPosted: [], regressionChecks: [], error: null },
        { agentType: "explorer", agentId: "a2", agentName: "B", role: "r", startedAt: "", completedAt: null, status: "error", iterations: 1, actions: [], visitedPaths: [], issuesPosted: [], regressionChecks: [], error: "x" },
      ],
    });
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("logs"));
    vi.mocked(fs.readdirSync).mockReturnValue(["2026-01-01T00-00-00_run_done.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(log) as unknown as ReturnType<typeof fs.readFileSync>);

    const result = listRuns();
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      runId: "run_done",
      status: "completed",
      agentCount: 2,
      completedAgents: 1,
      errorAgents: 1,
      hasReport: false,
    });
  });

  it("findings/run_id/ 内の finding を category 別に集計する（triage_result.json は除外）", () => {
    const log = mockRunLog({ runId: "run_with_findings" });
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith("logs") || s.endsWith("findings/run_with_findings") || s.includes("findings") && s.endsWith("run_with_findings");
    });
    vi.mocked(fs.readdirSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith("logs")) return ["2026-01-01T00-00-00_run_with_findings.json"] as unknown as ReturnType<typeof fs.readdirSync>;
      return ["f0.json", "f1.json", "triage_result.json"] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.endsWith("f0.json")) return JSON.stringify(mockFinding({ id: "f0", category: "bug" })) as unknown as ReturnType<typeof fs.readFileSync>;
      if (s.endsWith("f1.json")) return JSON.stringify(mockFinding({ id: "f1", category: "ux" })) as unknown as ReturnType<typeof fs.readFileSync>;
      if (s.endsWith("triage_result.json")) {
        return JSON.stringify({ runId: "run_with_findings", completedAt: "x", issued: [], skipped: [], unprocessed: [] }) as unknown as ReturnType<typeof fs.readFileSync>;
      }
      return JSON.stringify(log) as unknown as ReturnType<typeof fs.readFileSync>;
    });

    const result = listRuns();
    expect(result).toHaveLength(1);
    expect(result[0].findingCount).toBe(2);
    expect(result[0].findingsByCategory).toEqual({ bug: 1, ux: 1 });
  });

  it("同じ runId が複数ファイルに登場しても重複しない", () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("logs"));
    vi.mocked(fs.readdirSync).mockReturnValue([
      "running_run_dup.json",
      "2026-01-01T00-00-00_run_dup.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("running_run_dup")) {
        return JSON.stringify({ runId: "run_dup", startedAt: "2026-01-01T00:00:00.000Z" }) as unknown as ReturnType<typeof fs.readFileSync>;
      }
      return JSON.stringify(mockRunLog({ runId: "run_dup" })) as unknown as ReturnType<typeof fs.readFileSync>;
    });

    const result = listRuns();
    expect(result).toHaveLength(1);
    expect(result[0].isLive).toBe(true);
  });

  it("startedAt の降順でソートされる", () => {
    const older = mockRunLog({ runId: "run_old", startedAt: "2026-01-01T00:00:00.000Z" });
    const newer = mockRunLog({ runId: "run_new", startedAt: "2026-06-01T00:00:00.000Z" });
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("logs"));
    vi.mocked(fs.readdirSync).mockReturnValue([
      "2026-01-01T00-00-00_run_old.json",
      "2026-06-01T00-00-00_run_new.json",
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("run_old")) return JSON.stringify(older) as unknown as ReturnType<typeof fs.readFileSync>;
      return JSON.stringify(newer) as unknown as ReturnType<typeof fs.readFileSync>;
    });

    const result = listRuns();
    expect(result.map((r) => r.runId)).toEqual(["run_new", "run_old"]);
  });

  it("壊れた JSON の run ログはスキップする", () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("logs"));
    vi.mocked(fs.readdirSync).mockReturnValue(["2026-01-01T00-00-00_run_broken.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    expect(listRuns()).toEqual([]);
  });
});

describe("getReportPath", () => {
  it("不正な runId → null", () => {
    expect(getReportPath("bad-id")).toBeNull();
  });

  it("report ファイルが存在しない → null", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(getReportPath("run_123")).toBeNull();
  });

  it("report ファイルが存在する → パスを返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(getReportPath("run_123")).toMatch(/report_run_123\.html$/);
  });
});
