import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "./llm-client";
import { createMessageWithRetry } from "./agent-loop";
import type { ProductSpec } from "./product-discovery";

export interface Scenario {
  id: string;
  title: string;
  context: string;    // Who the user is and their situation
  goal: string;       // What they want to accomplish
  constraints: string; // Special conditions (first-time user, under pressure, etc.)
}

export interface ScenarioOutcome {
  scenarioId: string;
  scenarioTitle: string;
  agentId: string;
  agentName: string;
  achieved: boolean;
  reason: string;
}

const OUTPUT_SCENARIOS_TOOL: Anthropic.Tool = {
  name: "output_scenarios",
  description: "Output the generated test scenarios / 生成したテストシナリオを出力する",
  input_schema: {
    type: "object",
    properties: {
      scenarios: {
        type: "array",
        description: "List of user test scenarios",
        items: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "Short scenario title (e.g. 'New employee submitting first purchase request')",
            },
            context: {
              type: "string",
              description: "Who is this user and what is their situation? (1-2 sentences)",
            },
            goal: {
              type: "string",
              description: "What does the user want to accomplish? (specific and actionable)",
            },
            constraints: {
              type: "string",
              description: "Special conditions: e.g. first time using this feature, in a hurry, unfamiliar with the approval flow, etc.",
            },
          },
          required: ["title", "context", "goal", "constraints"],
        },
      },
    },
    required: ["scenarios"],
  },
};

export async function designScenarios(
  spec: ProductSpec,
  openIssues: { number: number; title: string; labels: string[] }[],
  client: LLMClient,
  model: string,
  count: number = 5,
): Promise<Scenario[]> {
  console.log("\n[scenario-designer] generating scenarios...");

  const issueHints = openIssues.length > 0
    ? `\n[Known Open Issues — risky areas to naturally route scenarios through]\n${openIssues.slice(0, 15).map((i) => `- ${i.title} [${i.labels.join(", ")}]`).join("\n")}`
    : "";

  const response = await createMessageWithRetry(client, {
    model,
    max_tokens: 2048,
    system: `You are a QA scenario designer. Generate realistic user test scenarios for a web app.
Each scenario represents a believable task a real user would attempt — not a bug hunt, but a natural user journey.
Scenarios should collectively cover different user types, app areas, and workflows.`,
    tools: [OUTPUT_SCENARIOS_TOOL],
    messages: [
      {
        role: "user",
        content: `Generate exactly ${count} test scenarios for this app.

[App Overview]
${spec.appDescription}

[Target Users]
${spec.targetUsers}

[Implemented Features]
${spec.features}${spec.uiFeatures ? `\n\n[UI-Only Features]\n${spec.uiFeatures}` : ""}${issueHints}

Guidelines:
- Each scenario should be a realistic user task (not "find the bug")
- Cover different user types: power user, new user, occasional user, manager, etc.
- Cover different app areas and user journeys
- Make goals specific and actionable (not vague like "use the app")
- If open issues hint at risky areas, design natural scenarios that pass through those areas
- Constraints should reflect realistic user states (first time, in a hurry, confused, etc.)

Call output_scenarios with exactly ${count} scenarios.`,
      },
    ],
  });

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "output_scenarios"
  );

  if (!toolUse) {
    console.warn("[scenario-designer] LLM did not call output_scenarios — falling back to lens-only mode");
    return [];
  }

  const raw = toolUse.input as { scenarios: { title: string; context: string; goal: string; constraints: string }[] };

  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    console.warn("[scenario-designer] empty scenarios array returned");
    return [];
  }

  const scenarios: Scenario[] = raw.scenarios.map((s, i) => ({
    id: `scenario_${i + 1}`,
    title: String(s.title),
    context: String(s.context),
    goal: String(s.goal),
    constraints: String(s.constraints),
  }));

  console.log(`[scenario-designer] generated ${scenarios.length} scenarios:`);
  scenarios.forEach((s) => console.log(`  - [${s.id}] ${s.title}`));

  return scenarios;
}
