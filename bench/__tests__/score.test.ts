import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  scoreFindings,
  formatBenchResult,
  loadLabels,
  recordBenchScore,
  formatPublishedScoresMarkdown,
  type BenchLabel,
  type PublishedBenchScores,
} from "../score";
import type { Finding } from "../../framework/types";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: `f_${Math.random().toString(36).slice(2, 7)}`,
    runId: "run_1",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    title: "Some finding",
    body: "",
    category: "bug",
    timestamp: "2026-07-05T00:00:00.000Z",
    ...overrides,
  };
}

const labels: BenchLabel[] = [
  { id: "cart-total-wrong", description: "total ignores quantity", keywords: ["total", "quantity"] },
  { id: "missing-alt-text", description: "image without alt", keywords: ["alt", "screen reader"] },
];

describe("scoreFindings", () => {
  it("キーワードが title/body に含まれるラベルを detected にする（大文字小文字無視）", () => {
    const findings = [
      makeFinding({ title: "Cart TOTAL is wrong", body: "the sum ignores item quantity" }),
    ];
    const result = scoreFindings(findings, labels);
    expect(result.detected.map((d) => d.id)).toEqual(["cart-total-wrong"]);
    expect(result.missed.map((m) => m.id)).toEqual(["missing-alt-text"]);
    expect(result.detectionRate).toBe(0.5);
  });

  it("複数 findings が同じラベルにマッチしたら matchedBy に全部入る", () => {
    const findings = [
      makeFinding({ id: "f1", title: "Total wrong" }),
      makeFinding({ id: "f2", body: "quantity is ignored in total" }),
    ];
    const result = scoreFindings(findings, labels);
    expect(result.detected[0].matchedBy).toHaveLength(2);
  });

  it("どのラベルにも一致しない findings は unmatchedFindings に数える", () => {
    const findings = [
      makeFinding({ id: "f1", title: "Total wrong" }),
      makeFinding({ id: "f2", title: "The header is ugly", body: "just aesthetics" }),
    ];
    const result = scoreFindings(findings, labels);
    expect(result.totalFindings).toBe(2);
    expect(result.unmatchedFindings).toBe(1);
  });

  it("findings ゼロなら全ラベルが missed になる", () => {
    const result = scoreFindings([], labels);
    expect(result.detectionRate).toBe(0);
    expect(result.missed).toHaveLength(2);
  });

  it("単語境界を要求するので無関係な finding を誤検出しない（Although/Totally）", () => {
    const findings = [
      makeFinding({
        title: "Although the page loads quickly, nothing else stood out",
        body: "Totally fine otherwise. No other issues found.",
      }),
    ];
    const result = scoreFindings(findings, labels);
    expect(result.detected).toHaveLength(0);
    expect(result.missed.map((m) => m.id).sort()).toEqual(["cart-total-wrong", "missing-alt-text"]);
    expect(result.unmatchedFindings).toBe(1);
  });

  it("複数単語のキーワード（フレーズ）はフレーズとしてマッチする", () => {
    const phraseLabels: BenchLabel[] = [
      { id: "no-login-required", description: "sensitive action without login", keywords: ["no login"] },
    ];
    const matching = [makeFinding({ title: "Checkout works with no login required" })];
    const nonMatching = [makeFinding({ title: "There is no way to log in from here" })];

    expect(scoreFindings(matching, phraseLabels).detected.map((d) => d.id)).toEqual(["no-login-required"]);
    expect(scoreFindings(nonMatching, phraseLabels).detected).toHaveLength(0);
  });

  it("precision は一致した finding の割合を返す", () => {
    const findings = [
      makeFinding({ id: "f1", title: "Cart total is wrong" }),
      makeFinding({ id: "f2", title: "Unrelated cosmetic nit" }),
    ];
    const result = scoreFindings(findings, labels);
    expect(result.totalFindings).toBe(2);
    expect(result.unmatchedFindings).toBe(1);
    expect(result.precision).toBe(0.5);
  });

  it("findings ゼロなら precision は 0（NaN にならない）", () => {
    const result = scoreFindings([], labels);
    expect(result.precision).toBe(0);
  });
});

describe("formatBenchResult", () => {
  it("検出率と ✓/✗ の一覧を整形する", () => {
    const result = scoreFindings([makeFinding({ title: "Total ignores quantity" })], labels);
    const text = formatBenchResult(result);
    expect(text).toContain("Detection rate: 1/2 (50%)");
    expect(text).toContain("✓ cart-total-wrong");
    expect(text).toContain("✗ missing-alt-text");
  });
});

describe("formatPublishedScoresMarkdown", () => {
  it("precision / unmatchedFindings が無いエントリは — を表示する", () => {
    const scores: PublishedBenchScores = {
      updatedAt: "2026-08-15",
      entries: [
        { variant: "store", model: "claude-sonnet-4-20250514", detectionRate: 71, totalFindings: 11, runDate: "2026-08-15" },
      ],
    };
    const md = formatPublishedScoresMarkdown(scores);
    expect(md).toContain("| store | claude-sonnet-4-20250514 | 71% | — | 11 | — | 2026-08-15 | — |");
  });

  it("precision / unmatchedFindings があるエントリはパーセント/件数で表示する", () => {
    const scores: PublishedBenchScores = {
      updatedAt: "2026-09-03",
      entries: [
        {
          variant: "store",
          model: "claude-sonnet-4-5",
          detectionRate: 80,
          totalFindings: 10,
          runDate: "2026-09-03",
          precision: 0.7,
          unmatchedFindings: 3,
        },
      ],
    };
    const md = formatPublishedScoresMarkdown(scores);
    expect(md).toContain("| store | claude-sonnet-4-5 | 80% | 70% | 10 | 3 | 2026-09-03 | — |");
  });
});

describe("recordBenchScore", () => {
  it("precision / unmatchedFindings を含むエントリを保存する", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bench-score-"));
    const scoresPath = path.join(dir, "scores.json");
    const result = recordBenchScore(
      {
        variant: "store",
        model: "claude-sonnet-4-5",
        detectionRate: 80,
        totalFindings: 10,
        runDate: "2026-09-03",
        precision: 0.7,
        unmatchedFindings: 3,
      },
      scoresPath,
    );
    expect(result.entries[0].precision).toBe(0.7);
    expect(result.entries[0].unmatchedFindings).toBe(3);

    const persisted = JSON.parse(fs.readFileSync(scoresPath, "utf-8")) as PublishedBenchScores;
    expect(persisted.entries[0].precision).toBe(0.7);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadLabels", () => {
  it("bench/labels.json を読み込める（実ファイル）", () => {
    const loaded = loadLabels();
    expect(loaded.length).toBeGreaterThanOrEqual(7);
    for (const label of loaded) {
      expect(label.id).toBeTruthy();
      expect(label.keywords.length).toBeGreaterThan(0);
    }
  });
});
