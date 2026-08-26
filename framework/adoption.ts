import * as fs from "fs";
import * as path from "path";
import type { ClosedIssue } from "./trackers/index";

/**
 * Adoption feedback — 起票した issue がチームにどう扱われたかを群れに還元する。
 *
 * triage が issue を作るたびに「その issue に貢献した lens / scenario」を
 * coverage/issue-links.json に記録し、次の run の開始時に closed issue と突合する。
 * GitHub の state_reason が "not_planned"（wontfix 相当）なら rejected、
 * それ以外の close は adopted として coverage/adoption.json に集計する。
 * 集計結果はペルソナ設計・シナリオ設計のプロンプトに渡され、
 * 「刺さる指摘をする観点」が自然選択されていく。
 */

export interface IssueLink {
  url: string;
  title: string; // トラッカーに投稿した完全なタイトル（"[category] ..."）
  category: string;
  lenses: string[];
  scenarios: string[];
  runId: string;
  createdAt: string;
  resolution?: "adopted" | "rejected";
  resolvedAt?: string;
}

interface AdoptionCount {
  adopted: number;
  rejected: number;
}

export interface AdoptionStats {
  byLens: Record<string, AdoptionCount>;
  byCategory: Record<string, AdoptionCount>;
}

const LINKS_PATH = path.join(process.cwd(), "coverage", "issue-links.json");
const ADOPTION_PATH = path.join(process.cwd(), "coverage", "adoption.json");
const MAX_LINKS = 200;

function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
    }
  } catch { /* ignore */ }
  return fallback;
}

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

export function loadIssueLinks(): IssueLink[] {
  return readJson<IssueLink[]>(LINKS_PATH, []);
}

export function loadAdoptionStats(): AdoptionStats {
  return readJson<AdoptionStats>(ADOPTION_PATH, { byLens: {}, byCategory: {} });
}

/** triage が issue を作成したときに呼ぶ */
export function recordIssueLink(link: IssueLink): void {
  const links = loadIssueLinks();
  links.push(link);
  writeJson(LINKS_PATH, links.slice(-MAX_LINKS));
}

function matchesClosedIssue(link: IssueLink, issue: ClosedIssue): boolean {
  if (issue.url && link.url && issue.url === link.url) return true;
  // GitHub 形式: issue url が /issues/<number> で終わる
  if (link.url && link.url.endsWith(`/issues/${issue.number}`)) return true;
  return issue.title === link.title;
}

/**
 * closed issue と未解決リンクを突合し、adoption 集計を更新する。
 * 集計サマリー（プロンプト用テキスト）を返す。突合対象がなければ既存集計から生成。
 */
export function updateAdoption(closedIssues: ClosedIssue[]): string {
  const links = loadIssueLinks();
  const stats = loadAdoptionStats();
  let resolved = 0;

  for (const link of links) {
    if (link.resolution) continue;
    const closed = closedIssues.find((issue) => matchesClosedIssue(link, issue));
    if (!closed) continue;

    const rejected = closed.stateReason === "not_planned";
    link.resolution = rejected ? "rejected" : "adopted";
    link.resolvedAt = new Date().toISOString();
    resolved++;

    const buckets: [Record<string, AdoptionCount>, string[]][] = [
      [stats.byLens, link.lenses],
      [stats.byCategory, [link.category]],
    ];
    for (const [bucket, keys] of buckets) {
      for (const key of keys) {
        const entry = bucket[key] ?? { adopted: 0, rejected: 0 };
        if (rejected) entry.rejected++;
        else entry.adopted++;
        bucket[key] = entry;
      }
    }
  }

  if (resolved > 0) {
    writeJson(LINKS_PATH, links);
    writeJson(ADOPTION_PATH, stats);
    console.log(`[adoption] resolved ${resolved} issue link(s) from tracker feedback`);
  }

  return formatAdoptionSummary(stats);
}

function formatLine(name: string, count: AdoptionCount): string {
  const total = count.adopted + count.rejected;
  const rate = total > 0 ? Math.round((count.adopted / total) * 100) : 0;
  return `${name}: ${count.adopted} adopted / ${count.rejected} rejected (${rate}%)`;
}

/** 0–1 の採用率。データが無ければ null */
export function adoptionRate(count: AdoptionCount | undefined): number | null {
  if (!count) return null;
  const total = count.adopted + count.rejected;
  if (total === 0) return null;
  return count.adopted / total;
}

/**
 * coverage 重み付け用の乗数。
 * 0% 採用 → 0.75、50% → 1.0、100% → 1.25（完全には消さない）
 */
export function adoptionWeight(rate: number | null): number {
  if (rate === null) return 1;
  return 0.75 + rate * 0.5;
}

export function lensAdoptionWeight(lens: string, stats: AdoptionStats = loadAdoptionStats()): number {
  return adoptionWeight(adoptionRate(stats.byLens[lens]));
}

export function categoryAdoptionWeight(category: string, stats: AdoptionStats = loadAdoptionStats()): number {
  return adoptionWeight(adoptionRate(stats.byCategory[category]));
}

export function formatAdoptionSummary(stats: AdoptionStats = loadAdoptionStats()): string {
  const lensEntries = Object.entries(stats.byLens);
  const categoryEntries = Object.entries(stats.byCategory);
  if (lensEntries.length === 0 && categoryEntries.length === 0) return "";

  const sortByTotal = (a: [string, AdoptionCount], b: [string, AdoptionCount]) =>
    (b[1].adopted + b[1].rejected) - (a[1].adopted + a[1].rejected);

  const lines = [
    "Finding adoption (how the team acted on issues filed in past runs):",
    ...(lensEntries.length > 0
      ? [`By lens: ${lensEntries.sort(sortByTotal).map(([k, v]) => formatLine(k, v)).join(", ")}`]
      : []),
    ...(categoryEntries.length > 0
      ? [`By category: ${categoryEntries.sort(sortByTotal).map(([k, v]) => formatLine(k, v)).join(", ")}`]
      : []),
    "Lenses with high adoption produce findings the team acts on — lean into them.",
    "A rejected finding is not worthless (it may just be low priority), so reduce — don't eliminate — low-adoption perspectives.",
  ];
  return lines.join("\n");
}
