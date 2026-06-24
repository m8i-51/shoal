import type { Finding } from "./types";

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter((x) => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

/**
 * タイトル+本文の単語集合の Jaccard 係数で finding をクラスタリングする。
 * triage は同一 run 内の重複しか除去しないため、run をまたいで
 * 繰り返し報告されている問題を見つけるための補助。
 */
export function groupSimilarFindings(findings: Finding[], threshold = 0.3): Finding[][] {
  const tokensByIndex = findings.map((f) => tokenize(`${f.title} ${f.body}`));
  const seen = new Set<number>();
  const clusters: Finding[][] = [];

  for (let i = 0; i < findings.length; i++) {
    if (seen.has(i)) continue;
    const clusterIndices = [i];
    for (let j = i + 1; j < findings.length; j++) {
      if (seen.has(j)) continue;
      if (jaccard(tokensByIndex[i], tokensByIndex[j]) >= threshold) {
        clusterIndices.push(j);
        seen.add(j);
      }
    }
    seen.add(i);
    clusters.push(clusterIndices.map((idx) => findings[idx]));
  }

  return clusters;
}

/** 2件以上で構成されるクラスタ（= run をまたいだ重複候補）のみ返す */
export function findCrossRunDuplicates(findings: Finding[], threshold = 0.3): Finding[][] {
  return groupSimilarFindings(findings, threshold).filter((cluster) => cluster.length > 1);
}
