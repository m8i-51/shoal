import * as fs from "fs";
import * as path from "path";
import type { Finding } from "./types";
import type { Scenario } from "./scenario-designer";

export interface RunCoverage {
  runId: string;
  timestamp: string;
  findingsCount: number;
  byCategory: Record<string, number>;
  byLens: Record<string, number>;
  byScenario: Record<string, number>;
}

export interface Coverage {
  entries: RunCoverage[];
}

export interface WeightedSummary {
  totalWeighted: number;
  byCategory: Record<string, number>;
  byLens: Record<string, number>;
  byScenario: Record<string, number>;
  formatted: string;
}

const COVERAGE_PATH = path.join(process.cwd(), "coverage", "coverage.json");
const MAX_ENTRIES = 30;
const HALF_LIFE_DAYS = 7;
const REPETITION_WINDOW_DAYS = 14;
const REPETITION_BONUS = 0.005;
const REPETITION_EXPONENT = 3;

export function loadCoverage(): Coverage {
  try {
    if (fs.existsSync(COVERAGE_PATH)) {
      return JSON.parse(fs.readFileSync(COVERAGE_PATH, "utf-8")) as Coverage;
    }
  } catch { /* ignore */ }
  return { entries: [] };
}

function saveCoverage(coverage: Coverage): void {
  fs.mkdirSync(path.dirname(COVERAGE_PATH), { recursive: true });
  fs.writeFileSync(COVERAGE_PATH, JSON.stringify(coverage, null, 2), "utf-8");
}

export function updateCoverage(
  runId: string,
  findings: Finding[],
  agentAssignments: Map<string, { scenario?: Scenario; lens?: string }>,
): void {
  const coverage = loadCoverage();

  const byCategory: Record<string, number> = {};
  const byLens: Record<string, number> = {};
  const byScenario: Record<string, number> = {};

  for (const f of findings) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;

    const assignment = agentAssignments.get(f.agentId);
    if (assignment?.lens) {
      const lensKey = assignment.lens.split(":")[0].trim();
      byLens[lensKey] = (byLens[lensKey] ?? 0) + 1;
    } else if (assignment?.scenario) {
      const key = assignment.scenario.title;
      byScenario[key] = (byScenario[key] ?? 0) + 1;
    }
  }

  coverage.entries.push({
    runId,
    timestamp: new Date().toISOString(),
    findingsCount: findings.length,
    byCategory,
    byLens,
    byScenario,
  });

  if (coverage.entries.length > MAX_ENTRIES) {
    coverage.entries = coverage.entries.slice(-MAX_ENTRIES);
  }

  saveCoverage(coverage);
  console.log(`[coverage] updated (${coverage.entries.length} run(s) tracked)`);
}

export function computeWeightedSummary(): WeightedSummary {
  const coverage = loadCoverage();

  if (coverage.entries.length === 0) {
    return {
      totalWeighted: 0,
      byCategory: {},
      byLens: {},
      byScenario: {},
      formatted: "(no coverage data yet — this is the first run)",
    };
  }

  const now = Date.now();
  const halfLifeMs = HALF_LIFE_DAYS * 24 * 60 * 60 * 1000;
  const windowMs = REPETITION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  // 14日以内の run で各 lens/scenario が何回登場したかを数える
  const lensRepeat: Record<string, number> = {};
  const scenarioRepeat: Record<string, number> = {};
  for (const entry of coverage.entries) {
    if (now - new Date(entry.timestamp).getTime() > windowMs) continue;
    for (const lens of Object.keys(entry.byLens)) {
      lensRepeat[lens] = (lensRepeat[lens] ?? 0) + 1;
    }
    for (const title of Object.keys(entry.byScenario ?? {})) {
      scenarioRepeat[title] = (scenarioRepeat[title] ?? 0) + 1;
    }
  }

  const byCategory: Record<string, number> = {};
  const byLens: Record<string, number> = {};
  const byScenario: Record<string, number> = {};
  let totalWeighted = 0;

  for (const entry of coverage.entries) {
    const age = now - new Date(entry.timestamp).getTime();
    const decay = Math.pow(0.5, age / halfLifeMs);

    for (const [cat, count] of Object.entries(entry.byCategory)) {
      byCategory[cat] = (byCategory[cat] ?? 0) + count * decay;
    }
    for (const [lens, count] of Object.entries(entry.byLens)) {
      // 繰り返し呼ばれるほど「必要」とみなしてボーナスを加算
      const bonus = 1 + Math.pow((lensRepeat[lens] ?? 1) - 1, REPETITION_EXPONENT) * REPETITION_BONUS;
      byLens[lens] = (byLens[lens] ?? 0) + count * decay * bonus;
    }
    for (const [title, count] of Object.entries(entry.byScenario ?? {})) {
      const bonus = 1 + Math.pow((scenarioRepeat[title] ?? 1) - 1, REPETITION_EXPONENT) * REPETITION_BONUS;
      byScenario[title] = (byScenario[title] ?? 0) + count * decay * bonus;
    }
    totalWeighted += entry.findingsCount * decay;
  }

  // 小数点1桁に丸める
  const round1 = (n: number) => Math.round(n * 10) / 10;
  for (const k of Object.keys(byCategory)) byCategory[k] = round1(byCategory[k]);
  for (const k of Object.keys(byLens)) byLens[k] = round1(byLens[k]);
  for (const k of Object.keys(byScenario)) byScenario[k] = round1(byScenario[k]);
  totalWeighted = round1(totalWeighted);

  const sortedLens = Object.entries(byLens).sort((a, b) => b[1] - a[1]);
  const sortedCategory = Object.entries(byCategory).sort((a, b) => b[1] - a[1]);
  const sortedScenario = Object.entries(byScenario).sort((a, b) => b[1] - a[1]);

  const avgLens = totalWeighted > 0 && sortedLens.length > 0
    ? totalWeighted / sortedLens.length
    : 0;
  const underrepresented = sortedLens
    .filter(([, count]) => count < avgLens * 0.5)
    .map(([lens]) => lens);

  const scenarioLine = sortedScenario.length > 0
    ? `By scenario: ${sortedScenario.map(([t, c]) => `"${t}" (${c})`).join(", ")}`
    : null;

  const repeatedLenses = Object.entries(lensRepeat)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([l, n]) => `${l} (×${n})`);
  const repeatedScenarios = Object.entries(scenarioRepeat)
    .filter(([, n]) => n > 1)
    .sort((a, b) => b[1] - a[1])
    .map(([t, n]) => `"${t}" (×${n})`);

  const formatted = [
    `Coverage summary (half-life: ${HALF_LIFE_DAYS} days, repetition window: ${REPETITION_WINDOW_DAYS} days, ${coverage.entries.length} run(s) tracked):`,
    `Total weighted findings: ${totalWeighted}`,
    `By lens: ${sortedLens.map(([l, c]) => `${l} (${c})`).join(" > ") || "(none)"}`,
    scenarioLine,
    `By category: ${sortedCategory.map(([c, n]) => `${c} (${n})`).join(" > ") || "(none)"}`,
    repeatedLenses.length > 0
      ? `Repeated lenses (bonus applied): ${repeatedLenses.join(", ")}`
      : null,
    repeatedScenarios.length > 0
      ? `Repeated scenarios (bonus applied): ${repeatedScenarios.join(", ")}`
      : null,
    underrepresented.length > 0
      ? `Underrepresented lenses: ${underrepresented.join(", ")} — consider recruiting agents with these perspectives`
      : "All lenses have comparable coverage",
  ].filter(Boolean).join("\n");

  return { totalWeighted, byCategory, byLens, byScenario, formatted };
}
