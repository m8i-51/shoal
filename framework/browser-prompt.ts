/**
 * Browser-agent prompt slices that change with persona information.
 * Extracted from run.ts so first-run subtraction is unit-testable:
 * first-run must not receive the spec, goals, or diagnostic-tool instructions.
 */
import type { ProductSpec } from "./product-discovery";
import type { PersonaInformation } from "./persona-contract";

export function formatGoalsSection(spec: Pick<ProductSpec, "appGoals">): string {
  if (!spec.appGoals?.length) return "";
  return `\n[App Goals]\nThese are user/business success conditions (outcomes), not a UI widget checklist. Use category "goal-gap" only when an outcome is blocked. Do not treat missing or mismatched controls (search, filters, sort, badges, etc.) as goal-gap — file those as bug / ux / feature-request instead.\n${spec.appGoals.map((g) => `- ${g}`).join("\n")}\n`;
}

/** App overview or the first-run poverty block. Placed where [App Overview] used to live. */
export function formatAppOverview(spec: Pick<ProductSpec, "appDescription">, information: PersonaInformation): string {
  switch (information) {
    case "first-run":
      return `[What you know]
You have not been briefed on this product. There is no feature list and no goal list in your head.
Use the screen and your behavioral contract. You cannot read page source, console, network, the accessibility tree, or other agents' reports.`;
    case "informed":
      return `[App Overview]
${spec.appDescription}`;
    default: {
      const _exhaustive: never = information;
      return _exhaustive;
    }
  }
}

/** Feature list + design context + goals. Empty for first-run. */
export function formatFeatureReference(
  spec: Pick<ProductSpec, "features" | "designContext" | "appGoals">,
  information: PersonaInformation,
): string {
  switch (information) {
    case "first-run":
      return "";
    case "informed":
      return `[Reference: Implemented Features]
${spec.features}
${spec.designContext ? `\n[Design Context]\n${spec.designContext}\n` : ""}${formatGoalsSection(spec)}`;
    default: {
      const _exhaustive: never = information;
      return _exhaustive;
    }
  }
}

/** Combined brief — used by tests to assert subtraction in one shot. */
export function formatProductBrief(
  spec: Pick<ProductSpec, "appDescription" | "features" | "designContext" | "appGoals">,
  information: PersonaInformation,
): string {
  const overview = formatAppOverview(spec, information);
  const features = formatFeatureReference(spec, information);
  return features ? `${overview}\n\n${features}` : overview;
}

export function formatBrowserToolGuidance(
  information: PersonaInformation,
  opts: { includeApiChecks: boolean },
): string {
  switch (information) {
    case "first-run":
      return `[Using view_screen]
- Call it once right after navigate
- Call it again when you are unsure what changed
- Do not call it repeatedly on the same unchanged page`;
    case "informed":
      return `[Using Observation Tools]
- To verify an action was actually applied, call diff_since_last_action
- If data isn't reflected or errors appear, call read_network_errors
- For unexpected behavior, call read_console_logs to check JS errors
- If problems are found, record them with post_feedback
${opts.includeApiChecks ? `
[Using API Check Tools (tools prefixed with [API check])]
- After a browser action, verify the actual saved state via API
- Data visible in the browser but missing in the API (or vice versa) is an inconsistency bug — report with post_feedback
` : ""}
[Using view_screen]
- Call it once right after navigate
- Do not call it repeatedly on the same page

[Using check_swarm_signals]
- Call it once mid-session to see what other agents exploring this app have reported
- If a signal matches the area you are in, try to reproduce it as YOUR persona — a finding confirmed by different personas becomes a stronger issue
- Report reproductions with post_feedback in your own words; do not copy the other agent's report`;
    default: {
      const _exhaustive: never = information;
      return _exhaustive;
    }
  }
}
