import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tool-session", () => ({
  captureStructuredTool: vi.fn(),
  completeText: vi.fn(),
  runToolSession: vi.fn(),
}));

import { captureStructuredTool } from "../tool-session";
import { designScenarios, findMultiActorScenario, soloScenarios, pairAgentsToActors, pickBrowserAgents } from "../scenario-designer";
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
  vi.mocked(captureStructuredTool).mockReset();
});

describe("designScenarios", () => {
  it("正しい model/count でリクエストし、scenario_N の id を付与する", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({
      scenarios: [
        { title: "T1", context: "C1", goal: "G1", constraints: "X1" },
        { title: "T2", context: "C2", goal: "G2", constraints: "X2" },
      ],
    });
    const result = await designScenarios(makeSpec(), [], {} as LLMClient, "claude-sonnet-4-6", 2);
    expect(result).toEqual([
      { id: "scenario_1", title: "T1", context: "C1", goal: "G1", constraints: "X1" },
      { id: "scenario_2", title: "T2", context: "C2", goal: "G2", constraints: "X2" },
    ]);
    const call = vi.mocked(captureStructuredTool).mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-4-6");
    expect(call.userPrompt).toContain("Generate exactly 2 test scenarios");
  });

  it("coverageSummary があるときプロンプトに含める", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({ scenarios: [] });
    await designScenarios(makeSpec(), [], {} as LLMClient, "m", 3, "lens X underrepresented");
    expect(vi.mocked(captureStructuredTool).mock.calls[0][0].userPrompt).toContain("lens X underrepresented");
  });

  it("openIssues があるときプロンプトに含める", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({ scenarios: [] });
    await designScenarios(makeSpec(), [{ number: 1, title: "Broken login", labels: ["bug"] }], {} as LLMClient, "m", 3);
    expect(vi.mocked(captureStructuredTool).mock.calls[0][0].userPrompt).toContain("Broken login");
  });

  it("accountRoles が 2 つ以上なら multi-actor ヒントを含める", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({ scenarios: [] });
    await designScenarios(makeSpec(), [], {} as LLMClient, "m", 3, undefined, ["admin", "user"]);
    expect(vi.mocked(captureStructuredTool).mock.calls[0][0].userPrompt).toContain("multi-actor");
  });

  it("accountRoles が 1 つ以下なら multi-actor ヒントを含めない", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({ scenarios: [] });
    await designScenarios(makeSpec(), [], {} as LLMClient, "m", 3, undefined, ["admin"]);
    expect(vi.mocked(captureStructuredTool).mock.calls[0][0].userPrompt).not.toContain("multi-actor");
  });

  it("tool 呼び出しが無い場合は空配列", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue(null);
    expect(await designScenarios(makeSpec(), [], {} as LLMClient, "m", 3)).toEqual([]);
  });

  it("scenarios が空配列なら空を返す", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({ scenarios: [] });
    expect(await designScenarios(makeSpec(), [], {} as LLMClient, "m", 3)).toEqual([]);
  });

  it("uiFeatures をプロンプトに含める", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({ scenarios: [] });
    await designScenarios(makeSpec({ uiFeatures: "Dark mode toggle" }), [], {} as LLMClient, "m", 3);
    expect(vi.mocked(captureStructuredTool).mock.calls[0][0].userPrompt).toContain("Dark mode toggle");
  });

  it("2 actors があるシナリオは actors を付ける", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({
      scenarios: [{
        title: "Race",
        context: "C",
        goal: "G",
        constraints: "X",
        actors: [
          { role: "admin", goal: "revoke" },
          { role: "user", goal: "edit" },
        ],
      }],
    });
    const result = await designScenarios(makeSpec(), [], {} as LLMClient, "m", 1);
    expect(result[0].actors).toEqual([
      { role: "admin", goal: "revoke" },
      { role: "user", goal: "edit" },
    ]);
  });

  it("actors が 1 人だけなら actors を付けない", async () => {
    vi.mocked(captureStructuredTool).mockResolvedValue({
      scenarios: [{
        title: "Solo",
        context: "C",
        goal: "G",
        constraints: "X",
        actors: [{ role: "admin", goal: "do stuff" }],
      }],
    });
    const result = await designScenarios(makeSpec(), [], {} as LLMClient, "m", 1);
    expect(result[0].actors).toBeUndefined();
  });
});

describe("findMultiActorScenario / soloScenarios", () => {
  it("2 actors のシナリオを見つける", () => {
    const scenarios = [
      { id: "s1", title: "a", context: "", goal: "", constraints: "" },
      { id: "s2", title: "b", context: "", goal: "", constraints: "", actors: [{ role: "a", goal: "x" }, { role: "b", goal: "y" }] },
    ];
    expect(findMultiActorScenario(scenarios)?.id).toBe("s2");
    expect(soloScenarios(scenarios).map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("pairAgentsToActors", () => {
  it("role 親和度でペアリングする", () => {
    const agents = [
      { id: "1", name: "A", role: "admin" },
      { id: "2", name: "B", role: "user" },
    ];
    const scenario = {
      id: "s",
      title: "t",
      context: "",
      goal: "",
      constraints: "",
      actors: [
        { role: "admin", goal: "g1" },
        { role: "user", goal: "g2" },
      ],
    };
    const paired = pairAgentsToActors(agents, scenario);
    expect(paired.get("1")?.role).toBe("admin");
    expect(paired.get("2")?.role).toBe("user");
  });
});

describe("pickBrowserAgents", () => {
  it("actorRoles に合うエージェントを優先する", () => {
    const agents = [
      { id: "1", name: "A", role: "user" },
      { id: "2", name: "B", role: "admin" },
      { id: "3", name: "C", role: "viewer" },
    ];
    const picked = pickBrowserAgents(agents, 2, ["admin"], () => 0);
    expect(picked[0].role).toBe("admin");
    expect(picked).toHaveLength(2);
  });
});
