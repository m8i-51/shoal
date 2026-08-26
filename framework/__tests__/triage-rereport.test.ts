import { describe, it, expect, vi } from "vitest";
import {
  isReturningUserReReport,
  findMatchingOpenIssue,
  formatReReportComment,
  commentReturningUserReReports,
} from "../triage-rereport";
import type { Finding } from "../types";
import type { IssueTracker } from "../trackers/index";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    runId: "run_test",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Checkout still broken",
    body: "The checkout button is still broken since last visit.",
    category: "bug",
    timestamp: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isReturningUserReReport", () => {
  it("再訪・未改善パターンを検出する", () => {
    expect(isReturningUserReReport(makeFinding())).toBe(true);
    expect(isReturningUserReReport(makeFinding({ body: "前回から変わっていない" }))).toBe(true);
  });

  it("通常の初回報告は false", () => {
    expect(isReturningUserReReport(makeFinding({
      title: "Login button unresponsive",
      body: "I tapped login and nothing happened.",
    }))).toBe(false);
  });
});

describe("findMatchingOpenIssue", () => {
  it("タイトルが類似する open issue を返す", () => {
    const match = findMatchingOpenIssue(makeFinding(), [
      { number: 42, title: "[bug] Checkout still broken", labels: [] },
    ]);
    expect(match?.number).toBe(42);
  });

  it("類似 issue がなければ null", () => {
    expect(findMatchingOpenIssue(makeFinding(), [
      { number: 1, title: "Dark mode missing", labels: [] },
    ])).toBeNull();
  });
});

describe("formatReReportComment", () => {
  it("finding 本文と run 情報を含む", () => {
    const text = formatReReportComment(makeFinding());
    expect(text).toContain("Returning-user re-report");
    expect(text).toContain("still broken since last visit");
    expect(text).toContain("run_test");
  });
});

describe("commentReturningUserReReports", () => {
  it("マッチした re-report をコメントし triage 対象から除外する", async () => {
    const tracker: IssueTracker = {
      name: "fake",
      isEmpty: false,
      createIssue: vi.fn(),
      fetchOpenIssues: vi.fn(),
      fetchClosedIssues: vi.fn(),
      commentOnIssue: vi.fn().mockResolvedValue(true),
    };

    const { results, remaining } = await commentReturningUserReReports(
      [makeFinding({ id: "f1" }), makeFinding({ id: "f2", title: "New bug", body: "fresh issue" })],
      [{ number: 7, title: "Checkout still broken", labels: [] }],
      tracker,
    );

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ findingId: "f1", issueNumber: 7, commented: true });
    expect(tracker.commentOnIssue).toHaveBeenCalledWith(7, expect.stringContaining("Returning-user re-report"));
    expect(remaining.map((f) => f.id)).toEqual(["f2"]);
  });

  it("tracker が空または open issue がなければ何もしない", async () => {
    const tracker: IssueTracker = {
      name: "fake",
      isEmpty: true,
      createIssue: vi.fn(),
      fetchOpenIssues: vi.fn(),
      fetchClosedIssues: vi.fn(),
      commentOnIssue: vi.fn(),
    };
    const findings = [makeFinding()];
    expect(await commentReturningUserReReports(findings, [], tracker)).toEqual({ results: [], remaining: findings });
  });
});
