import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---- モック ----
vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return { ...actual, join: (...args: string[]) => args.join("/"), resolve: (...args: string[]) => args.join("/"), dirname: (p: string) => p };
});
vi.mock("../runner.js", () => ({ activeSessions: new Map(), spawnRun: vi.fn(), cancelSession: vi.fn(), hasActiveRun: vi.fn(() => false) }));
vi.mock("../runs.js", () => ({ listRuns: vi.fn(() => []), getReportPath: vi.fn(() => null) }));
vi.mock("../triage-view.js", () => ({ buildTriageView: vi.fn(() => null) }));
vi.mock("../adoption-view.js", () => ({ buildAdoptionView: vi.fn(() => null) }));
vi.mock("../scheduler.js", () => ({ loadSchedule: vi.fn(() => ({ enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null, pendingDate: null })), saveSchedule: vi.fn(), startScheduler: vi.fn() }));
vi.mock("../../framework/diary.js", () => ({ generateDiary: vi.fn(), getDiaryPath: vi.fn(() => null) }));
vi.mock("../../framework/experience-score.js", () => ({ computeExperienceScore: vi.fn(() => null) }));
vi.mock("../../framework/site-map.js", () => ({
  loadSiteMap: vi.fn(() => ({ origin: "http://localhost:3000", updatedAt: "", entries: {} })),
  buildSiteMapDashboardView: vi.fn(() => ({
    origin: "http://localhost:3000",
    updatedAt: "",
    stats: { known: 0, unvisited: 0, reached: 0, explored: 0, exploredRate: 0, reachedRate: 0 },
    unvisited: [],
    thin: [],
    entries: [],
  })),
}));
vi.mock("../../framework/persona-from-seed.js", () => ({
  generatePersonaFromSeed: vi.fn(),
  PersonaGenerationError: class PersonaGenerationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "PersonaGenerationError";
    }
  },
}));
vi.mock("../../framework/agent-store.js", () => ({
  addAgent: vi.fn(),
  archiveAgent: vi.fn(),
  restoreAgent: vi.fn(),
  updateAgent: vi.fn(),
  listFixedPersonas: vi.fn(() => []),
  loadAgents: vi.fn(() => []),
  isFixedAgent: vi.fn((a: { origin?: string }) => a.origin === "fixed"),
}));
vi.mock("express-rate-limit", () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

import * as fs from "fs";
import { generateDiary, getDiaryPath } from "../../framework/diary.js";
import { computeExperienceScore } from "../../framework/experience-score.js";
import { loadSiteMap, buildSiteMapDashboardView } from "../../framework/site-map.js";
import { generatePersonaFromSeed, PersonaGenerationError } from "../../framework/persona-from-seed.js";
import {
  addAgent,
  archiveAgent,
  restoreAgent,
  updateAgent,
  listFixedPersonas,
  loadAgents,
} from "../../framework/agent-store.js";
import { activeSessions, spawnRun, cancelSession, hasActiveRun } from "../runner.js";
import { listRuns, getReportPath } from "../runs.js";
import { buildTriageView } from "../triage-view.js";
import { buildAdoptionView } from "../adoption-view.js";
import { loadSchedule } from "../scheduler.js";

// NODE_ENV=test なので app.listen は呼ばれない
const { app } = await import("../index.js");

// ----------------------------------------------------------------
// テスト用ヘルパー
// ----------------------------------------------------------------

function mockFinding(overrides = {}) {
  return {
    id: "f1",
    runId: "run_1",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Test finding",
    body: "Something broke",
    category: "bug",
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function setupFindingsDir(runDirs: Record<string, object[]>) {
  vi.mocked(fs.existsSync).mockImplementation((p: unknown) => {
    const path = String(p);
    return path.includes("findings") || Object.keys(runDirs).some((r) => path.includes(r));
  });
  vi.mocked(fs.readdirSync).mockImplementation((p: unknown) => {
    const path = String(p);
    const runId = Object.keys(runDirs).find((r) => path.endsWith(r));
    if (runId) {
      return runDirs[runId].map((_, i) => `f${i}.json`) as unknown as ReturnType<typeof fs.readdirSync>;
    }
    // findings ベースディレクトリ
    return Object.keys(runDirs) as unknown as ReturnType<typeof fs.readdirSync>;
  });
  vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
    const path = String(p);
    for (const [runId, items] of Object.entries(runDirs)) {
      const idx = items.findIndex((_, i) => path.endsWith(`f${i}.json`));
      if (idx >= 0 && path.includes(runId)) {
        return JSON.stringify(items[idx]) as unknown as ReturnType<typeof fs.readFileSync>;
      }
    }
    return "{}" as unknown as ReturnType<typeof fs.readFileSync>;
  });
}

beforeEach(() => {
  process.env.BASE_URL = "http://localhost:3000";
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
  vi.mocked(fs.readFileSync).mockReturnValue("{}" as unknown as ReturnType<typeof fs.readFileSync>);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(getDiaryPath).mockReturnValue(null);
  vi.mocked(generateDiary).mockResolvedValue("# 探索日誌");
  vi.mocked(buildTriageView).mockReset().mockReturnValue(null);
  vi.mocked(buildAdoptionView).mockReset().mockReturnValue(null);
  (activeSessions as Map<string, unknown>).clear();
});

// ================================================================
// GET /api/runs/:runId/diary
// ================================================================
describe("GET /api/experience", () => {
  it("スコアデータがない → 404", async () => {
    vi.mocked(computeExperienceScore).mockReturnValue(null);
    const res = await request(app).get("/api/experience");
    expect(res.status).toBe(404);
  });

  it("スコアがある → 200 + trend", async () => {
    const runExp = { runId: "run_1", timestamp: new Date().toISOString(), score: 80, achievementRate: 0.8, avgIterations: 5, regressionRate: null };
    vi.mocked(computeExperienceScore).mockReturnValue({ latest: runExp, delta: 10, trend: [runExp] });
    const res = await request(app).get("/api/experience");
    expect(res.status).toBe(200);
    expect(res.body.latest.score).toBe(80);
    expect(res.body.delta).toBe(10);
    expect(res.body.trend).toHaveLength(1);
  });

  it("計算が例外を投げる → 500", async () => {
    vi.mocked(computeExperienceScore).mockImplementation(() => { throw new Error("boom"); });
    const res = await request(app).get("/api/experience");
    expect(res.status).toBe(500);
  });
});

// ================================================================
// GET /api/site-map
// ================================================================
describe("GET /api/site-map", () => {
  it("地図データがない → 404", async () => {
    vi.mocked(buildSiteMapDashboardView).mockReturnValue({
      origin: "http://localhost:3000",
      updatedAt: "",
      stats: { known: 0, unvisited: 0, reached: 0, explored: 0, exploredRate: 0, reachedRate: 0 },
      unvisited: [],
      thin: [],
      entries: [],
    });
    const res = await request(app).get("/api/site-map");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no site map data yet");
  });

  it("地図データがある → 200 + view", async () => {
    const view = {
      origin: "http://localhost:3000",
      updatedAt: "2026-08-28T00:00:00.000Z",
      stats: { known: 2, unvisited: 1, reached: 0, explored: 1, exploredRate: 0.5, reachedRate: 0.5 },
      unvisited: ["/settings"],
      thin: [],
      entries: [
        { path: "/", status: "explored" as const, visitCount: 2, source: "sitemap" as const, lastVisitedAt: null, lastRunId: "run_1" },
        { path: "/settings", status: "unvisited" as const, visitCount: 0, source: "sitemap" as const, lastVisitedAt: null, lastRunId: null },
      ],
    };
    vi.mocked(buildSiteMapDashboardView).mockReturnValue(view);
    const res = await request(app).get("/api/site-map");
    expect(res.status).toBe(200);
    expect(res.body.stats.known).toBe(2);
    expect(res.body.unvisited).toEqual(["/settings"]);
    expect(loadSiteMap).toHaveBeenCalledWith("http://localhost:3000");
  });

  it("読み取りが例外を投げる → 500", async () => {
    vi.mocked(loadSiteMap).mockImplementation(() => { throw new Error("boom"); });
    const res = await request(app).get("/api/site-map");
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("failed to read site map");
  });
});

// ================================================================
describe("GET /api/runs/:runId/diary", () => {
  it("不正な runId → 400", async () => {
    const res = await request(app).get("/api/runs/run_abc/diary");
    expect(res.status).toBe(400);
  });

  it("diary ファイルが存在しない → 404", async () => {
    vi.mocked(getDiaryPath).mockReturnValue(null);
    const res = await request(app).get("/api/runs/run_123/diary");
    expect(res.status).toBe(404);
  });

  it("diary ファイルが存在する → 200 + content", async () => {
    vi.mocked(getDiaryPath).mockReturnValue("/some/path/diary_run_123.md");
    vi.mocked(fs.readFileSync).mockReturnValue("# 日誌" as unknown as ReturnType<typeof fs.readFileSync>);
    const res = await request(app).get("/api/runs/run_123/diary");
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("# 日誌");
  });
});

// ================================================================
// POST /api/runs/:runId/diary
// ================================================================
describe("POST /api/runs/:runId/diary", () => {
  it("不正な runId → 400", async () => {
    const res = await request(app).post("/api/runs/invalid/diary");
    expect(res.status).toBe(400);
  });

  it("アクティブセッションがない + ログファイルなし → 404", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).post("/api/runs/run_123/diary");
    expect(res.status).toBe(404);
  });

  it("ログファイルがある → generateDiary を呼んで content を返す", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("line1\nline2\n" as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(generateDiary).mockResolvedValue("# 探索日誌");
    const res = await request(app).post("/api/runs/run_123/diary");
    expect(res.status).toBe(200);
    expect(res.body.content).toBe("# 探索日誌");
    expect(generateDiary).toHaveBeenCalledWith("run_123", ["line1", "line2"]);
  });

  it("アクティブセッションがある → session.lines を使う", async () => {
    (activeSessions as Map<string, unknown>).set("run_123", { lines: ["live line"], done: false });
    vi.mocked(generateDiary).mockResolvedValue("# ライブ日誌");
    const res = await request(app).post("/api/runs/run_123/diary");
    expect(res.status).toBe(200);
    expect(generateDiary).toHaveBeenCalledWith("run_123", ["live line"]);
  });

  it("generateDiary が失敗 → 500", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("line\n" as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(generateDiary).mockRejectedValue(new Error("LLM error"));
    const res = await request(app).post("/api/runs/run_123/diary");
    expect(res.status).toBe(500);
  });
});

// ================================================================
// GET /api/findings
// ================================================================
describe("GET /api/findings", () => {
  it("findings ディレクトリがない → 空配列", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).get("/api/findings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("findings を timestamp 降順で返す", async () => {
    const older = mockFinding({ id: "f1", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" });
    const newer = mockFinding({ id: "f2", runId: "run_2", timestamp: "2026-06-01T00:00:00.000Z" });
    setupFindingsDir({ run_1: [older], run_2: [newer] });
    const res = await request(app).get("/api/findings");
    expect(res.status).toBe(200);
    expect(res.body[0].timestamp).toBe("2026-06-01T00:00:00.000Z");
    expect(res.body[1].timestamp).toBe("2026-01-01T00:00:00.000Z");
  });

  it("run_\\d+ 以外のディレクトリは無視する", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue([".DS_Store", "tmp"] as unknown as ReturnType<typeof fs.readdirSync>);
    const res = await request(app).get("/api/findings");
    expect(res.body).toEqual([]);
  });

  it("triage_result.json（timestamp を持たない集計ファイル）は無視する", async () => {
    const finding = mockFinding({ id: "f1", runId: "run_1", timestamp: "2026-01-01T00:00:00.000Z" });
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("run_1")) return ["f0.json", "triage_result.json"] as unknown as ReturnType<typeof fs.readdirSync>;
      return ["run_1"] as unknown as ReturnType<typeof fs.readdirSync>;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      const path = String(p);
      if (path.endsWith("f0.json")) return JSON.stringify(finding) as unknown as ReturnType<typeof fs.readFileSync>;
      if (path.endsWith("triage_result.json")) {
        return JSON.stringify({ runId: "run_1", completedAt: "x", issued: [], skipped: [], unprocessed: [] }) as unknown as ReturnType<typeof fs.readFileSync>;
      }
      return "{}" as unknown as ReturnType<typeof fs.readFileSync>;
    });
    const res = await request(app).get("/api/findings");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe("f1");
  });
});

// ================================================================
// GET /api/findings/cross-run-duplicates
// ================================================================
describe("GET /api/findings/cross-run-duplicates", () => {
  it("findings がない → 空配列", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).get("/api/findings/cross-run-duplicates");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("run をまたいで似た finding をクラスタとして返す", async () => {
    const a = mockFinding({
      id: "f0", runId: "run_1",
      title: "Dashboard metric not accessible via API",
      body: "no API endpoint for the metric card",
    });
    const b = mockFinding({
      id: "f0", runId: "run_2",
      title: "Dashboard metrics not accessible via API",
      body: "no API endpoint for the metric card",
    });
    setupFindingsDir({ run_1: [a], run_2: [b] });
    const res = await request(app).get("/api/findings/cross-run-duplicates");
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toHaveLength(2);
  });

  it("似ていない finding しかない → 空配列", async () => {
    const a = mockFinding({ id: "f0", runId: "run_1", title: "Login button broken", body: "click does nothing" });
    const b = mockFinding({ id: "f0", runId: "run_2", title: "Dark mode missing", body: "no theme switch" });
    setupFindingsDir({ run_1: [a], run_2: [b] });
    const res = await request(app).get("/api/findings/cross-run-duplicates");
    expect(res.body).toEqual([]);
  });
});

// ================================================================
// GET /api/findings/export
// ================================================================
describe("GET /api/findings/export", () => {
  it("正しい Content-Disposition ヘッダーを返す", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).get("/api/findings/export");
    expect(res.status).toBe(200);
    expect(res.headers["content-disposition"]).toContain("attachment");
    expect(res.headers["content-disposition"]).toContain(".json");
  });

  it("レスポンスに version / exportedAt / source / findings が含まれる", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).get("/api/findings/export");
    expect(res.body.version).toBe("1");
    expect(res.body.source).toBe("shoal");
    expect(typeof res.body.exportedAt).toBe("string");
    expect(Array.isArray(res.body.findings)).toBe(true);
  });

  it("findings の screenshotPath は除外される", async () => {
    const f = mockFinding({ screenshotPath: "/secret/path.png" });
    setupFindingsDir({ run_1: [f] });
    const res = await request(app).get("/api/findings/export");
    expect(res.body.findings[0]).not.toHaveProperty("screenshotPath");
  });
});

// ================================================================
// POST /api/findings/proxy-url — SSRF 防御テスト
// ================================================================
describe("POST /api/findings/proxy-url", () => {
  it("url パラメータなし → 400", async () => {
    const res = await request(app).post("/api/findings/proxy-url").send({});
    expect(res.status).toBe(400);
  });

  it("http / https 以外のプロトコル → 400", async () => {
    const cases = ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com"];
    for (const url of cases) {
      const res = await request(app).post("/api/findings/proxy-url").send({ url });
      expect(res.status).toBe(400);
    }
  });

  it("localhost → 400（SSRF 防御）", async () => {
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "http://localhost/data.json" });
    expect(res.status).toBe(400);
  });

  it("127.0.0.1 → 400（SSRF 防御）", async () => {
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "http://127.0.0.1/data.json" });
    expect(res.status).toBe(400);
  });

  it("::1（IPv6 localhost）→ 400（SSRF 防御）", async () => {
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "http://[::1]/data.json" });
    expect(res.status).toBe(400);
  });

  it("192.168.x.x → 400（SSRF 防御）", async () => {
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "http://192.168.1.1/data.json" });
    expect(res.status).toBe(400);
  });

  it("10.x.x.x → 400（SSRF 防御）", async () => {
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "http://10.0.0.1/data.json" });
    expect(res.status).toBe(400);
  });

  it(".local ドメイン → 400（SSRF 防御）", async () => {
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "http://myserver.local/data.json" });
    expect(res.status).toBe(400);
  });

  it("許可ホスト以外の公開 URL → 400", async () => {
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "https://example.com/data.json" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("host not allowed");
  });

  it("正常な GitHub raw URL → upstream レスポンスを返す", async () => {
    const bundle = { version: "1", source: "shoal", findings: [] };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => bundle,
    });
    vi.stubGlobal("fetch", fetchMock);
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "https://raw.githubusercontent.com/example/data.json" });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe("1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://raw.githubusercontent.com/example/data.json",
      expect.objectContaining({ redirect: "error" }),
    );
    vi.unstubAllGlobals();
  });

  it("upstream が失敗 → 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }));
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "https://raw.githubusercontent.com/example/data.json" });
    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });

  it("fetch 例外（タイムアウト等）→ 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("AbortError")));
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "https://raw.githubusercontent.com/example/data.json" });
    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });
});

// ================================================================
// PATCH /api/schedule — 既存エンドポイントのバリデーション
// ================================================================
describe("PATCH /api/schedule", () => {
  it("範囲外の dayOfWeek（-1, 7）は無視してデフォルト値を維持する", async () => {
    const { loadSchedule } = await import("../scheduler.js");
    vi.mocked(loadSchedule).mockReturnValue({ enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null, pendingDate: null });
    const res = await request(app).patch("/api/schedule").send({ dayOfWeek: -1 });
    expect(res.status).toBe(200);
    expect(res.body.dayOfWeek).toBe(1); // デフォルト値を維持
  });

  it("範囲外の hour（24）は無視する", async () => {
    const { loadSchedule } = await import("../scheduler.js");
    vi.mocked(loadSchedule).mockReturnValue({ enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null, pendingDate: null });
    const res = await request(app).patch("/api/schedule").send({ hour: 24 });
    expect(res.status).toBe(200);
    expect(res.body.hour).toBe(9);
  });

  it("時刻を変えると pendingDate を捨てる", async () => {
    const { loadSchedule } = await import("../scheduler.js");
    vi.mocked(loadSchedule).mockReturnValue({
      enabled: true, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null, pendingDate: "2026-05-11",
    });
    const res = await request(app).patch("/api/schedule").send({ hour: 10 });
    expect(res.status).toBe(200);
    expect(res.body.hour).toBe(10);
    expect(res.body.pendingDate).toBeNull();
  });

  it("enabled だけ変えても pendingDate は残す", async () => {
    const { loadSchedule } = await import("../scheduler.js");
    vi.mocked(loadSchedule).mockReturnValue({
      enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null, pendingDate: "2026-05-11",
    });
    const res = await request(app).patch("/api/schedule").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.pendingDate).toBe("2026-05-11");
  });

  it("enabled に数値を渡すと Boolean 変換される", async () => {
    const { loadSchedule } = await import("../scheduler.js");
    vi.mocked(loadSchedule).mockReturnValue({ enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null, pendingDate: null });
    const res = await request(app).patch("/api/schedule").send({ enabled: 1 });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
});

// ================================================================
// GET /api/schedule
// ================================================================
describe("GET /api/schedule", () => {
  it("loadSchedule の結果を返す", async () => {
    vi.mocked(loadSchedule).mockReturnValue({ enabled: true, dayOfWeek: 3, hour: 10, minute: 30, lastRunDate: null, pendingDate: null });
    const res = await request(app).get("/api/schedule");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, dayOfWeek: 3, hour: 10, minute: 30, lastRunDate: null, pendingDate: null });
  });
});

// ================================================================
// GET /api/spec
// ================================================================
describe("GET /api/spec", () => {
  it("spec ファイルが存在しない → 404", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).get("/api/spec");
    expect(res.status).toBe(404);
  });

  it("spec ファイルが存在する → 200 + JSON", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ appGoals: ["goal1"] }) as unknown as ReturnType<typeof fs.readFileSync>);
    const res = await request(app).get("/api/spec");
    expect(res.status).toBe(200);
    expect(res.body.appGoals).toEqual(["goal1"]);
  });

  it("spec ファイルの JSON が壊れている → 500", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    const res = await request(app).get("/api/spec");
    expect(res.status).toBe(500);
  });
});

// ================================================================
// PATCH /api/spec/goals
// ================================================================
describe("PATCH /api/spec/goals", () => {
  it("spec ファイルが存在しない → 404", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).patch("/api/spec/goals").send({ goals: ["a"] });
    expect(res.status).toBe(404);
  });

  it("goals が配列でない → 400", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const res = await request(app).patch("/api/spec/goals").send({ goals: "not-an-array" });
    expect(res.status).toBe(400);
  });

  it("goals に文字列以外が含まれる → 400", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const res = await request(app).patch("/api/spec/goals").send({ goals: ["a", 1] });
    expect(res.status).toBe(400);
  });

  it("正常な goals → 200 + ok:true、ファイルに書き込む", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ appGoals: [] }) as unknown as ReturnType<typeof fs.readFileSync>);
    const res = await request(app).patch("/api/spec/goals").send({ goals: ["new goal"] });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("spec ファイルの読み込みに失敗 → 500", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    const res = await request(app).patch("/api/spec/goals").send({ goals: ["a"] });
    expect(res.status).toBe(500);
  });
});

// ================================================================
// PATCH /api/spec/edge
// ================================================================
describe("PATCH /api/spec/edge", () => {
  it("spec ファイルが存在しない → 404", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).patch("/api/spec/edge").send({ sharpEdges: ["a"], tradeoffs: [] });
    expect(res.status).toBe(404);
  });

  it("配列でない / 文字列以外を含む → 400", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect((await request(app).patch("/api/spec/edge").send({ sharpEdges: "a", tradeoffs: [] })).status).toBe(400);
    expect((await request(app).patch("/api/spec/edge").send({ sharpEdges: ["a"], tradeoffs: [1] })).status).toBe(400);
    expect((await request(app).patch("/api/spec/edge").send({ sharpEdges: ["a"] })).status).toBe(400);
  });

  it("正常な宣言 → source human で保存する", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ appName: "x" }) as unknown as ReturnType<typeof fs.readFileSync>);
    const res = await request(app).patch("/api/spec/edge").send({
      sharpEdges: ["Keyboard-first everywhere"],
      tradeoffs: ["No onboarding wizard"],
    });
    expect(res.status).toBe(200);
    expect(res.body.productEdge).toMatchObject({
      sharpEdges: ["Keyboard-first everywhere"],
      tradeoffs: ["No onboarding wizard"],
      source: "human",
    });
    const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1];
    expect(JSON.parse(written as string).productEdge.source).toBe("human");
  });

  it("両方空なら宣言を削除する", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify({ productEdge: { sharpEdges: ["old"], tradeoffs: [], source: "human" } }) as unknown as ReturnType<typeof fs.readFileSync>
    );
    const res = await request(app).patch("/api/spec/edge").send({ sharpEdges: [], tradeoffs: [] });
    expect(res.status).toBe(200);
    expect(res.body.productEdge).toBeNull();
    const written = vi.mocked(fs.writeFileSync).mock.calls.at(-1)?.[1];
    expect(JSON.parse(written as string).productEdge).toBeUndefined();
  });

  it("spec ファイルの読み込みに失敗 → 500", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    const res = await request(app).patch("/api/spec/edge").send({ sharpEdges: ["a"], tradeoffs: [] });
    expect(res.status).toBe(500);
  });
});

// ================================================================
// GET /api/runs
// ================================================================
describe("GET /api/runs", () => {
  it("listRuns の結果をそのまま返す（アクティブセッションなし）", async () => {
    vi.mocked(listRuns).mockReturnValue([{ runId: "run_1", isLive: false } as never]);
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ runId: "run_1", isLive: false }]);
  });

  it("アクティブセッションがある run は isLive で補完される", async () => {
    vi.mocked(listRuns).mockReturnValue([{ runId: "run_2", isLive: false } as never]);
    (activeSessions as Map<string, unknown>).set("run_2", { done: false });
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(200);
    expect(res.body[0].isLive).toBe(true);
  });
});

// ================================================================
// GET /api/runs/:runId/report
// ================================================================
describe("GET /api/runs/:runId/report", () => {
  it("不正な runId → 400", async () => {
    const res = await request(app).get("/api/runs/bad-id/report");
    expect(res.status).toBe(400);
  });

  it("report が見つからない → 404", async () => {
    vi.mocked(getReportPath).mockReturnValue(null);
    const res = await request(app).get("/api/runs/run_123/report");
    expect(res.status).toBe(404);
  });
});

// ================================================================
// POST /api/runs/start
// ================================================================
describe("POST /api/runs/start", () => {
  // spawnRun は他の describe ブロックの assertion に影響しないよう、この
  // ブロック内では毎回呼び出し履歴をクリアする（グローバル beforeEach は
  // reset していないため、蓄積した過去の呼び出しで
  // not.toHaveBeenCalled() 系の assertion が誤って失敗するのを防ぐ）。
  beforeEach(() => {
    vi.mocked(spawnRun).mockClear();
    vi.mocked(hasActiveRun).mockReturnValue(false);
  });

  it("既に run が実行中なら 409 を返し spawnRun を呼ばない", async () => {
    vi.mocked(hasActiveRun).mockReturnValue(true);
    const res = await request(app).post("/api/runs/start").send({ baseUrl: "https://example.com" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("a run is already in progress");
    expect(spawnRun).not.toHaveBeenCalled();
  });

  it("spawnRun を呼んで sessionId を返す", async () => {
    vi.mocked(spawnRun).mockReturnValue("run_999");
    const res = await request(app).post("/api/runs/start").send({ baseUrl: "https://example.com" });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBe("run_999");
    expect(spawnRun).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: "https://example.com" }));
  });

  it("maxBrowsers/maxExplorers/maxThresholds を指定しても spawnRun に渡す", async () => {
    vi.mocked(spawnRun).mockReturnValue("run_999");
    const res = await request(app)
      .post("/api/runs/start")
      .send({ baseUrl: "https://example.com", maxBrowsers: 3, maxExplorers: 0, maxThresholds: 8 });
    expect(res.status).toBe(200);
    expect(spawnRun).toHaveBeenCalledWith(expect.objectContaining({ maxBrowsers: 3, maxExplorers: 0, maxThresholds: 8 }));
  });

  it("不正な mode は 400（spawnRun は呼ばれない）", async () => {
    const res = await request(app).post("/api/runs/start").send({ mode: "godmode" });
    expect(res.status).toBe(400);
    expect(spawnRun).not.toHaveBeenCalled();
  });

  it.each([
    { maxBrowsers: -1 },
    { maxBrowsers: 9 },
    { maxBrowsers: 1.5 },
    { maxBrowsers: "3" },
    { maxExplorers: -1 },
    { maxExplorers: 100 },
    { maxThresholds: -1 },
    { maxThresholds: 9 },
  ])("agent count が範囲外/非整数/非数値なら 400 で spawnRun を呼ばない: %j", async (body) => {
    const res = await request(app).post("/api/runs/start").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maxBrowsers, maxExplorers, and maxThresholds/);
    expect(spawnRun).not.toHaveBeenCalled();
  });

  it("agent count は 0 と 8（境界値）を許可する", async () => {
    vi.mocked(spawnRun).mockReturnValue("run_999");
    const res = await request(app)
      .post("/api/runs/start")
      .send({ maxBrowsers: 0, maxExplorers: 8, maxThresholds: 0 });
    expect(res.status).toBe(200);
    expect(spawnRun).toHaveBeenCalled();
  });

  it("agent count 未指定なら素通しする（デフォルトは spawnRun/run.ts 側で決まる）", async () => {
    vi.mocked(spawnRun).mockReturnValue("run_999");
    const res = await request(app).post("/api/runs/start").send({ baseUrl: "https://example.com" });
    expect(res.status).toBe(200);
    expect(spawnRun).toHaveBeenCalledWith(
      expect.objectContaining({ maxBrowsers: undefined, maxExplorers: undefined, maxThresholds: undefined }),
    );
  });

  it("llmBaseUrl だけ指定して llmApiKey が無いと 400（spawnRun は呼ばれない）", async () => {
    const res = await request(app)
      .post("/api/runs/start")
      .send({ llmBaseUrl: "https://attacker.example.com/v1" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("llmApiKey is required when llmBaseUrl is set");
    expect(spawnRun).not.toHaveBeenCalled();
  });

  it("llmBaseUrl と llmApiKey を両方指定すれば通る", async () => {
    vi.mocked(spawnRun).mockReturnValue("run_999");
    const res = await request(app)
      .post("/api/runs/start")
      .send({ llmBaseUrl: "https://my-provider.example.com/v1", llmApiKey: "sk-mykey" });
    expect(res.status).toBe(200);
    expect(spawnRun).toHaveBeenCalledWith(
      expect.objectContaining({ llmBaseUrl: "https://my-provider.example.com/v1", llmApiKey: "sk-mykey" }),
    );
  });

  it("llmBaseUrl が無ければ llmApiKey 無しでも通る", async () => {
    vi.mocked(spawnRun).mockReturnValue("run_999");
    const res = await request(app).post("/api/runs/start").send({ baseUrl: "https://example.com" });
    expect(res.status).toBe(200);
    expect(spawnRun).toHaveBeenCalled();
  });
});

// ================================================================
// POST /api/runs/:runId/cancel
// ================================================================
describe("POST /api/runs/:runId/cancel", () => {
  it("cancelSession の結果を ok として返す（成功）", async () => {
    vi.mocked(cancelSession).mockReturnValue(true);
    const res = await request(app).post("/api/runs/run_123/cancel");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("cancelSession の結果を ok として返す（失敗）", async () => {
    vi.mocked(cancelSession).mockReturnValue(false);
    const res = await request(app).post("/api/runs/run_123/cancel");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
  });
});

// ================================================================
// GET /api/runs/:runId/log
// ================================================================
describe("GET /api/runs/:runId/log", () => {
  it("不正な runId → 400", async () => {
    const res = await request(app).get("/api/runs/bad-id/log");
    expect(res.status).toBe(400);
  });

  it("アクティブセッションがある → session 情報を返す", async () => {
    (activeSessions as Map<string, unknown>).set("run_123", { lines: ["a", "b"], done: false, exitCode: null });
    const res = await request(app).get("/api/runs/run_123/log");
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(["a", "b"]);
    expect(res.body.done).toBe(false);
  });

  it("アクティブセッションなし + ログファイルあり → ファイルから読む", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("line1\nline2\n" as unknown as ReturnType<typeof fs.readFileSync>);
    const res = await request(app).get("/api/runs/run_123/log");
    expect(res.status).toBe(200);
    expect(res.body.lines).toEqual(["line1", "line2"]);
    expect(res.body.done).toBe(true);
  });

  it("アクティブセッションもログファイルもない → 404", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).get("/api/runs/run_123/log");
    expect(res.status).toBe(404);
  });
});

// ================================================================
// SSE: /api/sessions/:sessionId/events, /api/runs/:runId/events
// ================================================================
describe("SSE events", () => {
  it("/api/sessions/:sessionId/events 不正な sessionId → 400", async () => {
    const res = await request(app).get("/api/sessions/bad-id/events");
    expect(res.status).toBe(400);
  });

  it("/api/runs/:runId/events 不正な runId → 400", async () => {
    const res = await request(app).get("/api/runs/bad-id/events");
    expect(res.status).toBe(400);
  });

  it("/api/sessions/:sessionId/events セッションが存在しない → 404", async () => {
    const res = await request(app).get("/api/sessions/run_404/events");
    expect(res.status).toBe(404);
  });

  it("/api/runs/:runId/events 完了済みセッション → イベントを送信して終了", async () => {
    (activeSessions as Map<string, unknown>).set("run_555", {
      lines: ["log line"],
      done: true,
      exitCode: 0,
      listeners: [],
      doneListeners: [],
    });
    const res = await request(app).get("/api/runs/run_555/events");
    expect(res.status).toBe(200);
    expect(res.text).toContain("log line");
    expect(res.text).toContain("event: done");
  });
});

// ================================================================
// Fixed personas API
// ================================================================
describe("personas API", () => {
  const sampleSpec = {
    appName: "Demo",
    appDescription: "A demo app",
    targetUsers: "individuals",
    features: "x",
    designContext: "y",
    uiFeatures: "z",
    appGoals: ["Complete tasks"],
    confidence: "high",
    sources: ["ui"],
  };

  beforeEach(() => {
    vi.mocked(listFixedPersonas).mockReturnValue([]);
    vi.mocked(loadAgents).mockReturnValue([]);
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it("GET /api/personas returns fixed list", async () => {
    vi.mocked(listFixedPersonas).mockReturnValue([
      { id: "f1", name: "Ken", role: "grumpy", persona: "p", createdAt: "t", origin: "fixed" },
    ] as never);
    const res = await request(app).get("/api/personas");
    expect(res.status).toBe(200);
    expect(res.body[0].name).toBe("Ken");
    expect(listFixedPersonas).toHaveBeenCalledWith({ includeArchived: false });
  });

  it("POST /api/personas rejects empty seed", async () => {
    const res = await request(app).post("/api/personas").send({ seed: "  " });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/seed/i);
  });

  it("POST /api/personas rejects when product spec is missing", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const res = await request(app).post("/api/personas").send({ seed: "初めて使う人" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/spec/i);
  });

  it("POST /api/personas creates a fixed persona from seed", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sampleSpec) as never);
    vi.mocked(generatePersonaFromSeed).mockResolvedValue({
      name: "Takeshi",
      role: "first-time user",
      persona: "Needs clear onboarding.",
      lenses: ["trust"],
    });
    vi.mocked(addAgent).mockReturnValue({
      id: "agent_1",
      name: "Takeshi",
      role: "first-time user",
      persona: "Needs clear onboarding.",
      lenses: ["trust"],
      origin: "fixed",
      status: "active",
      seed: "初めて使う人",
      createdAt: "2026-01-01T00:00:00.000Z",
    } as never);

    const res = await request(app).post("/api/personas").send({ seed: "初めて使う人" });
    expect(res.status).toBe(201);
    expect(res.body.origin).toBe("fixed");
    expect(addAgent).toHaveBeenCalledWith(expect.objectContaining({ origin: "fixed", seed: "初めて使う人" }));
  });

  it("POST /api/personas returns 502 on generation failure", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(sampleSpec) as never);
    vi.mocked(generatePersonaFromSeed).mockRejectedValue(new PersonaGenerationError("bad json"));
    const res = await request(app).post("/api/personas").send({ seed: "x" });
    expect(res.status).toBe(502);
  });

  it("POST archive/restore and PATCH update fixed personas", async () => {
    vi.mocked(loadAgents).mockReturnValue([
      { id: "f1", name: "A", role: "r", persona: "p", createdAt: "t", origin: "fixed", status: "active" },
    ] as never);
    vi.mocked(updateAgent).mockReturnValue({
      id: "f1", name: "B", role: "r", persona: "p", createdAt: "t", origin: "fixed", status: "active",
    } as never);
    vi.mocked(archiveAgent).mockReturnValue({
      id: "f1", name: "B", role: "r", persona: "p", createdAt: "t", origin: "fixed", status: "archived",
    } as never);
    vi.mocked(restoreAgent).mockReturnValue({
      id: "f1", name: "B", role: "r", persona: "p", createdAt: "t", origin: "fixed", status: "active",
    } as never);

    const patch = await request(app).patch("/api/personas/f1").send({ name: "B" });
    expect(patch.status).toBe(200);
    expect(patch.body.name).toBe("B");

    const arch = await request(app).post("/api/personas/f1/archive");
    expect(arch.status).toBe(200);
    expect(arch.body.status).toBe("archived");

    const rest = await request(app).post("/api/personas/f1/restore");
    expect(rest.status).toBe(200);
    expect(rest.body.status).toBe("active");
  });
});

// ================================================================
// GET /api/adoption
// ================================================================
describe("GET /api/adoption", () => {
  it("起票実績が無い → 404", async () => {
    vi.mocked(buildAdoptionView).mockReturnValue(null);
    const res = await request(app).get("/api/adoption");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("no adoption data yet");
  });

  it("集計がある → 200 + 採用率", async () => {
    vi.mocked(buildAdoptionView).mockReturnValue({
      overall: { adopted: 3, rejected: 1, total: 4, rate: 0.75 },
      byLens: [{ name: "Accessibility", adopted: 3, rejected: 1, total: 4, rate: 0.75 }],
      byCategory: [{ name: "bug", adopted: 3, rejected: 1, total: 4, rate: 0.75 }],
      pending: 2,
      recent: [{
        title: "[bug] Login broken",
        url: "https://github.com/o/r/issues/12",
        category: "bug",
        resolution: "adopted",
        resolvedAt: "2026-07-01T00:00:00.000Z",
      }],
    });
    const res = await request(app).get("/api/adoption");
    expect(res.status).toBe(200);
    expect(res.body.overall.rate).toBe(0.75);
    expect(res.body.byLens[0].name).toBe("Accessibility");
    expect(res.body.pending).toBe(2);
  });

  it("読み取りが例外を投げる → 500", async () => {
    vi.mocked(buildAdoptionView).mockImplementation(() => { throw new Error("boom"); });
    const res = await request(app).get("/api/adoption");
    expect(res.status).toBe(500);
  });
});

// ================================================================
// GET /api/runs/:runId/triage
// ================================================================
describe("GET /api/runs/:runId/triage", () => {
  const view = {
    runId: "run_1",
    completedAt: "2026-01-02T00:00:00.000Z",
    issues: [{
      title: "[bug] Login broken",
      category: "bug",
      url: "https://example.com/issues/7",
      edgeRisk: null,
      createdAt: "2026-01-02T00:00:00.000Z",
      mergedFindings: [{ id: "f1", title: "Login is broken", agentName: "Alice", category: "bug" }],
    }],
    skips: [],
    unprocessed: [],
    stats: { issuesCreated: 1, findingsIssued: 1, findingsSkipped: 0, findingsUnprocessed: 0, edgeRisks: 0 },
    legacy: false,
  };

  it("不正な run id → 400", async () => {
    const res = await request(app).get("/api/runs/not-a-run/triage");
    expect(res.status).toBe(400);
    expect(buildTriageView).not.toHaveBeenCalled();
  });

  it("triage 結果が無い → 404", async () => {
    vi.mocked(buildTriageView).mockReturnValue(null);
    const res = await request(app).get("/api/runs/run_1/triage");
    expect(res.status).toBe(404);
  });

  it("triage 結果がある → 200 + 起票内容", async () => {
    vi.mocked(buildTriageView).mockReturnValue(view);
    const res = await request(app).get("/api/runs/run_1/triage");
    expect(res.status).toBe(200);
    expect(res.body.issues[0].mergedFindings[0].title).toBe("Login is broken");
    expect(res.body.stats.issuesCreated).toBe(1);
    expect(buildTriageView).toHaveBeenCalledWith("run_1");
  });

  it("読み取りが例外を投げる → 500", async () => {
    vi.mocked(buildTriageView).mockImplementation(() => { throw new Error("boom"); });
    const res = await request(app).get("/api/runs/run_1/triage");
    expect(res.status).toBe(500);
  });
});

// ================================================================
// Node プロセスレベルのフェイルセーフ
// ================================================================
describe("process-level safety nets", () => {
  it("uncaughtException はログだけしてプロセスを落とさない", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.emit("uncaughtException", new Error("simulated crash"));
    expect(errorSpy).toHaveBeenCalledWith("[server] uncaughtException:", "simulated crash");
    errorSpy.mockRestore();
  });

  it("unhandledRejection はログだけしてプロセスを落とさない", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.emit("unhandledRejection", new Error("simulated rejection"), Promise.resolve());
    expect(errorSpy).toHaveBeenCalledWith("[server] unhandledRejection:", new Error("simulated rejection"));
    errorSpy.mockRestore();
  });
});
