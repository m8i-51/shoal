import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient } from "./llm-client";
import { createMessageWithRetry } from "./agent-loop";
import type { ProductSpec } from "./product-discovery";

export interface OrgDesign {
  personaGuidance: string;
}

// Evaluation lenses always included regardless of app type / アプリ種別に関わらず常に含める観点
export const UNIVERSAL_LENSES = [
  "Accessibility: keyboard navigation, screen reader compatibility, error message clarity, non-color-dependent information, sufficient contrast, focus indicators / アクセシビリティ観点",
  "Security: missing auth checks, input validation gaps, excessive error detail exposure, CSRF exposure, sensitive data in URLs / セキュリティ観点",
  "Business logic: calculation accuracy, status transitions, approval flow correctness, edge case handling in forms / ビジネスロジック観点",
  "Data integrity: UI reflects actual state after actions, silent save failures, optimistic update inconsistencies / データ整合性観点",
  "New user: first-time usability, onboarding clarity, instruction completeness, error recovery, empty state messaging / 新規ユーザー観点",
  "UX design: interaction feedback (loading states, success/error messages), form usability, modal and dialog behavior, navigation consistency, micro-interactions — evaluate against established HCI principles: Fitts's Law (are touch/click targets large and close enough?), Hick's Law (are choices overwhelming?), Miller's Law (is the amount of information shown at once within cognitive limits?), Jakob's Law (does the app behave like similar apps users already know?), Nielsen's heuristics (visibility of system status, error prevention, recognition over recall) / UXデザイン観点",
  "Visual design: spacing and alignment consistency, typography hierarchy, color usage and contrast, component coherence across screens, mobile responsiveness — flag anything that looks broken, cramped, or visually inconsistent / ビジュアルデザイン観点",
  "Product/PM: feature discoverability, user journey clarity, obvious next actions, drop-off risk points, call-to-action prominence, whether the app communicates its value clearly, missing features that users of this type would expect / プロダクト・PM観点",
  "Power user: keyboard shortcuts availability, bulk operations, filtering/sorting depth, export options, API access, customization options / パワーユーザー観点",
  "Mobile/touch: touch target sizes, gesture support, viewport adaptation, thumb-reachable key actions / モバイル・タッチ観点",
];

export async function designOrg(spec: ProductSpec, client: LLMClient, model: string, coverageSummary?: string): Promise<OrgDesign> {
  console.log("\n[persona-policy] starting...");

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

## App type classification
Classify this app as one of:
- "business": used in work contexts by employees with specific job roles (CRM, project management, HR tools, etc.)
- "consumer": used by individuals in personal contexts (personal finance, entertainment, health, productivity, etc.)
- "mixed": significant use in both contexts

## User types for this app
(What kinds of users exist — described appropriately for the app type)

## Agent types to recruit (5–8 types)

**If business app:**
Recruit primarily by job role and function (e.g., sales rep, manager, admin).
Include personas with varying technical literacy within those roles.

**If consumer app:**
Recruit primarily as real end-users — define by lifestyle, demographics, and usage context.
Focus on who actually uses this app in daily life, not job titles.
Examples for a subscription tracker: "budget-conscious student juggling streaming costs", "freelancer tracking SaaS tool expenses", "household manager reviewing family subscriptions".
Avoid professional/specialist titles (QA engineer, PM, auditor) as primary personas — these are not real users of this app.

**If mixed:**
Balance job-role personas and lifestyle-based end-user personas.

**Always include as supplement (1–2 personas regardless of app type):**
- 1 UX evaluator: focuses on visual consistency, interaction patterns, HIG/Material compliance
- 1 edge-case/accessibility evaluator: focuses on error handling, accessibility, stress scenarios

## Recruitment instructions for the persona designer agent
(Concrete guidelines based on the above — emphasize that the majority of personas should reflect real users of this specific app, with expert evaluators as a minority supplement)`,
      },
    ],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  const personaGuidance = `${text}

[Universal Evaluation Lenses]
Include one of the following perspectives in each agent's persona to ensure diverse findings:
${UNIVERSAL_LENSES.map((l) => `- ${l}`).join("\n")}

[Design Standards Reference]
When recruiting UX/design-oriented agents, give them awareness of these standards:
- Apple HIG: clear visual hierarchy, immediate feedback, forgiveness (undo/cancel), consistent navigation, minimal cognitive load
- Material Design: meaningful motion, bold clear typography, responsive layout, accessible color contrast (WCAG AA minimum)
- General web conventions: F-pattern reading, above-the-fold CTAs, error prevention over error recovery, progressive disclosure for complex forms
- HCI principles to apply when exploring:
  - Fitts's Law: notice when important buttons are small, far from natural cursor/thumb position, or hard to tap on mobile
  - Hick's Law: flag screens with too many choices that slow down decision-making
  - Miller's Law: flag when more than ~7 items are shown without grouping or progressive disclosure
  - Jakob's Law: flag interactions that contradict conventions users expect from similar apps (e.g., swipe to delete, pull to refresh, hamburger menus)
  - Nielsen's heuristics: check for missing system status feedback, unclear error messages, lack of undo, and forcing users to recall rather than recognize`;

  console.log("[persona-policy] done");
  return { personaGuidance };
}
