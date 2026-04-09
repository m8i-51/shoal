import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "./llm-client";
import { createMessageWithRetry } from "./agent-loop";
import type { ProductSpec } from "./product-discovery";

export interface OrgDesign {
  hrGuidance: string;
}

// Evaluation lenses always included regardless of app type / アプリ種別に関わらず常に含める観点
export const UNIVERSAL_LENSES = [
  "Accessibility: keyboard navigation, error message clarity, non-color-dependent information / アクセシビリティ観点",
  "Security: missing auth checks, input validation gaps, excessive error detail exposure / セキュリティ観点",
  "Business logic: calculation accuracy, status transitions, approval flow correctness / ビジネスロジック観点",
  "Data integrity: UI reflects actual state after actions, silent save failures / データ整合性観点",
  "New user: first-time usability, instruction clarity, error recovery / 新規ユーザー観点",
];

export async function designOrg(spec: ProductSpec, client: LLMClient, model: string): Promise<OrgDesign> {
  console.log("\n[org-design] starting...");

  const response = await createMessageWithRetry(client, {
    model,
    max_tokens: 1024,
    system: `You are a software QA expert.
Given an app specification, infer the organization and user base,
then define an agent recruitment policy for testing.`,
    tools: [],
    messages: [
      {
        role: "user",
        content: `Design a test agent recruitment policy for the following app.

[App Overview]
${spec.appDescription}

[Target Users]
${spec.targetUsers}

[Implemented Features]
${spec.features}

Please output the following:

## User types for this app
(What kinds of users exist — roles, skill levels, usage scenarios)

## Agent types to recruit (5–8 types)
(By job function, role, and technical literacy. Include both power users and struggling users)

## Recruitment instructions for the HR agent
(Concrete hiring/retirement guidelines based on the above)`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const hrGuidance = `${text}

[Universal Evaluation Lenses]
Include one of the following perspectives in each agent's persona to ensure diverse findings:
${UNIVERSAL_LENSES.map((l) => `- ${l}`).join("\n")}`;

  console.log("[org-design] done");
  return { hrGuidance };
}
