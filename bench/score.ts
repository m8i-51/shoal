import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { isFinding, type Finding } from "../framework/types";

const benchDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * shoal-bench scorer — run の findings を正解ラベル（bench/labels.json）と突合し、
 * 検出率を算出する。プロンプトやモデルを変えたときの検出力の回帰テストに使う。
 */

export interface BenchLabel {
  id: string;
  description: string;
  keywords: string[];
}

export interface DetectedLabel {
  id: string;
  matchedBy: string[]; // マッチした finding のタイトル
}

export interface BenchResult {
  detected: DetectedLabel[];
  missed: BenchLabel[];
  detectionRate: number; // 0..1
  totalFindings: number;
  unmatchedFindings: number; // どのラベルにも一致しなかった findings（誤検出とは限らない）
}

export function loadLabels(labelsPath = path.join(benchDir, "labels.json")): BenchLabel[] {
  return JSON.parse(fs.readFileSync(labelsPath, "utf-8")) as BenchLabel[];
}

export function loadRunFindings(runId: string, cwd = process.cwd()): Finding[] {
  const dir = path.join(cwd, "findings", runId);
  if (!fs.existsSync(dir)) return [];
  const findings: Finding[] = [];
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "triage_result.json") continue;
    try {
      const f: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      if (isFinding(f)) findings.push(f);
    } catch { /* skip */ }
  }
  return findings;
}

function findingMatchesLabel(finding: Finding, label: BenchLabel): boolean {
  const text = `${finding.title} ${finding.body}`.toLowerCase();
  return label.keywords.some((k) => text.includes(k.toLowerCase()));
}

export function scoreFindings(findings: Finding[], labels: BenchLabel[]): BenchResult {
  const detected: DetectedLabel[] = [];
  const missed: BenchLabel[] = [];
  const matchedFindingIds = new Set<string>();

  for (const label of labels) {
    const matches = findings.filter((f) => findingMatchesLabel(f, label));
    if (matches.length > 0) {
      detected.push({ id: label.id, matchedBy: matches.map((f) => f.title) });
      matches.forEach((f) => matchedFindingIds.add(f.id));
    } else {
      missed.push(label);
    }
  }

  return {
    detected,
    missed,
    detectionRate: labels.length > 0 ? detected.length / labels.length : 0,
    totalFindings: findings.length,
    unmatchedFindings: findings.filter((f) => !matchedFindingIds.has(f.id)).length,
  };
}

export function formatBenchResult(result: BenchResult): string {
  const lines = [
    "shoal-bench result",
    "==================",
    `Detection rate: ${result.detected.length}/${result.detected.length + result.missed.length} (${Math.round(result.detectionRate * 100)}%)`,
    `Findings: ${result.totalFindings} total, ${result.unmatchedFindings} not matching any seeded bug`,
    "",
  ];
  for (const d of result.detected) {
    lines.push(`  ✓ ${d.id}`);
    for (const title of d.matchedBy.slice(0, 2)) lines.push(`      └ "${title}"`);
  }
  for (const m of result.missed) {
    lines.push(`  ✗ ${m.id} — ${m.description}`);
  }
  return lines.join("\n");
}
