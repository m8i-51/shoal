import { describe, it, expect } from "vitest";
import { formatProductBrief, formatBrowserToolGuidance } from "../browser-prompt";
import { browserTools, browserToolsForInformation, FIRST_RUN_BROWSER_TOOL_NAMES } from "../agent-tools";
import type { ProductSpec } from "../product-discovery";

const spec: Pick<ProductSpec, "appDescription" | "features" | "designContext" | "appGoals"> = {
  appDescription: "UNIQUE_APP_OVERVIEW_xyz",
  features: "SECRET_FEATURE_LIST_xyz",
  designContext: "SECRET_DESIGN_xyz",
  appGoals: ["SECRET_GOAL_xyz"],
};

describe("formatProductBrief", () => {
  it("includes overview, features, and goals for informed agents", () => {
    const text = formatProductBrief(spec, "informed");
    expect(text).toContain("UNIQUE_APP_OVERVIEW_xyz");
    expect(text).toContain("SECRET_FEATURE_LIST_xyz");
    expect(text).toContain("SECRET_GOAL_xyz");
    expect(text).toContain("[Reference: Implemented Features]");
    expect(text).toContain("[App Goals]");
  });

  it("omits the spec, feature list, and goals for first-run agents", () => {
    const text = formatProductBrief(spec, "first-run");
    expect(text).toContain("[What you know]");
    expect(text).not.toContain("UNIQUE_APP_OVERVIEW_xyz");
    expect(text).not.toContain("SECRET_FEATURE_LIST_xyz");
    expect(text).not.toContain("SECRET_DESIGN_xyz");
    expect(text).not.toContain("SECRET_GOAL_xyz");
    expect(text).not.toContain("Implemented Features");
  });
});

describe("formatBrowserToolGuidance", () => {
  it("teaches diagnostic tools only to informed agents", () => {
    const informed = formatBrowserToolGuidance("informed", { includeApiChecks: true });
    expect(informed).toContain("read_network_errors");
    expect(informed).toContain("check_swarm_signals");
    expect(informed).toContain("[API check]");

    const firstRun = formatBrowserToolGuidance("first-run", { includeApiChecks: true });
    expect(firstRun).toContain("view_screen");
    expect(firstRun).not.toContain("read_network_errors");
    expect(firstRun).not.toContain("check_swarm_signals");
    expect(firstRun).not.toContain("[API check]");
    expect(firstRun).not.toContain("read_page_text");
  });
});

describe("browserToolsForInformation", () => {
  const apiTool = {
    name: "list_items",
    description: "List items",
    input_schema: { type: "object" as const, properties: {}, required: [] as string[] },
  };
  const all = browserTools([apiTool], true);

  it("keeps the full set for informed agents", () => {
    expect(browserToolsForInformation(all, "informed")).toBe(all);
    expect(all.map((t) => t.name)).toEqual(expect.arrayContaining([
      "list_items",
      "read_page_text",
      "read_accessibility_tree",
      "read_console_logs",
      "read_network_errors",
      "diff_since_last_action",
      "run_a11y_audit",
      "check_swarm_signals",
      "view_screen",
      "click",
    ]));
  });

  it("keeps only screen tools for first-run and drops API checks", () => {
    const filtered = browserToolsForInformation(all, "first-run");
    expect(filtered.map((t) => t.name).sort()).toEqual([...FIRST_RUN_BROWSER_TOOL_NAMES].sort());
    expect(filtered.some((t) => t.name === "list_items")).toBe(false);
    expect(filtered.some((t) => (t.description ?? "").startsWith("[API check]"))).toBe(false);
    const click = filtered.find((t) => t.name === "click");
    expect(click?.description).not.toMatch(/accessibility/i);
    expect(click?.description).not.toMatch(/ref/i);
  });
});
