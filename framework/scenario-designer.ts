import type { LLMClient } from "./llm-client";
import { captureStructuredTool } from "./tool-session";
import type { ProductSpec } from "./product-discovery";
import { findBestByRole, roleAffinity } from "./role-match";

export interface ScenarioActor {
  role: string; // e.g. "admin", "user" — should match an available test account role
  goal: string; // what THIS actor tries to accomplish
}

export interface Scenario {
  id: string;
  title: string;
  context: string;    // Who the user is and their situation
  goal: string;       // What they want to accomplish
  constraints: string; // Special conditions (first-time user, under pressure, etc.)
  /** Multi-actor scenario: two users act on the same data at the same time (concurrency / permission testing) */
  actors?: ScenarioActor[];
}

/** 2 アクター揃ったマルチアクターシナリオだけを返す */
export function findMultiActorScenario(scenarios: Scenario[]): Scenario | undefined {
  return scenarios.find((s) => (s.actors?.length ?? 0) >= 2);
}

/** 通常のディスパッチに使う単独シナリオ（マルチアクターを除外） */
export function soloScenarios(scenarios: Scenario[]): Scenario[] {
  return scenarios.filter((s) => (s.actors?.length ?? 0) < 2);
}

export type RoleBearer = { id: string; name: string; role: string };

/**
 * ペルソナ role と actor role の親和度が最大になる 2 体を選ぶ。
 * 枠順（配列の先頭から）では割り当てない。
 */
export function pairAgentsToActors<T extends RoleBearer>(
  agents: T[],
  scenario: Scenario,
): Map<string, ScenarioActor & { partnerRole: string }> {
  const paired = new Map<string, ScenarioActor & { partnerRole: string }>();
  const actors = scenario.actors;
  if (!actors || actors.length < 2 || agents.length < 2) return paired;

  const [actorA, actorB] = actors;
  let bestScore = -1;
  let best: [T, T] | null = null;
  for (const agentA of agents) {
    for (const agentB of agents) {
      if (agentA.id === agentB.id) continue;
      const score = roleAffinity(agentA.role, actorA.role) + roleAffinity(agentB.role, actorB.role);
      if (score > bestScore) {
        bestScore = score;
        best = [agentA, agentB];
      }
    }
  }
  if (!best) return paired;

  paired.set(best[0].id, { ...actorA, partnerRole: actorB.role });
  paired.set(best[1].id, { ...actorB, partnerRole: actorA.role });
  return paired;
}

/** マルチアクターの role に合うエージェントを先にブラウザ枠へ入れ、残りをランダムに埋める */
export function pickBrowserAgents<T extends RoleBearer>(
  agents: T[],
  count: number,
  actorRoles: string[] = [],
  random: () => number = Math.random,
): T[] {
  if (count <= 0 || agents.length === 0) return [];
  const remaining = [...agents];
  const selected: T[] = [];

  for (const role of actorRoles) {
    if (selected.length >= count) break;
    const match = findBestByRole(remaining, role);
    if (!match) continue;
    const idx = remaining.findIndex((a) => a.id === match.id);
    if (idx >= 0) selected.push(remaining.splice(idx, 1)[0]);
  }

  while (selected.length < count && remaining.length > 0) {
    const idx = Math.floor(random() * remaining.length);
    selected.push(remaining.splice(idx, 1)[0]);
  }
  return selected;
}

export interface ScenarioOutcome {
  scenarioId: string;
  scenarioTitle: string;
  agentId: string;
  agentName: string;
  achieved: boolean;
  reason: string;
  iterations?: number; // post_outcome 呼び出し時点のエージェントのイテレーション数（タスク完了までの手数）
}

const OUTPUT_SCENARIOS_TOOL = {
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
            actors: {
              type: "array",
              description: "ONLY for a multi-actor scenario: exactly 2 actors who use the app AT THE SAME TIME on the same data (e.g. an admin changing permissions while a user is mid-task, or two users editing the same record). Each actor's role should match an available test account role. Omit for normal single-user scenarios.",
              items: {
                type: "object",
                properties: {
                  role: { type: "string", description: "Actor's role — should match an available test account role" },
                  goal: { type: "string", description: "What this actor tries to accomplish, concurrently with the other actor" },
                },
                required: ["role", "goal"],
              },
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
  openIssues: { number: number | string; title: string; labels: string[] }[],
  client: LLMClient,
  model: string,
  count: number = 5,
  coverageSummary?: string,
  accountRoles: string[] = [],
): Promise<Scenario[]> {
  console.log("\n[scenario-designer] generating scenarios...");

  const issueHints = openIssues.length > 0
    ? `\n[Known Open Issues — risky areas to naturally route scenarios through]\n${openIssues.slice(0, 15).map((i) => `- ${i.title} [${i.labels.join(", ")}]`).join("\n")}`
    : "";

  const coverageHints = coverageSummary
    ? `\n[Coverage History — adjust scenarios to explore underrepresented areas]\n${coverageSummary}`
    : "";

  const distinctRoles = [...new Set(accountRoles)];
  const multiActorHint = distinctRoles.length >= 2
    ? `\n[Available Test Account Roles]\n${distinctRoles.map((r) => `- ${r}`).join("\n")}\nSince multiple roles are available, make EXACTLY ONE scenario a multi-actor scenario: set its "actors" field to 2 actors (roles from the list above) who use the app AT THE SAME TIME in a way that could conflict — e.g. an admin revoking access while a user is mid-flow, or two users editing the same record concurrently.`
    : "";

  const raw = await captureStructuredTool<{
    scenarios: { title: string; context: string; goal: string; constraints: string; actors?: { role: string; goal: string }[] }[];
  }>({
    provider: process.env.LLM_PROVIDER ?? "anthropic",
    client,
    model,
    maxTokens: 2048,
    system: `You are a QA scenario designer. Generate realistic user test scenarios for a web app.
Each scenario represents a believable task a real user would attempt — not a bug hunt, but a natural user journey.
Scenarios should collectively cover different user types, app areas, and workflows.`,
    userPrompt: `Generate exactly ${count} test scenarios for this app.

[App Overview]
${spec.appDescription}

[Target Users]
${spec.targetUsers}

[Implemented Features]
${spec.features}${spec.uiFeatures ? `\n\n[UI-Only Features]\n${spec.uiFeatures}` : ""}${issueHints}${coverageHints}${multiActorHint}

Guidelines:
- Each scenario should be a realistic user task (not "find the bug")
- Cover different user types: power user, new user, occasional user, manager, etc.
- Cover different app areas and user journeys
- Make goals specific and actionable (not vague like "use the app")
- If open issues hint at risky areas, design natural scenarios that pass through those areas
- If coverage history shows underrepresented areas or lenses, bias scenarios toward those gaps
- If coverage history shows previous runs (this is NOT the first run), include exactly one RETURNING-USER scenario: a user coming back to data they created before — resuming a draft, reviewing accumulated items, checking what changed since their last visit
- Constraints should reflect realistic user states (first time, in a hurry, confused, etc.)

Call output_scenarios with exactly ${count} scenarios.`,
    tool: {
      ...OUTPUT_SCENARIOS_TOOL,
      execute: async () => "ok",
    },
  });

  if (!raw) {
    console.warn("[scenario-designer] LLM did not call output_scenarios — falling back to lens-only mode");
    return [];
  }

  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) {
    console.warn("[scenario-designer] empty scenarios array returned");
    return [];
  }

  const scenarios: Scenario[] = raw.scenarios.map((s, i) => {
    const actors = Array.isArray(s.actors)
      ? s.actors
          .filter((a) => a && typeof a.role === "string" && typeof a.goal === "string")
          .slice(0, 2)
          .map((a) => ({ role: String(a.role), goal: String(a.goal) }))
      : [];
    return {
      id: `scenario_${i + 1}`,
      title: String(s.title),
      context: String(s.context),
      goal: String(s.goal),
      constraints: String(s.constraints),
      ...(actors.length === 2 ? { actors } : {}),
    };
  });

  console.log(`[scenario-designer] generated ${scenarios.length} scenarios:`);
  scenarios.forEach((s) => console.log(`  - [${s.id}] ${s.title}${s.actors ? ` (multi-actor: ${s.actors.map((a) => a.role).join(" × ")})` : ""}`));

  return scenarios;
}
