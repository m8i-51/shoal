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
  lens?: string;
  path?: string;
  category?: string;
}

export interface BenchScoreEntry {
  variant: string;
  model: string;
  detectionRate: number;
  totalFindings: number;
  runDate: string;
  config?: string;
  /**
   * matched findings / total findings, 0..1, or `null` when the run produced
   * zero findings (precision is undefined then, not zero — a run that found
   * nothing didn't report anything wrong either). `recordBenchScore` omits
   * this field entirely rather than persisting a literal `null`. Absent on
   * entries scored before this field existed.
   */
  precision?: number | null;
  /** Findings that matched no seeded label. Absent on entries scored before this field existed. */
  unmatchedFindings?: number;
}

export interface PublishedBenchScores {
  updatedAt: string;
  note?: string;
  entries: BenchScoreEntry[];
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
  /**
   * 0..1 — (totalFindings - unmatchedFindings) / totalFindings, or `null`
   * when there were zero findings. A run with no findings has undefined
   * precision, not 0% precision — 0% would misleadingly read as "everything
   * it reported was wrong" when it reported nothing at all.
   */
  precision: number | null;
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A keyword must match on word boundaries, not as a bare substring — "alt"
 * must not match inside "Although", nor "total" inside "Totally". A
 * multi-word keyword (e.g. "no login") still matches as a phrase since the
 * space between words is kept literal; only the two ends are boundary-checked.
 */
function findingMatchesLabel(finding: Finding, label: BenchLabel): boolean {
  const text = `${finding.title} ${finding.body}`;
  return label.keywords.some((k) => {
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(k)}([^a-z0-9]|$)`, "i");
    return pattern.test(text);
  });
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

  const unmatchedFindings = findings.filter((f) => !matchedFindingIds.has(f.id)).length;

  return {
    detected,
    missed,
    detectionRate: labels.length > 0 ? detected.length / labels.length : 0,
    totalFindings: findings.length,
    unmatchedFindings,
    precision: findings.length > 0 ? (findings.length - unmatchedFindings) / findings.length : null,
  };
}

export function formatBenchResult(result: BenchResult, variantId = "store"): string {
  const precisionText = result.precision === null ? "n/a" : `${Math.round(result.precision * 100)}%`;
  const lines = [
    `shoal-bench result (${variantId})`,
    "==================",
    `Detection rate: ${result.detected.length}/${result.detected.length + result.missed.length} (${Math.round(result.detectionRate * 100)}%)`,
    `Precision: ${precisionText} (${result.totalFindings - result.unmatchedFindings}/${result.totalFindings} findings matched a seeded label)`,
    `Findings: ${result.totalFindings} total, ${result.unmatchedFindings} not matching any seeded bug`,
    "",
  ];
  for (const d of result.detected) {
    lines.push(`  ✓ ${d.id}`);
    for (const title of d.matchedBy.slice(0, 2)) lines.push(`      └ "${title}"`);
  }
  for (const m of result.missed) {
    const meta = [m.lens, m.path].filter(Boolean).join(" @ ");
    lines.push(`  ✗ ${m.id}${meta ? ` (${meta})` : ""} — ${m.description}`);
  }
  return lines.join("\n");
}

export function loadPublishedScores(scoresPath = path.join(benchDir, "scores.json")): PublishedBenchScores {
  if (!fs.existsSync(scoresPath)) {
    return { updatedAt: "", entries: [] };
  }
  return JSON.parse(fs.readFileSync(scoresPath, "utf-8")) as PublishedBenchScores;
}

export function recordBenchScore(
  entry: BenchScoreEntry,
  scoresPath = path.join(benchDir, "scores.json"),
): PublishedBenchScores {
  const published = loadPublishedScores(scoresPath);
  const withoutDuplicate = published.entries.filter(
    (e) => !(e.variant === entry.variant && e.model === entry.model && e.runDate === entry.runDate),
  );
  // `precision: null` means "zero findings, precision is undefined" — drop
  // the key entirely rather than persist a literal `null`, which would read
  // as 0% to any consumer of bench/scores.json that doesn't special-case it
  // (the same field is `undefined`/absent for entries scored before it existed).
  const { precision, ...rest } = entry;
  const storedEntry: BenchScoreEntry = precision == null ? rest : { ...rest, precision };
  const next: PublishedBenchScores = {
    updatedAt: new Date().toISOString().slice(0, 10),
    note: published.note,
    entries: [storedEntry, ...withoutDuplicate],
  };
  fs.writeFileSync(scoresPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

export function formatPublishedScoresMarkdown(scores: PublishedBenchScores): string {
  if (scores.entries.length === 0) {
    return "_No published scores yet. Run `BENCH_RECORD=1 npm run bench` to append results to `bench/scores.json`._";
  }
  const lines = [
    "| Variant | Model | Detection | Precision | Findings | Unmatched | Date | Config |",
    "|---|---|---:|---:|---:|---:|---|---|",
  ];
  for (const entry of scores.entries) {
    const precision = entry.precision != null ? `${Math.round(entry.precision * 100)}%` : "—";
    const unmatched = entry.unmatchedFindings !== undefined ? String(entry.unmatchedFindings) : "—";
    lines.push(
      `| ${entry.variant} | ${entry.model} | ${entry.detectionRate}% | ${precision} | ${entry.totalFindings} | ${unmatched} | ${entry.runDate} | ${entry.config ?? "—"} |`,
    );
  }
  return lines.join("\n");
}
