import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../agent-loop", () => ({ createMessageWithRetry: vi.fn() }));

import { createMessageWithRetry } from "../agent-loop";
import { designOrg, UNIVERSAL_LENSES } from "../org-designer";
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

function makeTextResponse(text: string) {
  return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: {} };
}

beforeEach(() => {
  vi.mocked(createMessageWithRetry).mockReset();
});

describe("designOrg", () => {
  it("LLM に正しい model/system プロンプトで問い合わせる", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeTextResponse("policy text") as never);
    await designOrg(makeSpec(), {} as LLMClient, "claude-sonnet-4-6");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    expect(params.model).toBe("claude-sonnet-4-6");
    expect(params.system).toContain("software QA expert");
  });

  it("spec の appDescription/targetUsers/features をプロンプトに含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeTextResponse("x") as never);
    await designOrg(makeSpec({ appDescription: "A unique app desc", targetUsers: "Unique users", features: "Unique features" }), {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).toContain("A unique app desc");
    expect(content).toContain("Unique users");
    expect(content).toContain("Unique features");
  });

  it("designContext がある場合はプロンプトに [Design Context] セクションを含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeTextResponse("x") as never);
    await designOrg(makeSpec({ designContext: "Material Design based" }), {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).toContain("[Design Context]");
    expect(content).toContain("Material Design based");
  });

  it("designContext が空文字の場合はセクションを含めない", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeTextResponse("x") as never);
    await designOrg(makeSpec({ designContext: "" }), {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).not.toContain("[Design Context]");
  });

  it("coverageSummary がある場合は [Coverage History] セクションを含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeTextResponse("x") as never);
    await designOrg(makeSpec(), {} as LLMClient, "m", "Lens X used 5 times");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).toContain("[Coverage History]");
    expect(content).toContain("Lens X used 5 times");
  });

  it("coverageSummary が無い場合はセクションを含めない", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeTextResponse("x") as never);
    await designOrg(makeSpec(), {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).not.toContain("[Coverage History]");
  });

  it("レスポンスの text block を結合して personaGuidance に含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue({
      content: [{ type: "text", text: "Part A. " }, { type: "text", text: "Part B." }],
      stop_reason: "end_turn",
      usage: {},
    } as never);
    const result = await designOrg(makeSpec(), {} as LLMClient, "m");
    expect(result.personaGuidance).toContain("Part A. Part B.");
  });

  it("text 以外の content block（tool_use 等）は無視する", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "x", input: {} }, { type: "text", text: "only this" }],
      stop_reason: "end_turn",
      usage: {},
    } as never);
    const result = await designOrg(makeSpec(), {} as LLMClient, "m");
    expect(result.personaGuidance).toContain("only this");
  });

  it("personaGuidance に UNIVERSAL_LENSES の全項目を含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeTextResponse("base text") as never);
    const result = await designOrg(makeSpec(), {} as LLMClient, "m");
    for (const lens of UNIVERSAL_LENSES) {
      expect(result.personaGuidance).toContain(lens);
    }
  });

  it("personaGuidance にデザイン標準（HIG/Material/HCI原則）の参照を含める", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(makeTextResponse("x") as never);
    const result = await designOrg(makeSpec(), {} as LLMClient, "m");
    expect(result.personaGuidance).toContain("Apple HIG");
    expect(result.personaGuidance).toContain("Material Design");
    expect(result.personaGuidance).toContain("Fitts's Law");
  });
});
