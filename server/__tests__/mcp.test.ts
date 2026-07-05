import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- モック ----
vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return { ...actual, join: (...args: string[]) => args.join("/"), resolve: (...args: string[]) => args.join("/"), dirname: (p: string) => p };
});
vi.mock("../runner.js", () => ({ activeSessions: new Map(), spawnRun: vi.fn(() => "run_123") }));
vi.mock("../runs.js", () => ({ listRuns: vi.fn(() => []) }));
vi.mock("../../framework/experience-score.js", () => ({ computeExperienceScore: vi.fn(() => null) }));

import * as fs from "fs";
import { spawnRun, activeSessions, type Session } from "../runner.js";
import { listRuns, type RunSummary } from "../runs.js";
import { computeExperienceScore } from "../../framework/experience-score.js";

// NODE_ENV=test なので stdio transport には接続しない
const { handleStartRun, handleGetRunStatus, handleListFindings, handleGetExperienceScore, handleVerifyFix, buildMcpServer } = await import("../mcp.js");

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: "run_123",
    startedAt: new Date().toISOString(),
    completedAt: null,
    done: false,
    exitCode: null,
    lines: ["line1", "line2"],
    listeners: [],
    doneListeners: [],
    child: null,
    ...overrides,
  };
}

function makeRunSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run_123",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "completed",
    agentCount: 3,
    completedAgents: 3,
    errorAgents: 0,
    findingCount: 5,
    findingsByCategory: { bug: 3, ux: 2 },
    hasReport: true,
    estimatedCostUSD: null,
    regressionChecked: 2,
    regressionFailed: 1,
    ...overrides,
  };
}

beforeEach(() => {
  activeSessions.clear();
  vi.mocked(listRuns).mockReturnValue([]);
  vi.mocked(fs.existsSync).mockReturnValue(false);
});

describe("handleStartRun", () => {
  it("spawnRun を呼んで runId を返す", () => {
    const result = handleStartRun({ baseUrl: "http://localhost:3000", mode: "safe" });
    expect(result.runId).toBe("run_123");
    expect(spawnRun).toHaveBeenCalledWith({ baseUrl: "http://localhost:3000", mode: "safe" });
  });

  it("不正な mode は例外を投げる", () => {
    expect(() => handleStartRun({ mode: "yolo" })).toThrow(/mode must be/);
  });
});

describe("handleGetRunStatus", () => {
  it("セッションも履歴もなければ not_found", () => {
    expect(handleGetRunStatus("run_999").status).toBe("not_found");
  });

  it("実行中セッションは running とログ末尾を返す", () => {
    activeSessions.set("run_123", makeSession({ done: false, lines: Array.from({ length: 20 }, (_, i) => `l${i}`) }));
    const result = handleGetRunStatus("run_123");
    expect(result.status).toBe("running");
    expect(result.lastLogLines).toHaveLength(15);
    expect(result.lastLogLines[14]).toBe("l19");
  });

  it("完了 run は summary の findings / regression を返す", () => {
    vi.mocked(listRuns).mockReturnValue([makeRunSummary()]);
    const result = handleGetRunStatus("run_123");
    expect(result.status).toBe("completed");
    expect(result.findingsCount).toBe(5);
    expect(result.regressionChecked).toBe(2);
    expect(result.regressionFailed).toBe(1);
  });
});

describe("handleListFindings", () => {
  function mockFinding(overrides = {}) {
    return {
      id: "f1",
      runId: "run_1",
      agentId: "a1",
      agentName: "Alice",
      role: "tester",
      title: "Login broken",
      body: "The login button does nothing",
      category: "bug",
      timestamp: "2026-07-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function setupFindings(runDirs: Record<string, object[]>) {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const s = String(p);
      return s.endsWith("findings") || Object.keys(runDirs).some((r) => s.endsWith(r));
    });
    vi.mocked(fs.readdirSync).mockImplementation(((p: unknown) => {
      const s = String(p);
      if (s.endsWith("findings")) return Object.keys(runDirs);
      const run = Object.keys(runDirs).find((r) => s.endsWith(r));
      return run ? runDirs[run].map((_, i) => `f${i}.json`) : [];
    }) as unknown as typeof fs.readdirSync);
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
      const s = String(p);
      const run = Object.keys(runDirs).find((r) => s.includes(r));
      const idx = parseInt(s.match(/f(\d+)\.json$/)?.[1] ?? "0", 10);
      return JSON.stringify(runDirs[run!][idx]);
    }) as unknown as typeof fs.readFileSync);
  }

  it("findings ディレクトリがなければ空配列", () => {
    expect(handleListFindings()).toEqual([]);
  });

  it("全 run の findings を新しい順に返す", () => {
    setupFindings({
      run_1: [mockFinding({ id: "old", timestamp: "2026-07-01T00:00:00.000Z" })],
      run_2: [mockFinding({ id: "new", runId: "run_2", timestamp: "2026-07-02T00:00:00.000Z" })],
    });
    const result = handleListFindings();
    expect(result.map((f) => f.id)).toEqual(["new", "old"]);
  });

  it("category / search / runId / limit でフィルタする", () => {
    setupFindings({
      run_1: [
        mockFinding({ id: "b1", category: "bug", title: "Checkout crash" }),
        mockFinding({ id: "u1", category: "ux", title: "Confusing form" }),
      ],
    });
    expect(handleListFindings({ category: "ux" }).map((f) => f.id)).toEqual(["u1"]);
    expect(handleListFindings({ search: "checkout" }).map((f) => f.id)).toEqual(["b1"]);
    expect(handleListFindings({ runId: "run_1", limit: 1 })).toHaveLength(1);
    expect(handleListFindings({ runId: "run_999" })).toEqual([]);
  });

  it("runId のバリデーション — 不正な形式はディレクトリを読まない", () => {
    setupFindings({ run_1: [mockFinding()] });
    expect(handleListFindings({ runId: "../etc" })).toEqual([]);
  });
});

describe("handleGetExperienceScore", () => {
  it("スコアがなければメッセージを返す", () => {
    vi.mocked(computeExperienceScore).mockReturnValue(null);
    expect(handleGetExperienceScore()).toEqual({ message: expect.stringContaining("No experience data") });
  });

  it("スコアがあればそのまま返す", () => {
    const runExp = { runId: "run_1", timestamp: "t", score: 70, achievementRate: 0.7, avgIterations: null, regressionRate: null };
    vi.mocked(computeExperienceScore).mockReturnValue({ latest: runExp, delta: null, trend: [runExp] });
    expect(handleGetExperienceScore()).toMatchObject({ latest: { score: 70 } });
  });
});

describe("handleVerifyFix", () => {
  function mockFinding(overrides = {}) {
    return {
      id: "f1",
      runId: "run_1",
      agentId: "a1",
      agentName: "Alice",
      role: "tester",
      title: "Login broken",
      body: "The login button does nothing",
      category: "bug",
      timestamp: "2026-07-01T00:00:00.000Z",
      ...overrides,
    };
  }

  function setupVerifyFs(finding: object, verifyResult: object | null) {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
      const s = String(p);
      if (s.includes("verify_")) return verifyResult !== null;
      return s.endsWith("findings") || s.endsWith("run_1");
    });
    vi.mocked(fs.readdirSync).mockImplementation(((p: unknown) => {
      const s = String(p);
      if (s.endsWith("findings")) return ["run_1"];
      return ["f0.json"];
    }) as unknown as typeof fs.readdirSync);
    vi.mocked(fs.readFileSync).mockImplementation(((p: unknown) => {
      const s = String(p);
      if (s.includes("verify_")) return JSON.stringify(verifyResult);
      return JSON.stringify(finding);
    }) as unknown as typeof fs.readFileSync);
  }

  it("finding を検証 run に渡し、結果 JSON を返す", async () => {
    const verifyResult = { findingId: "f1", findingTitle: "Login broken", runId: "run_x", status: "fixed", reason: "Could not reproduce", verifiedAt: "t" };
    setupVerifyFs(mockFinding(), verifyResult);
    const runVerify = vi.fn().mockResolvedValue(0);

    const result = await handleVerifyFix({ findingId: "f1", baseUrl: "http://localhost:9999" }, runVerify);

    expect(runVerify).toHaveBeenCalledWith(expect.stringMatching(/^run_\d+$/), expect.objectContaining({ id: "f1" }), "http://localhost:9999");
    expect(result.status).toBe("fixed");
  });

  it("存在しない findingId はエラー", async () => {
    setupVerifyFs(mockFinding({ id: "other" }), null);
    await expect(handleVerifyFix({ findingId: "nope" }, vi.fn())).rejects.toThrow(/not found/);
  });

  it("検証 run が結果を出さなかったらエラー", async () => {
    setupVerifyFs(mockFinding(), null);
    await expect(handleVerifyFix({ findingId: "f1" }, vi.fn().mockResolvedValue(1))).rejects.toThrow(/no result/);
  });
});

describe("buildMcpServer", () => {
  it("5 つのツールを登録したサーバーを構築できる", () => {
    const server = buildMcpServer();
    expect(server).toBeDefined();
  });
});
