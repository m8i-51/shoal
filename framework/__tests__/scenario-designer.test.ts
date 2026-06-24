import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../agent-loop", () => ({ createMessageWithRetry: vi.fn() }));

import { createMessageWithRetry } from "../agent-loop";
import { designScenarios } from "../scenario-designer";
import type { ProductSpec } from "../product-discovery";
import type { LLMClient } from "../llm-client";

function makeSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    appName: "TestApp",
    appDescription: "A project management tool",
    targetUsers: "Small teams",
    features: "Tasks, boards, comments",
    designContext: "",
    uiFeatures: "",
    appGoals: [],
    confidence: "high",
    sources: [],
    ...overrides,
  };
}

function makeToolUseResponse(scenarios: unknown) {
  return {
    content: [{ type: "tool_use", id: "t1", name: "output_scenarios", input: { scenarios } }],
    stop_reason: "tool_use",
    usage: {},
  };
}

beforeEach(() => {
  vi.mocked(createMessageWithRetry).mockReset();
});

describe("designScenarios", () => {
  it("正しい model/count でリクエストし、scenario_N の id を付与する", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeToolUseResponse([
      { title: "T1", context: "C1", goal: "G1", constraints: "X1" },
      { title: "T2", context: "C2", goal: "G2", constraints: "X2" },
    ]) as never);
    const result = await designScenarios(makeSpec(), [], {} as LLMClient, "claude-sonnet-4-6", 2);
    expect(result).toEqual([
      { id: "scenario_1", title: "T1", context: "C1", goal: "G1", constraints: "X1" },
      { id: "scenario_2", title: "T2", context: "C2", goal: "G2", constraints: "X2" },
    ]);
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.messages[0].content).toContain("Generate exactly 2 test scenarios");
  });

  it("openIssues がある場合は [Known Open Issues] ヒントを含める（最大15件）", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeToolUseResponse([]) as never);
    const issues = Array.from({ length: 20 }, (_, i) => ({ number: i, title: `Issue ${i}`, labels: ["bug"] }));
    await designScenarios(makeSpec(), issues, {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).toContain("[Known Open Issues");
    expect(content).toContain("Issue 14");
    expect(content).not.toContain("Issue 15");
  });

  it("openIssues が空の場合はヒントを含めない", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeToolUseResponse([]) as never);
    await designScenarios(makeSpec(), [], {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    expect(params.messages[0].content as string).not.toContain("[Known Open Issues");
  });

  it("coverageSummary がある場合は [Coverage History] ヒントを含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeToolUseResponse([]) as never);
    await designScenarios(makeSpec(), [], {} as LLMClient, "m", 5, "lens X underused");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).toContain("[Coverage History");
    expect(content).toContain("lens X underused");
  });

  it("uiFeatures がある場合は [UI-Only Features] セクションを含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeToolUseResponse([]) as never);
    await designScenarios(makeSpec({ uiFeatures: "dark mode toggle" }), [], {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    expect(params.messages[0].content as string).toContain("[UI-Only Features]\ndark mode toggle");
  });

  it("output_scenarios が呼ばれなかった場合は空配列を返す", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue({
      content: [{ type: "text", text: "I could not generate scenarios" }],
      stop_reason: "end_turn",
      usage: {},
    } as never);
    expect(await designScenarios(makeSpec(), [], {} as LLMClient, "m")).toEqual([]);
  });

  it("scenarios が配列でない場合は空配列を返す", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "output_scenarios", input: { scenarios: "not-an-array" } }],
      stop_reason: "tool_use",
      usage: {},
    } as never);
    expect(await designScenarios(makeSpec(), [], {} as LLMClient, "m")).toEqual([]);
  });

  it("scenarios が空配列の場合は空配列を返す", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeToolUseResponse([]) as never);
    expect(await designScenarios(makeSpec(), [], {} as LLMClient, "m")).toEqual([]);
  });

  it("各フィールドを文字列化する（数値が来ても String() で変換）", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeToolUseResponse([
      { title: 123, context: "C", goal: "G", constraints: "X" },
    ]) as never);
    const result = await designScenarios(makeSpec(), [], {} as LLMClient, "m");
    expect(result[0].title).toBe("123");
    expect(typeof result[0].title).toBe("string");
  });

  it("別の tool_use（output_scenarios 以外）は無視して空配列を返す", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "other_tool", input: {} }],
      stop_reason: "tool_use",
      usage: {},
    } as never);
    expect(await designScenarios(makeSpec(), [], {} as LLMClient, "m")).toEqual([]);
  });
});
