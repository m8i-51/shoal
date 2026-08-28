import { describe, it, expect } from "vitest";
import { issueLooksUiOnly, partitionClosedIssues, regressionMaxIterations } from "../regression-issue";

describe("issueLooksUiOnly", () => {
  it("treats ux/ui labels as UI-only", () => {
    expect(issueLooksUiOnly({ title: "Broken thing", labels: ["ux"] })).toBe(true);
    expect(issueLooksUiOnly({ title: "Broken thing", labels: ["bug", "a11y"] })).toBe(true);
  });

  it("treats OAuth / theme / hamburger text as UI-only when there is no API evidence", () => {
    expect(issueLooksUiOnly({ title: "Theme toggle does not persist", body: "Dark mode reverts" })).toBe(true);
    expect(issueLooksUiOnly({ title: "Hamburger does not open on mobile", body: "" })).toBe(true);
  });

  it("does not treat API failures as UI-only even if a button is mentioned", () => {
    expect(issueLooksUiOnly({
      title: "Save button returns 500",
      body: "POST /api/items endpoint status code 500",
    })).toBe(false);
  });

  it("leaves unlabeled API bugs as API", () => {
    expect(issueLooksUiOnly({ title: "List items returns empty JSON", body: "GET /api/items" })).toBe(false);
  });
});

describe("partitionClosedIssues", () => {
  it("splits a mixed list", () => {
    const issues = [
      { title: "Theme toggle broken", body: "", labels: ["ux"] },
      { title: "GET /api/me 403", body: "endpoint", labels: ["bug"] },
    ];
    const { ui, api } = partitionClosedIssues(issues);
    expect(ui).toHaveLength(1);
    expect(api).toHaveLength(1);
    expect(api[0].title).toContain("/api/me");
  });
});

describe("regressionMaxIterations", () => {
  it("scales with closed-issue count and caps", () => {
    expect(regressionMaxIterations(0)).toBe(12);
    expect(regressionMaxIterations(1)).toBe(12);
    expect(regressionMaxIterations(8)).toBe(16);
    expect(regressionMaxIterations(40)).toBe(30);
  });
});
