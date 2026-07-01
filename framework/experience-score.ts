import { loadCoverage, type RunCoverage } from "./coverage";

/**
 * Experience Score — アプリの「体験の健康度」を run 横断で測る 0–100 のスコア。
 *
 * 3 つの成分の加重平均:
 * - achievement (60%): シナリオ達成率。ユーザーが目的を果たせたか
 * - friction    (20%): 達成シナリオの平均イテレーション数。少ない手数で達成できるほど高い
 * - regression  (20%): 修正済み issue の再発率。低いほど高い
 *
 * データのない成分は除外して重みを再正規化する。全成分が欠けている run はスコア対象外。
 */

export interface RunExperience {
  runId: string;
  timestamp: string;
  score: number; // 0-100
  achievementRate: number | null; // 0..1
  avgIterations: number | null; // 達成シナリオのみの平均手数
  regressionRate: number | null; // regressed / checked
}

export interface ExperienceScore {
  latest: RunExperience;
  delta: number | null; // 直前のスコア対象 run との差分
  trend: RunExperience[]; // 古い順（スコア対象 run のみ）
}

// run.ts のブラウザエージェントのループ上限と揃える（friction 正規化の分母）
const ITERATION_BUDGET = 12;

const WEIGHTS = {
  achievement: 0.6,
  friction: 0.2,
  regression: 0.2,
};

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function scoreRun(entry: RunCoverage): RunExperience | null {
  const outcomes = entry.scenarioOutcomes ?? [];
  const components: { weight: number; value: number }[] = [];

  let achievementRate: number | null = null;
  let avgIterations: number | null = null;
  if (outcomes.length > 0) {
    const achieved = outcomes.filter((o) => o.achieved);
    achievementRate = achieved.length / outcomes.length;
    components.push({ weight: WEIGHTS.achievement, value: achievementRate });

    const iters = achieved
      .map((o) => o.iterations)
      .filter((n): n is number => typeof n === "number" && n > 0);
    if (iters.length > 0) {
      avgIterations = iters.reduce((a, b) => a + b, 0) / iters.length;
      components.push({
        weight: WEIGHTS.friction,
        value: clamp01(1 - avgIterations / ITERATION_BUDGET),
      });
    }
  }

  let regressionRate: number | null = null;
  if (entry.regression && entry.regression.checked > 0) {
    regressionRate = entry.regression.regressed / entry.regression.checked;
    components.push({ weight: WEIGHTS.regression, value: 1 - clamp01(regressionRate) });
  }

  if (components.length === 0) return null;

  const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
  const score = Math.round(
    (components.reduce((sum, c) => sum + c.value * c.weight, 0) / totalWeight) * 100,
  );

  return {
    runId: entry.runId,
    timestamp: entry.timestamp,
    score,
    achievementRate,
    avgIterations: avgIterations != null ? Math.round(avgIterations * 10) / 10 : null,
    regressionRate,
  };
}

export function computeExperienceScore(): ExperienceScore | null {
  const coverage = loadCoverage();
  const trend = coverage.entries
    .map(scoreRun)
    .filter((e): e is RunExperience => e !== null);
  if (trend.length === 0) return null;

  const latest = trend[trend.length - 1];
  const previous = trend.length > 1 ? trend[trend.length - 2] : null;
  return {
    latest,
    delta: previous ? latest.score - previous.score : null,
    trend,
  };
}

export function formatExperienceLine(exp: ExperienceScore): string {
  const { latest, delta } = exp;
  const parts: string[] = [];
  if (latest.achievementRate != null) {
    parts.push(`scenarios ${Math.round(latest.achievementRate * 100)}% achieved`);
  }
  if (latest.avgIterations != null) {
    parts.push(`avg ${latest.avgIterations} iterations`);
  }
  if (latest.regressionRate != null) {
    parts.push(`regression rate ${Math.round(latest.regressionRate * 100)}%`);
  }
  const deltaStr = delta == null ? "" : delta >= 0 ? ` (+${delta})` : ` (${delta})`;
  return `experience score: ${latest.score}/100${deltaStr}${parts.length > 0 ? ` — ${parts.join(", ")}` : ""}`;
}
