import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { AgentLog, RegressionCheck } from "../types";
import type { ScenarioOutcome } from "../scenario-designer";

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
      cost: { inputTokens: 0, outputTokens: 0, estimatedUSD: null },
    },
    ...overrides,
  };
}

function makeAgentLog(overrides: Partial<AgentLog> = {}): AgentLog {
  return {
    agentId: "a1",
    agentName: "Alice",
    agentType: "explorer",
    role: "tester",
    status: "completed",
    iterations: 3,
    actions: [],
    visitedPaths: [],
    issuesPosted: [],
    regressionChecks: [],
    error: null,
    startedAt: "2026-04-27T00:01:00.000Z",
    completedAt: "2026-04-27T00:03:00.000Z",
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
    appGoals: [],
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

const emptyTriage: TriageResult = { issued: [], skipped: [], unprocessed: [], issuesCreated: 0, edgeRisks: [], issues: [], skips: [] };

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

  it("tracePath があり trace ファイルが存在する finding には再生ヒントを表示する", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const finding = makeFinding({ tracePath: "logs/traces/run_test/a1.zip" });
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    expect(html).toContain("npx playwright show-trace logs/traces/run_test/a1.zip");
  });

  it("trace ファイルが存在しない場合はヒントを表示しない", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const finding = makeFinding({ tracePath: "logs/traces/run_test/a1.zip" });
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).not.toContain("show-trace");
  });

  it("experience score が渡されるとスコアカードを表示する", () => {
    const runExp = { runId: "run_test", timestamp: "2026-04-27T00:00:00.000Z", score: 82, achievementRate: 0.8, avgIterations: 5, regressionRate: null };
    generateReport(makeRunLog(), [], emptyTriage, makeProductSpec(), [], new Map(), [], { latest: runExp, delta: 7, trend: [runExp] });
    const html = getSavedHtml();
    expect(html).toContain("experience score");
    expect(html).toContain("82");
    expect(html).toContain("▲7");
  });

  it("experience score が null のときはスコアカードを表示しない", () => {
    generateReport(makeRunLog(), [], emptyTriage, makeProductSpec(), [], new Map(), [], null);
    expect(getSavedHtml()).not.toContain("experience score");
  });

  it("finding のタイトルが HTML エスケープされる", () => {
    const finding = makeFinding({ title: "XSS <script>alert(1)</script>" });
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("finding の body が HTML エスケープされる", () => {
    const finding = makeFinding({ body: 'Click <a href="javascript:void(0)" onclick="steal()">here</a>' });
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    expect(html).not.toContain("<a href=");
    expect(html).toContain("&lt;a href=");
  });

  it.each([
    ["bug", "#dc2626"],
    ["ux", "#c2410c"],
    ["feature-request", "#2563eb"],
    ["goal-gap", "#6b7280"],
  ])("category=%s は対応する色を使う", (category, color) => {
    const finding = makeFinding({ category });
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).toContain(color);
  });

  it("screenshotPath があり画像が存在する場合は base64 で埋め込む", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith(".png")) return Buffer.from("fake-png-bytes");
      return "{}" as unknown as ReturnType<typeof fs.readFileSync>;
    });
    const finding = makeFinding({ screenshotPath: "/tmp/shot.png" });
    generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    expect(html).toContain("data:image/png;base64,");
  });

  it("screenshotPath があるが画像ファイルが存在しない場合は埋め込まない", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const finding = makeFinding({ screenshotPath: "/tmp/missing.png" });
    expect(() => generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map())).not.toThrow();
    const html = getSavedHtml();
    expect(html).not.toContain("data:image/png;base64,");
  });

  it("画像読み込みで例外が起きても埋め込まずレポート生成は継続する", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockImplementation((p: unknown) => {
      if (String(p).endsWith(".png")) throw new Error("EACCES");
      return "{}" as unknown as ReturnType<typeof fs.readFileSync>;
    });
    const finding = makeFinding({ screenshotPath: "/tmp/broken.png" });
    expect(() => generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map())).not.toThrow();
    const html = getSavedHtml();
    expect(html).not.toContain("data:image/png;base64,");
  });

  it("issued finding に → Issue バッジが付く", () => {
    const finding = makeFinding({ id: "f1" });
    const triage: TriageResult = { issued: ["f1"], skipped: [], unprocessed: [], issuesCreated: 1, edgeRisks: [], issues: [], skips: [] };
    generateReport(makeRunLog(), [finding], triage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).toContain("→ Issue");
  });

  it("skipped finding に skipped バッジが付く", () => {
    const finding = makeFinding({ id: "f1" });
    const triage: TriageResult = { issued: [], skipped: ["f1"], unprocessed: [], issuesCreated: 0, edgeRisks: [], issues: [], skips: [] };
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

  it("エージェントテーブルにエージェント名と status が含まれる", () => {
    const agent = makeAgentLog({ agentName: "Bob", status: "completed" });
    generateReport(makeRunLog({ agents: [agent] }), [], emptyTriage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    expect(html).toContain("Bob");
    expect(html).toContain("completed");
  });

  it("regression エージェントに regression バッジが付く", () => {
    const agent = makeAgentLog({ agentType: "regression" });
    generateReport(makeRunLog({ agents: [agent] }), [], emptyTriage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).toContain("regression");
  });

  it("browser エージェントに browser バッジが付く", () => {
    const agent = makeAgentLog({ agentType: "browser" });
    generateReport(makeRunLog({ agents: [agent] }), [], emptyTriage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).toContain("browser");
  });

  it("regression checks がある場合 Progress セクションが表示される", () => {
    const checks: RegressionCheck[] = [
      { issueNumber: 42, issueTitle: "Login button broken", status: "fixed", note: "", regressionUrl: null },
    ];
    const agent = makeAgentLog({ agentType: "regression", regressionChecks: checks });
    generateReport(makeRunLog({ agents: [agent] }), [], emptyTriage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    expect(html).toContain("Progress");
    expect(html).toContain("#42");
    expect(html).toContain("Login button broken");
    expect(html).toContain("✓ fixed");
  });

  it("regression が再発した場合 regressed バッジが表示される", () => {
    const checks: RegressionCheck[] = [
      { issueNumber: 7, issueTitle: "Crash on submit", status: "regressed", note: "", regressionUrl: null },
    ];
    const agent = makeAgentLog({ agentType: "regression", regressionChecks: checks });
    generateReport(makeRunLog({ agents: [agent] }), [], emptyTriage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).toContain("⚠ regressed");
  });

  it("regression が複数再発した場合は複数形（regressions）で表示される", () => {
    const checks: RegressionCheck[] = [
      { issueNumber: 7, issueTitle: "Crash on submit", status: "regressed", note: "", regressionUrl: null },
      { issueNumber: 8, issueTitle: "Logout fails", status: "regressed", note: "", regressionUrl: null },
    ];
    const agent = makeAgentLog({ agentType: "regression", regressionChecks: checks });
    generateReport(makeRunLog({ agents: [agent] }), [], emptyTriage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).toContain("2 regressions detected");
  });

  it("regression checks がない場合 Progress セクションは表示されない", () => {
    generateReport(makeRunLog(), [], emptyTriage, makeProductSpec(), [], new Map());
    expect(getSavedHtml()).not.toContain("Progress (");
  });

  it("ScenarioOutcomes が achieved の場合 achieved バッジが表示される", () => {
    const outcomes: ScenarioOutcome[] = [{
      scenarioId: "s1",
      scenarioTitle: "New employee task",
      agentId: "a1",
      agentName: "Alice",
      achieved: true,
      reason: "Completed successfully",
    }];
    generateReport(makeRunLog(), [], emptyTriage, makeProductSpec(), [], new Map(), outcomes);
    const html = getSavedHtml();
    expect(html).toContain("Scenario Outcomes");
    expect(html).toContain("achieved");
    expect(html).toContain("New employee task");
  });

  it("ScenarioOutcomes が failed の場合 failed バッジが表示される", () => {
    const outcomes: ScenarioOutcome[] = [{
      scenarioId: "s1",
      scenarioTitle: "Purchase flow",
      agentId: "a1",
      agentName: "Bob",
      achieved: false,
      reason: "Could not find the button",
    }];
    generateReport(makeRunLog(), [], emptyTriage, makeProductSpec(), [], new Map(), outcomes);
    expect(getSavedHtml()).toContain("failed");
  });

  it("finding が issued → unprocessed → skipped の順に並ぶ", () => {
    const f1 = makeFinding({ id: "f1", title: "Issued Finding" });
    const f2 = makeFinding({ id: "f2", title: "Skipped Finding" });
    const f3 = makeFinding({ id: "f3", title: "Unprocessed Finding" });
    const triage: TriageResult = { issued: ["f1"], skipped: ["f2"], unprocessed: ["f3"], issuesCreated: 1, edgeRisks: [], issues: [], skips: [] };
    generateReport(makeRunLog(), [f2, f3, f1], triage, makeProductSpec(), [], new Map());
    const html = getSavedHtml();
    const issuedPos = html.indexOf("Issued Finding");
    const unprocessedPos = html.indexOf("Unprocessed Finding");
    const skippedPos = html.indexOf("Skipped Finding");
    expect(issuedPos).toBeLessThan(unprocessedPos);
    expect(unprocessedPos).toBeLessThan(skippedPos);
  });
});

describe("generateReport — .badge の配色コントラスト", () => {
  // WCAG 2.1 の相対輝度・コントラスト比の計算（色ライブラリなしで独立検証する）。
  function contrastWithWhite(hex: string): number {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    const lin = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return 1.05 / (luminance + 0.05); // white's own luminance is 1.0
  }

  it("コントラスト計算のセルフチェック（既知の値）", () => {
    expect(contrastWithWhite("#000000")).toBeCloseTo(21, 0);
    expect(contrastWithWhite("#ffffff")).toBeCloseTo(1, 0);
  });

  it("すべての .badge 背景色は白文字に対して WCAG AA (>=4.5:1) を満たす", () => {
    // .badge の背景として使われるすべてのコードパスを踏む: カテゴリ別 finding、
    // finding のステータス (issued/skipped/unprocessed)、シナリオ/レンズ/フォール
    // バックのエージェント割り当て、エージェントの status (completed/error)、
    // シナリオの達成/未達成、regression check の fixed/regressed。
    const findings: Finding[] = [
      makeFinding({ id: "f1", category: "bug" }),
      makeFinding({ id: "f2", category: "ux" }),
      makeFinding({ id: "f3", category: "feature-request" }),
      makeFinding({ id: "f4", category: "goal-gap" }),
    ];
    const triage: TriageResult = {
      issued: ["f1"],
      skipped: ["f2"],
      unprocessed: ["f3", "f4"],
      issuesCreated: 1,
      edgeRisks: [],
      issues: [],
      skips: [],
    };
    const scenario = { id: "s1", title: "New employee task", context: "", goal: "", constraints: "" };
    const agents = [
      makeAgentLog({ agentId: "a1", agentType: "browser", status: "completed" }),
      makeAgentLog({ agentId: "a2", agentType: "browser", status: "error" }),
      makeAgentLog({
        agentId: "a3",
        agentType: "regression",
        regressionChecks: [
          { issueNumber: 1, issueTitle: "Fixed one", status: "fixed", note: "", regressionUrl: null },
          { issueNumber: 2, issueTitle: "Regressed one", status: "regressed", note: "", regressionUrl: null },
        ],
      }),
    ];
    const agentAssignments = new Map([
      ["a1", { scenario }],
      ["a2", { lens: "Accessibility: keyboard navigation" }],
      // a3 gets neither → exercises the fallback agentType badge.
    ]);
    const outcomes: ScenarioOutcome[] = [
      { scenarioId: "s1", scenarioTitle: "New employee task", agentId: "a1", agentName: "Alice", achieved: true, reason: "ok" },
      { scenarioId: "s2", scenarioTitle: "Purchase flow", agentId: "a2", agentName: "Bob", achieved: false, reason: "blocked" },
    ];

    generateReport(
      makeRunLog({ agents }),
      findings,
      triage,
      makeProductSpec(),
      [scenario],
      agentAssignments,
      outcomes,
    );
    const html = getSavedHtml();

    const badgeColors = new Set<string>();
    const badgeRe = /class="badge"\s+style="background:(#[0-9a-fA-F]{6})"/g;
    for (const m of html.matchAll(badgeRe)) badgeColors.add(m[1].toLowerCase());

    // Sanity check that this scenario actually produced a rich mix of badges,
    // not just one or two — otherwise the assertion below would pass vacuously.
    expect(badgeColors.size).toBeGreaterThanOrEqual(8);

    for (const color of badgeColors) {
      expect(contrastWithWhite(color), `${color} against #fff`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("badge の色は web/src/utils/format.ts の CATEGORY_COLOR と一致する（bug/ux/feature-request）", () => {
    // framework/report.ts はサーバーサイドで web/src からは import できないため、
    // 値を手で同期している（categoryColor 関数のコメント参照）。ここでは
    // web 側の値をハードコードして両者がドリフトしていないことを確認する。
    const dashboardCategoryColor: Record<string, string> = {
      bug: "#dc2626",
      ux: "#c2410c",
      "feature-request": "#2563eb",
      "goal-gap": "#7c3aed",
    };
    for (const [category, color] of Object.entries(dashboardCategoryColor)) {
      if (category === "goal-gap") continue; // report.ts has no goal-gap case; falls through to the shared gray default.
      const finding = makeFinding({ category });
      generateReport(makeRunLog(), [finding], emptyTriage, makeProductSpec(), [], new Map());
      expect(getSavedHtml()).toContain(`background:${color}`);
    }
  });
});
