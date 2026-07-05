import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright";

import { runA11yAudit, formatAuditForAgent, type A11yAuditResult } from "../a11y-audit";

function makePage(rawViolations: unknown[]): Page {
  return {
    addScriptTag: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue({ violations: rawViolations }),
    url: () => "http://localhost:3000/items",
  } as unknown as Page;
}

function rawViolation(overrides: Record<string, unknown> = {}) {
  return {
    id: "color-contrast",
    impact: "serious",
    help: "Elements must meet minimum color contrast ratio thresholds",
    helpUrl: "https://dequeuniversity.com/rules/axe/color-contrast",
    nodes: [{ target: [".buy"] }, { target: ["#cta", "button"] }],
    ...overrides,
  };
}

describe("runA11yAudit", () => {
  it("axe を注入し、違反を impact 順に整形して返す", async () => {
    const page = makePage([
      rawViolation({ id: "image-alt", impact: "critical", help: "Images must have alternate text" }),
      rawViolation(), // serious
      rawViolation({ id: "region", impact: "moderate", help: "Content should be in landmarks" }),
    ]);
    const result = await runA11yAudit(page);
    expect(page.addScriptTag).toHaveBeenCalledWith({ content: expect.stringContaining("axe") });
    expect(result.url).toBe("http://localhost:3000/items");
    expect(result.violations.map((v) => v.id)).toEqual(["image-alt", "color-contrast", "region"]);
    expect(result.violations[1].nodes).toEqual([".buy", "#cta button"]);
    expect(result.summary).toContain("3 WCAG violation type(s)");
    expect(result.summary).toContain("critical: 1");
  });

  it("impact が null の違反は minor 扱いにする", async () => {
    const result = await runA11yAudit(makePage([rawViolation({ impact: null })]));
    expect(result.violations[0].impact).toBe("minor");
  });

  it("違反ゼロならその旨のサマリーを返す", async () => {
    const result = await runA11yAudit(makePage([]));
    expect(result.violations).toEqual([]);
    expect(result.summary).toContain("No WCAG violations");
  });

  it("影響要素は 5 件に切り詰める", async () => {
    const nodes = Array.from({ length: 9 }, (_, i) => ({ target: [`#el${i}`] }));
    const result = await runA11yAudit(makePage([rawViolation({ nodes })]));
    expect(result.violations[0].nodes).toHaveLength(5);
  });
});

describe("formatAuditForAgent", () => {
  const makeResult = (count: number): A11yAuditResult => ({
    url: "http://x/",
    violations: Array.from({ length: count }, (_, i) => ({
      id: `rule-${i}`,
      impact: "serious",
      description: `desc ${i}`,
      helpUrl: "",
      nodes: ["#el"],
    })),
    summary: `${count} WCAG violation type(s) on this page (serious: ${count}).`,
  });

  it("違反を evidence 引用の指示付きで列挙する", () => {
    const text = formatAuditForAgent(makeResult(2));
    expect(text).toContain("[serious] rule-0: desc 0");
    expect(text).toContain("evidence");
  });

  it("maxViolations を超えた分は件数表示に丸める", () => {
    const text = formatAuditForAgent(makeResult(10), 8);
    expect(text).toContain("rule-7");
    expect(text).not.toContain("rule-8");
    expect(text).toContain("…and 2 more");
  });

  it("違反ゼロならサマリーのみ", () => {
    expect(formatAuditForAgent(makeResult(0))).toContain("0 WCAG");
  });
});
