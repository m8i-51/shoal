import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";

vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof path>();
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

import { generateReport } from "../report";
import type { RunLog, Finding } from "../types";
import type { TriageResult } from "../triage";
import type { ProductSpec } from "../product-discovery";

function getSavedHtml(): string {
  const calls = vi.mocked(fs.writeFileSync).mock.calls;
  return calls[calls.length - 1][1] as string;
}

function makeRunLog(overrides: Partial<RunLog> = {}): RunLog {
  return {
    runId: "run_test",
    startedAt: "2026-04-27T00:00:00.000Z",
    completedAt: "2026-04-27T00:05:00.000Z",
    repo: "",
    agents: [],
    summary: {
      totalAgents: 0,
      completed: 0,
      errors: 0,
      iterationLimitReached: 0,
      totalActions: 0,
      totalIssuesPosted: 0,
      regressionChecked: 0,
      regressionFailed: 0,
      rateLimitRetries: 0,
    },
    ...overrides,
  };
}

function makeProductSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    appName: "Test App",
    appDescription: "A test application",
    targetUsers: "Engineers",
    features: "Login, Dashboard",
    designContext: "",
    uiFeatures: "",
    confidence: "high",
    sources: [],
    ...overrides,
  };
}

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    runId: "run_test",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    category: "bug",
    title: "Login button broken",
    body: "Clicking login does nothing",
    timestamp: "2026-04-27T00:01:00.000Z",
    ...overrides,
  };
}

const emptyTriage: TriageResult = { issued: [], skipped: [], unprocessed: [], issuesCreated: 0 };

describe("generateReport", () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
    vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  });

  it("ファイルパスを返す", () => {
    const result = generateReport(makeRunLog(), [], emptyTriage, makeProductSpec(), [], new Map());
    expect(result).toContain("report_run_test.html");
  });

  it("有効な HTML をファイルに書き出す", () => {
    generateReport(makeRunLog(), [], emptyTriage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("</html>");
  });

  it("アプリ名がレポートに含まれる", () => {
    generateReport(makeRunLog(), [], emptyTriage, makeProductSpec({ appName: "MySpecialApp" }), [], new Map());
    expect(getSavedHtml()).toContain("MySpecialApp");
  });

  it("finding のタイトルが HTML エスケープされる", () => {
    const finding = makeFinding({ title: "XSS <script>alert(1)</script>" });
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("issued finding に → Issue バッジが付く", () => {
    const finding = makeFinding({ id: "f1" });
    const triage: TriageResult = { issued: ["f1"], skipped: [], unprocessed: [], issuesCreated: 1 };
    generateReport(makeRunLog(), [finding], triage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).toContain("→ Issue");
  });

  it("skipped finding に skipped バッジが付く", () => {
    const finding = makeFinding({ id: "f1" });
    const triage: TriageResult = { issued: [], skipped: ["f1"], unprocessed: [], issuesCreated: 0 };
    generateReport(makeRunLog(), [finding], triage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).toContain("skipped");
  });

  it("シナリオ付きの finding にシナリオタグが付く", () => {
    const finding = makeFinding({ agentId: "a1" });
    const scenario = { id: "s1", title: "New employee task", context: "", goal: "", constraints: "" };
    const agentAssignments = new Map([["a1", { scenario }]]);
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [scenario], agentAssignments);
    const html = getSavedHtml();
    expect(html).toContain("New employee task");
    expect(html).toContain("scenario");
  });

  it("レンズ付きの finding にレンズタグが付く", () => {
    const finding = makeFinding({ agentId: "a1" });
    const agentAssignments = new Map([["a1", { lens: "Accessibility: keyboard navigation" }]]);
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], agentAssignments);
    const html = getSavedHtml();
    expect(html).toContain("Accessibility");
    expect(html).toContain("lens");
  });

  it("finding が issued → unprocessed → skipped の順に並ぶ", () => {
    const f1 = makeFinding({ id: "f1", title: "Issued Finding" });
    const f2 = makeFinding({ id: "f2", title: "Skipped Finding" });
    const f3 = makeFinding({ id: "f3", title: "Unprocessed Finding" });
    const triage: TriageResult = { issued: ["f1"], skipped: ["f2"], unprocessed: ["f3"], issuesCreated: 1 };
    generateReport(makeRunLog(), [f2, f3, f1], triage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    const issuedPos = html.indexOf("Issued Finding");
    const unprocessedPos = html.indexOf("Unprocessed Finding");
    const skippedPos = html.indexOf("Skipped Finding");
    expect(issuedPos).toBeLessThan(unprocessedPos);
    expect(unprocessedPos).toBeLessThan(skippedPos);
  });
});
