import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tool-session", () => ({
  completeText: vi.fn(),
  captureStructuredTool: vi.fn(),
  runToolSession: vi.fn(),
}));

import { completeText } from "../tool-session";
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

beforeEach(() => {
  vi.mocked(completeText).mockReset();
});

describe("designOrg", () => {
  it("LLM に正しい model/system プロンプトで問い合わせる", async () => {
    vi.mocked(completeText).mockResolvedValue("policy text");
    await designOrg(makeSpec(), {} as LLMClient, "claude-sonnet-4-6");
    const call = vi.mocked(completeText).mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.system).toContain("software QA expert");
  });

  it("spec の appDescription/targetUsers/features をプロンプトに含める", async () => {
    vi.mocked(completeText).mockResolvedValue("x");
    await designOrg(makeSpec({ appDescription: "A unique app desc", targetUsers: "Unique users", features: "Unique features" }), {} as LLMClient, "m");
    const content = vi.mocked(completeText).mock.calls[0][0].userPrompt;
    expect(content).toContain("A unique app desc");
    expect(content).toContain("Unique users");
    expect(content).toContain("Unique features");
  });

  it("designContext があるときプロンプトに含める", async () => {
    vi.mocked(completeText).mockResolvedValue("x");
    await designOrg(makeSpec({ designContext: "Tailwind + Material" }), {} as LLMClient, "m");
    expect(vi.mocked(completeText).mock.calls[0][0].userPrompt).toContain("Tailwind + Material");
  });

  it("coverageSummary があるときプロンプトに含める", async () => {
    vi.mocked(completeText).mockResolvedValue("x");
    await designOrg(makeSpec(), {} as LLMClient, "m", "underrepresented: a11y");
    expect(vi.mocked(completeText).mock.calls[0][0].userPrompt).toContain("underrepresented: a11y");
  });

  it("UNIVERSAL_LENSES を personaGuidance に含める", async () => {
    vi.mocked(completeText).mockResolvedValue("base policy");
    const { personaGuidance } = await designOrg(makeSpec(), {} as LLMClient, "m");
    expect(personaGuidance).toContain("base policy");
    expect(personaGuidance).toContain("Universal Evaluation Lenses");
    for (const lens of UNIVERSAL_LENSES.slice(0, 3)) {
      expect(personaGuidance).toContain(lens.slice(0, 20));
    }
  });

  it("Design Standards Reference を含める", async () => {
    vi.mocked(completeText).mockResolvedValue("x");
    const { personaGuidance } = await designOrg(makeSpec(), {} as LLMClient, "m");
    expect(personaGuidance).toContain("Design Standards Reference");
    expect(personaGuidance).toContain("Apple HIG");
  });
});
