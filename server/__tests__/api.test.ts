import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

// ---- モック ----
vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return { ...actual, join: (...args: string[]) => args.join("/"), resolve: (...args: string[]) => args.join("/"), dirname: (p: string) => p };
});
vi.mock("../runner.js", () => ({ activeSessions: new Map(), spawnRun: vi.fn(), cancelSession: vi.fn() }));
vi.mock("../runs.js", () => ({ listRuns: vi.fn(() => []), getReportPath: vi.fn(() => null) }));
vi.mock("../scheduler.js", () => ({ loadSchedule: vi.fn(() => ({ enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null })), saveSchedule: vi.fn(), startScheduler: vi.fn() }));
vi.mock("../../framework/diary.js", () => ({ generateDiary: vi.fn(), getDiaryPath: vi.fn(() => null) }));
vi.mock("express-rate-limit", () => ({ rateLimit: () => (_req: unknown, _res: unknown, next: () => void) => next() }));

import * as fs from "fs";
import { generateDiary, getDiaryPath } from "../../framework/diary.js";
import { activeSessions } from "../runner.js";

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
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
  vi.mocked(fs.readFileSync).mockReturnValue("{}" as unknown as ReturnType<typeof fs.readFileSync>);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(getDiaryPath).mockReturnValue(null);
  vi.mocked(generateDiary).mockResolvedValue("# 探索日誌");
  (activeSessions as Map<string, unknown>).clear();
});

// ================================================================
// GET /api/runs/:runId/diary
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

  it("正常な外部 URL → upstream レスポンスを返す", async () => {
    const bundle = { version: "1", source: "shoal", findings: [] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => bundle,
    }));
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "https://raw.githubusercontent.com/example/data.json" });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe("1");
    vi.unstubAllGlobals();
  });

  it("upstream が失敗 → 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
    }));
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "https://example.com/data.json" });
    expect(res.status).toBe(502);
    vi.unstubAllGlobals();
  });

  it("fetch 例外（タイムアウト等）→ 502", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("AbortError")));
    const res = await request(app).post("/api/findings/proxy-url").send({ url: "https://example.com/data.json" });
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
    vi.mocked(loadSchedule).mockReturnValue({ enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null });
    const res = await request(app).patch("/api/schedule").send({ dayOfWeek: -1 });
    expect(res.status).toBe(200);
    expect(res.body.dayOfWeek).toBe(1); // デフォルト値を維持
  });

  it("範囲外の hour（24）は無視する", async () => {
    const { loadSchedule } = await import("../scheduler.js");
    vi.mocked(loadSchedule).mockReturnValue({ enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null });
    const res = await request(app).patch("/api/schedule").send({ hour: 24 });
    expect(res.status).toBe(200);
    expect(res.body.hour).toBe(9);
  });

  it("enabled に数値を渡すと Boolean 変換される", async () => {
    const { loadSchedule } = await import("../scheduler.js");
    vi.mocked(loadSchedule).mockReturnValue({ enabled: false, dayOfWeek: 1, hour: 9, minute: 0, lastRunDate: null });
    const res = await request(app).patch("/api/schedule").send({ enabled: 1 });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
  });
});
