import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../agent-loop", () => ({ createMessageWithRetry: vi.fn() }));

import * as fs from "fs";
import { createMessageWithRetry } from "../agent-loop";
import { runTriageAgent } from "../triage";
import type { Finding } from "../types";
import type { IssueTracker } from "../trackers/index";
import type { LLMClient } from "../llm-client";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    runId: "run_test",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Bug found",
    body: "details",
    category: "bug",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeTracker(overrides: Partial<IssueTracker> = {}): IssueTracker {
  return {
    name: "fake",
    isEmpty: false,
    createIssue: vi.fn().mockResolvedValue("https://example.com/issue/1"),
    fetchOpenIssues: vi.fn().mockResolvedValue([]),
    fetchClosedIssues: vi.fn().mockResolvedValue([]),
    commentOnIssue: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

function endTurn(content: unknown[] = []) {
  return { content, stop_reason: "end_turn", usage: {} };
}

function toolUseResponse(name: string, input: unknown, id = "t1") {
  return { content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage: {} };
}

beforeEach(() => {
  vi.mocked(createMessageWithRetry).mockReset();
  vi.mocked(fs.writeFileSync).mockReset().mockReturnValue(undefined);
});

describe("runTriageAgent", () => {
  it("findings が空なら LLM を呼ばずに空の結果を返す", async () => {
    const tracker = makeTracker();
    const result = await runTriageAgent([], {} as LLMClient, "m", tracker);
    expect(result).toEqual({ issued: [], skipped: [], unprocessed: [], issuesCreated: 0 });
    expect(createMessageWithRetry).not.toHaveBeenCalled();
  });

  it("tool_use が無い応答（end_turn）でループを終了する", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(endTurn() as never);
    const result = await runTriageAgent([makeFinding()], {} as LLMClient, "m", makeTracker());
    expect(result.unprocessed).toEqual(["f1"]);
    expect(createMessageWithRetry).toHaveBeenCalledTimes(1);
  });

  it("既存の open issues がある場合はプロンプトに重複防止用のリストを含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(endTurn() as never);
    const tracker = makeTracker({ fetchOpenIssues: vi.fn().mockResolvedValue([{ number: 42, title: "Old bug", labels: [] }]) });
    await runTriageAgent([makeFinding()], {} as LLMClient, "m", tracker);
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    expect(params.system).toContain("42: Old bug");
  });

  it("get_all_findings は pending フラグ付きで finding 一覧を返す", async () => {
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("get_all_findings", {}) as never)
      .mockResolvedValueOnce(endTurn() as never);
    await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", makeTracker());
    const [, secondCallParams] = vi.mocked(createMessageWithRetry).mock.calls[1];
    // messages[0]=初回user, [1]=assistant(get_all_findings の tool_use), [2]=user(tool_result)
    const toolResultMsg = secondCallParams.messages[2];
    const content = (toolResultMsg.content as { content: string }[])[0].content;
    expect(JSON.parse(content)[0]).toMatchObject({ id: "f1", pending: true });
  });

  describe("create_issue", () => {
    it("正常な呼び出しで issue を作成し issued に追加する", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "[bug] Login broken", body: "details", category: "bug", merged_finding_ids: ["f1"],
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      expect(result.issued).toEqual(["f1"]);
      expect(result.issuesCreated).toBe(1);
      expect(tracker.createIssue).toHaveBeenCalledWith(
        "[bug] Login broken", expect.stringContaining("**Category:** bug"), ["bug", "feedback-agent"]
      );
    });

    it("タイトルの先頭の [xxx] プレフィックスを除去してから付け直す", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "[old-tag] Something broke", body: "b", category: "ux", merged_finding_ids: ["f1"],
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      expect(tracker.createIssue).toHaveBeenCalledWith("[ux] Something broke", expect.any(String), expect.any(Array));
    });

    it("screenshotPath を持つ finding がマージされるとスクリーンショットセクションを含める", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "t", body: "b", category: "bug", merged_finding_ids: ["f1"],
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      await runTriageAgent([makeFinding({ id: "f1", screenshotPath: "/tmp/shot.png" })], {} as LLMClient, "m", tracker);
      const [, body] = vi.mocked(tracker.createIssue).mock.calls[0];
      expect(body).toContain("**Screenshots:**");
      expect(body).toContain("/tmp/shot.png");
    });

    it("title/body/category が欠けている場合はエラーを返しスキップする", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", { body: "b", category: "bug", merged_finding_ids: ["f1"] }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      expect(tracker.createIssue).not.toHaveBeenCalled();
      expect(result.issued).toEqual([]);
    });

    it("merged_finding_ids が未指定（undefined）の場合もエラーを返す", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", { title: "t", body: "b", category: "bug" }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      expect(tracker.createIssue).not.toHaveBeenCalled();
      expect(result.unprocessed).toEqual(["f1"]);
    });

    it("merged_finding_ids が空の場合はエラーを返す", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", { title: "t", body: "b", category: "bug", merged_finding_ids: [] }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      expect(tracker.createIssue).not.toHaveBeenCalled();
      expect(result.unprocessed).toEqual(["f1"]);
    });

    it("tracker.createIssue が null を返し isEmpty=false の場合はエラー扱いになる", async () => {
      const tracker = makeTracker({ isEmpty: false, createIssue: vi.fn().mockResolvedValue(null) });
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", { title: "t", body: "b", category: "bug", merged_finding_ids: ["f1"] }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      expect(result.issued).toEqual([]);
      expect(result.issuesCreated).toBe(0);
    });

    it("tracker.createIssue が null を返すが isEmpty=true の場合は成功扱いになる（ローカル保存のみのケース）", async () => {
      const tracker = makeTracker({ isEmpty: true, createIssue: vi.fn().mockResolvedValue(null) });
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", { title: "t", body: "b", category: "bug", merged_finding_ids: ["f1"] }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      expect(result.issued).toEqual(["f1"]);
      expect(result.issuesCreated).toBe(1);
    });
  });

  describe("skip_finding", () => {
    it("正常な呼び出しで skipped に追加する", async () => {
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("skip_finding", { finding_id: "f1", reason: "duplicate" }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", makeTracker());
      expect(result.skipped).toEqual(["f1"]);
      expect(result.unprocessed).toEqual([]);
    });

    it("finding_id が欠けている場合はエラーを返す", async () => {
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("skip_finding", { reason: "x" }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", makeTracker());
      expect(result.skipped).toEqual([]);
      expect(result.unprocessed).toEqual(["f1"]);
    });
  });

  it("未知のツール名はエラー結果を返すがループは継続する", async () => {
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("unknown_tool", {}) as never)
      .mockResolvedValueOnce(endTurn() as never);
    const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", makeTracker());
    expect(createMessageWithRetry).toHaveBeenCalledTimes(2);
    expect(result.unprocessed).toEqual(["f1"]);
  });

  it("15 イテレーションに達するとループを終了する", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(
      toolUseResponse("skip_finding", { finding_id: "f1", reason: "x" }) as never
    );
    await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", makeTracker());
    expect(createMessageWithRetry).toHaveBeenCalledTimes(15);
  });

  it("処理後に findings/<runId>/triage_result.json を書き込む", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(endTurn() as never);
    await runTriageAgent([makeFinding({ id: "f1", runId: "run_xyz" })], {} as LLMClient, "m", makeTracker());
    const [filePath, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(filePath).toContain("findings/run_xyz/triage_result.json");
    const saved = JSON.parse(content as string);
    expect(saved.runId).toBe("run_xyz");
    expect(saved.unprocessed).toEqual(["f1"]);
  });
});
