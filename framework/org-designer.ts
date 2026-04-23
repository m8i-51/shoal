import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "./llm-client";
import { createMessageWithRetry } from "./agent-loop";
import type { ProductSpec } from "./product-discovery";

export interface OrgDesign {
  hrGuidance: string;
}

// Evaluation lenses always included regardless of app type / アプリ種別に関わらず常に含める観点
export const UNIVERSAL_LENSES = [
  "Accessibility: keyboard navigation, screen reader compatibility, error message clarity, non-color-dependent information, sufficient contrast, focus indicators / アクセシビリティ観点",
  "Security: missing auth checks, input validation gaps, excessive error detail exposure, CSRF exposure, sensitive data in URLs / セキュリティ観点",
  "Business logic: calculation accuracy, status transitions, approval flow correctness, edge case handling in forms / ビジネスロジック観点",
  "Data integrity: UI reflects actual state after actions, silent save failures, optimistic update inconsistencies / データ整合性観点",
  "New user: first-time usability, onboarding clarity, instruction completeness, error recovery, empty state messaging / 新規ユーザー観点",
  "UX design: interaction feedback (loading states, success/error messages), form usability, modal and dialog behavior, navigation consistency, micro-interactions — evaluate against established patterns from Apple HIG and Material Design (clear affordances, immediate feedback, forgiving interactions) / UXデザイン観点",
  "Visual design: spacing and alignment consistency, typography hierarchy, color usage and contrast, component coherence across screens, mobile responsiveness — flag anything that looks broken, cramped, or visually inconsistent / ビジュアルデザイン観点",
  "Product/PM: feature discoverability, user journey clarity, obvious next actions, drop-off risk points, call-to-action prominence, whether the app communicates its value clearly, missing features that users of this type would expect / プロダクト・PM観点",
  "Power user: keyboard shortcuts availability, bulk operations, filtering/sorting depth, export options, API access, customization options / パワーユーザー観点",
  "Mobile/touch: touch target sizes, gesture support, viewport adaptation, thumb-reachable key actions / モバイル・タッチ観点",
];

export async function designOrg(spec: ProductSpec, client: LLMClient, model: string, coverageSummary?: string): Promise<OrgDesign> {
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
${spec.designContext ? `\n[Design Context]\n${spec.designContext}\n` : ""}${coverageSummary ? `\n[Coverage History]\n${coverageSummary}\nUse this to identify underrepresented perspectives and adjust the recruitment policy accordingly.\n` : ""}
Please output the following:

## User types for this app
(What kinds of users exist — roles, skill levels, usage scenarios)

## Agent types to recruit (5–8 types)
By job function, role, and technical literacy. Always include:
- At least one UX/product designer persona (evaluates visual consistency, interaction patterns, HIG/Material compliance)
- At least one product manager or business analyst persona (evaluates feature completeness, user journey clarity)
- At least one target end-user with low technical literacy (first-time or reluctant user)
- Domain-specific roles relevant to this app type

## Recruitment instructions for the HR agent
(Concrete hiring/retirement guidelines based on the above — emphasize persona diversity across technical skill levels, job functions, and design sensitivity)`,
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
${UNIVERSAL_LENSES.map((l) => `- ${l}`).join("\n")}

[Design Standards Reference]
When recruiting UX/design-oriented agents, give them awareness of these standards:
- Apple HIG: clear visual hierarchy, immediate feedback, forgiveness (undo/cancel), consistent navigation, minimal cognitive load
- Material Design: meaningful motion, bold clear typography, responsive layout, accessible color contrast (WCAG AA minimum)
- General web conventions: F-pattern reading, above-the-fold CTAs, error prevention over error recovery, progressive disclosure for complex forms`;

  console.log("[org-design] done");
  return { hrGuidance };
}
