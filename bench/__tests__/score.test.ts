import { describe, it, expect } from "vitest";
import { scoreFindings, formatBenchResult, loadLabels, type BenchLabel } from "../score";
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
