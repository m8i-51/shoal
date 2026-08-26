import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");

import * as fs from "fs";
import { saveFinding, initRunLog, saveRunLog, getSwarmSignals, collectedFindings, extractFindingPath, pathsShareArea } from "../findings";
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

describe("getSwarmSignals", () => {
  beforeEach(() => {
    collectedFindings.length = 0;
  });

  it("他のエージェントの findings だけを返す", () => {
    saveFinding(makeFinding({ id: "s1", agentId: "a1", title: "Mine" }));
    saveFinding(makeFinding({ id: "s2", agentId: "a2", agentName: "Bob", title: "Theirs" }));
    const signals = getSwarmSignals("a1");
    expect(signals).toHaveLength(1);
    expect(signals[0].title).toBe("Theirs");
    expect(signals[0].agentName).toBe("Bob");
  });

  it("findings がなければ空配列を返す", () => {
    expect(getSwarmSignals("a1")).toEqual([]);
  });

  it("直近 limit 件に制限し、長い body は 200 文字に切り詰める", () => {
    for (let i = 0; i < 10; i++) {
      saveFinding(makeFinding({ id: `s${i}`, agentId: "a2", title: `Finding ${i}`, body: "x".repeat(300) }));
    }
    const signals = getSwarmSignals("a1", 3);
    expect(signals).toHaveLength(3);
    expect(signals[0].title).toBe("Finding 7"); // 直近3件（7,8,9）
    expect(signals[0].excerpt.length).toBeLessThanOrEqual(201); // 200 + "…"
  });

  it("currentPath を渡すと同エリアの finding だけを返す", () => {
    saveFinding(makeFinding({ id: "s1", agentId: "a2", title: "Checkout bug", body: "On /checkout the button fails" }));
    saveFinding(makeFinding({ id: "s2", agentId: "a2", title: "Admin bug", body: "On /admin/users page broken" }));
    const signals = getSwarmSignals("a1", 8, "/checkout/review");
    expect(signals).toHaveLength(1);
    expect(signals[0].title).toBe("Checkout bug");
    expect(signals[0].path).toBe("/checkout");
  });

  it("同エリアに finding が無いときは全体からフォールバックする", () => {
    saveFinding(makeFinding({ id: "s1", agentId: "a2", title: "Admin bug", body: "On /admin page broken" }));
    const signals = getSwarmSignals("a1", 8, "/checkout");
    expect(signals).toHaveLength(1);
    expect(signals[0].title).toBe("Admin bug");
  });
});

describe("extractFindingPath", () => {
  it("本文中の最初のパスから先頭セグメントを取る", () => {
    expect(extractFindingPath({ title: "Bug", body: "Visited /checkout/review and failed" })).toBe("/checkout");
    expect(extractFindingPath({ title: "Bug", body: "No path here" })).toBe("/");
  });
});

describe("pathsShareArea", () => {
  it("同じルートセグメントまたは prefix を共有する", () => {
    expect(pathsShareArea("/checkout/review", "/checkout")).toBe(true);
    expect(pathsShareArea("/checkout", "/checkout/review")).toBe(true);
    expect(pathsShareArea("/checkout", "/admin")).toBe(false);
    expect(pathsShareArea("/", "/checkout")).toBe(true);
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
