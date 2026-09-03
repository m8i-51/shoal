import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../llm-retry", () => ({ createMessageWithRetry: vi.fn(), sleep: vi.fn(), rateLimitRetries: 0 }));

import * as fs from "fs";
import { createMessageWithRetry } from "../llm-retry";
import { runTriageAgent } from "../triage";
import { neutralizeMentions } from "../mentions";
import type { Finding } from "../types";
import type { IssueTracker } from "../trackers/index";
import type { LLMClient } from "../llm-client";
import type { ProductEdge } from "../product-edge";

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
    expect(result).toEqual({ issued: [], skipped: [], unprocessed: [], issuesCreated: 0, edgeRisks: [], issues: [], skips: [] });
    expect(createMessageWithRetry).not.toHaveBeenCalled();
  });

  it("再訪 re-report は既存 open issue へコメントし LLM triage から除外する", async () => {
    const tracker = makeTracker({
      fetchOpenIssues: vi.fn().mockResolvedValue([{ number: 9, title: "Checkout still broken", labels: [] }]),
      commentOnIssue: vi.fn().mockResolvedValue(true),
    });
    const finding = makeFinding({
      id: "f1",
      title: "Checkout still broken",
      body: "Still broken since last visit.",
    });
    const result = await runTriageAgent([finding], {} as LLMClient, "m", tracker);
    expect(tracker.commentOnIssue).toHaveBeenCalledWith(9, expect.stringContaining("Returning-user re-report"));
    expect(result.skipped).toEqual(["f1"]);
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

    it("LLM が書いた body 中の @mention をバッククォートで無害化する", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "t",
          body: "cc @someone please review, also see @some-team and user@example.com",
          category: "bug",
          merged_finding_ids: ["f1"],
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      const [, body] = vi.mocked(tracker.createIssue).mock.calls[0];
      expect(body).toContain("cc `@someone` please review");
      expect(body).toContain("also see `@some-team`");
      // preceded by a word char — not a mention, must stay intact
      expect(body).toContain("user@example.com");
      expect(body).not.toContain("`@example`");
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

  describe("product edge", () => {
    const edge: ProductEdge = {
      sharpEdges: ["Keyboard-first everywhere"],
      tradeoffs: ["No onboarding wizard"],
      source: "human",
    };

    it("edge 未宣言なら prompt にも create_issue スキーマにも edge_risk は出ない", async () => {
      vi.mocked(createMessageWithRetry).mockResolvedValue(endTurn() as never);
      await runTriageAgent([makeFinding()], {} as LLMClient, "m", makeTracker());
      const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
      expect(params.system).not.toContain("Product Edge");
      const createIssue = params.tools?.find((t) => t.name === "create_issue");
      const properties = (createIssue?.input_schema as { properties: Record<string, unknown> }).properties;
      expect(properties.edge_risk).toBeUndefined();
    });

    it("edge を宣言すると prompt に載り create_issue が edge_risk を受け取れる", async () => {
      vi.mocked(createMessageWithRetry).mockResolvedValue(endTurn() as never);
      await runTriageAgent([makeFinding()], {} as LLMClient, "m", makeTracker(), undefined, edge);
      const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
      expect(params.system).toContain("Keyboard-first everywhere");
      expect(params.system).toContain("No onboarding wizard");
      const createIssue = params.tools?.find((t) => t.name === "create_issue");
      const properties = (createIssue?.input_schema as { properties: Record<string, unknown> }).properties;
      expect(properties.edge_risk).toBeDefined();
    });

    it("edge_risk 付きの issue は edge-risk ラベルと判断材料セクションを持つ", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "Add a mouse path", body: "b", category: "ux", merged_finding_ids: ["f1"],
          edge_risk: { edge: "Keyboard-first everywhere", why: "A mouse path makes the keyboard flow optional" },
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker, undefined, edge);
      const [, body, labels] = vi.mocked(tracker.createIssue).mock.calls[0];
      expect(labels).toEqual(["ux", "feedback-agent", "edge-risk"]);
      expect(body).toContain("Edge risk — decide before fixing");
      expect(body).toContain("Keyboard-first everywhere");
      // 指摘そのものは握りつぶさない: 通常どおり起票される
      expect(result.issued).toEqual(["f1"]);
      expect(result.edgeRisks).toEqual(["f1"]);
    });

    it("bug は尖りを理由に印を付けない（欠陥はポジショニングで正当化できない）", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "Save silently fails", body: "b", category: "bug", merged_finding_ids: ["f1"],
          edge_risk: { edge: "Keyboard-first everywhere", why: "..." },
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker, undefined, edge);
      const [, body, labels] = vi.mocked(tracker.createIssue).mock.calls[0];
      expect(labels).toEqual(["bug", "feedback-agent"]);
      expect(body).not.toContain("Edge risk");
      expect(result.edgeRisks).toEqual([]);
    });

    it("edge 未宣言なら edge_risk が渡ってきても無視する", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "t", body: "b", category: "ux", merged_finding_ids: ["f1"],
          edge_risk: { edge: "made up", why: "..." },
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker);
      const [, , labels] = vi.mocked(tracker.createIssue).mock.calls[0];
      expect(labels).toEqual(["ux", "feedback-agent"]);
      expect(result.edgeRisks).toEqual([]);
    });

    it("edge_risk が半分しか無い場合は印を付けない", async () => {
      const tracker = makeTracker();
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "t", body: "b", category: "ux", merged_finding_ids: ["f1"],
          edge_risk: { edge: "Keyboard-first everywhere" },
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding({ id: "f1" })], {} as LLMClient, "m", tracker, undefined, edge);
      const [, , labels] = vi.mocked(tracker.createIssue).mock.calls[0];
      expect(labels).toEqual(["ux", "feedback-agent"]);
      expect(result.edgeRisks).toEqual([]);
    });
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

  // ダッシュボードは triage_result.json しか読まないので、
  // 「何がどう1件にまとまったか」はここに残らないと永久に見えない。
  describe("起票の記録", () => {
    it("マージした finding・トラッカー URL・カテゴリを issues に残す", async () => {
      const tracker = makeTracker({ createIssue: vi.fn().mockResolvedValue("https://example.com/issue/7") });
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "[bug] Login broken", body: "details", category: "bug", merged_finding_ids: ["f1", "f2"],
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent(
        [makeFinding({ id: "f1" }), makeFinding({ id: "f2" })],
        {} as LLMClient, "m", tracker,
      );
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        title: "[bug] Login broken",
        category: "bug",
        url: "https://example.com/issue/7",
        mergedFindingIds: ["f1", "f2"],
        edgeRisk: null,
      });
      const saved = JSON.parse(vi.mocked(fs.writeFileSync).mock.calls[0][1] as string);
      expect(saved.issues[0].mergedFindingIds).toEqual(["f1", "f2"]);
    });

    it("edge-risk の中身（尖りと理由）を issues に残す", async () => {
      const edge: ProductEdge = {
        sharpEdges: ["Keyboard-only"],
        tradeoffs: ["No onboarding"],
        source: "human",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("create_issue", {
          title: "[ux] Add a mouse path", body: "details", category: "ux", merged_finding_ids: ["f1"],
          edge_risk: { edge: "Keyboard-only", why: "Adding mouse affordances blunts it" },
        }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding()], {} as LLMClient, "m", makeTracker(), undefined, edge);
      expect(result.issues[0].edgeRisk).toEqual({
        edge: "Keyboard-only",
        why: "Adding mouse affordances blunts it",
      });
    });

    it("skip の理由を skips に残す", async () => {
      vi.mocked(createMessageWithRetry)
        .mockResolvedValueOnce(toolUseResponse("skip_finding", { finding_id: "f1", reason: "duplicate of #3" }) as never)
        .mockResolvedValueOnce(endTurn() as never);
      const result = await runTriageAgent([makeFinding()], {} as LLMClient, "m", makeTracker());
      expect(result.skips).toEqual([{ findingId: "f1", reason: "duplicate of #3" }]);
      expect(result.skipped).toEqual(["f1"]);
    });

    it("再訪 re-report もコメント先の issue を理由として skips に残す", async () => {
      const tracker = makeTracker({
        fetchOpenIssues: vi.fn().mockResolvedValue([{ number: 9, title: "Checkout still broken", labels: [] }]),
      });
      const result = await runTriageAgent(
        [makeFinding({ id: "f1", title: "Checkout still broken", body: "Still broken since last visit." })],
        {} as LLMClient, "m", tracker,
      );
      expect(result.skips).toHaveLength(1);
      expect(result.skips[0].findingId).toBe("f1");
      expect(result.skips[0].reason).toContain("Checkout still broken");
    });
  });
});

describe("neutralizeMentions", () => {
  it("@word をバッククォートで囲む", () => {
    expect(neutralizeMentions("hey @alice check this")).toBe("hey `@alice` check this");
  });

  it("文頭の @mention も検出する", () => {
    expect(neutralizeMentions("@bob take a look")).toBe("`@bob` take a look");
  });

  it("ハイフンやアンダースコアを含む GitHub チームメンションにも対応する", () => {
    expect(neutralizeMentions("cc @some_team and @some-team")).toBe("cc `@some_team` and `@some-team`");
  });

  it("メールアドレスの @ は無視する（直前が単語文字）", () => {
    expect(neutralizeMentions("contact user@example.com for help")).toBe("contact user@example.com for help");
  });

  it("既にバッククォートで囲まれた @mention は二重に囲まない", () => {
    expect(neutralizeMentions("see `@already`")).toBe("see `@already`");
  });

  it("@ を含まない文字列はそのまま返す", () => {
    expect(neutralizeMentions("no mentions here")).toBe("no mentions here");
  });
});
