import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");

import * as fs from "fs";
import { saveFinding, initRunLog, saveRunLog, collectedFindings } from "../findings";
import type { Finding } from "../types";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    runId: "run_test",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Bug",
    body: "broken",
    category: "bug",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.mkdirSync).mockReset().mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReset().mockReturnValue(undefined);
  delete process.env.SHOAL_RUN_ID;
});

describe("saveFinding", () => {
  it("collectedFindings に追加する", () => {
    const before = collectedFindings.length;
    saveFinding(makeFinding({ id: "f-unique-1" }));
    expect(collectedFindings.length).toBe(before + 1);
    expect(collectedFindings[collectedFindings.length - 1].id).toBe("f-unique-1");
  });

  it("findings ディレクトリが無い場合は作成する", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    saveFinding(makeFinding());
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("findings/run_test"), { recursive: true });
  });

  it("findings ディレクトリが既にある場合は作成しない", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    saveFinding(makeFinding());
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });

  it("finding.id.json として正しい内容を書き込む", () => {
    const finding = makeFinding({ id: "f-write-test" });
    saveFinding(finding);
    const [filePath, content, encoding] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(filePath).toContain("f-write-test.json");
    expect(JSON.parse(content as string)).toEqual(finding);
    expect(encoding).toBe("utf-8");
  });
});

describe("saveRunLog — runLog 未初期化", () => {
  it("initRunLog が一度も呼ばれていない場合は何もしない", () => {
    // このテストはファイル内で initRunLog より先に実行する必要がある
    // （runLog はモジュールレベルの let で、一度 init すると以後は常に存在するため）
    saveRunLog();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("initRunLog", () => {
  it("SHOAL_RUN_ID が設定されていればそれを runId に使う", () => {
    process.env.SHOAL_RUN_ID = "run_from_env";
    initRunLog(3, "owner/repo");
    saveRunLog();
    const [filePath] = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
    expect(filePath).toContain("run_from_env");
  });

  it("SHOAL_RUN_ID が無ければ run_<timestamp> 形式の runId を生成する", () => {
    delete process.env.SHOAL_RUN_ID;
    initRunLog(2, "owner/repo");
    saveRunLog();
    const [filePath] = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
    expect(filePath).toMatch(/run_\d+\.json$/);
  });

  it("summary の初期値が正しい", () => {
    initRunLog(5, "owner/repo");
    saveRunLog();
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[vi.mocked(fs.writeFileSync).mock.calls.length - 1];
    const saved = JSON.parse(content as string);
    expect(saved.summary.totalAgents).toBe(5);
    expect(saved.summary.completed).toBe(0);
    expect(saved.summary.cost).toEqual({ inputTokens: 0, outputTokens: 0, estimatedUSD: null });
    expect(saved.repo).toBe("owner/repo");
  });
});

describe("saveRunLog", () => {
  it("logs ディレクトリが無い場合は作成する", () => {
    initRunLog(1, "r");
    vi.mocked(fs.existsSync).mockReturnValue(false);
    saveRunLog();
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("logs"), { recursive: true });
  });

  it("logs ディレクトリが既にある場合は作成しない", () => {
    initRunLog(1, "r");
    vi.mocked(fs.mkdirSync).mockClear();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    saveRunLog();
    expect(fs.mkdirSync).not.toHaveBeenCalled();
  });
});
