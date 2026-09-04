import type { Finding } from "./types";
import type { OpenIssue, IssueTracker } from "./trackers/index";
import { neutralizeMentions } from "./mentions";

const RereportPattern =
  /still broken|hasn't changed|has not changed|not changed since|unchanged since|前回から|変わっていない|改善されていない|not fixed since/i;

export function isReturningUserReReport(finding: Finding): boolean {
  return RereportPattern.test(`${finding.title} ${finding.body}`);
}

function normalizeTitle(title: string): string {
  return title.replace(/^\[[^\]]+\]\s*/i, "").toLowerCase().trim();
}

function titleOverlap(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const tokensA = new Set(na.match(/[a-z0-9]+/g) ?? []);
  const tokensB = new Set(nb.match(/[a-z0-9]+/g) ?? []);
  const intersection = [...tokensA].filter((t) => tokensB.has(t)).length;
  const union = new Set([...tokensA, ...tokensB]).size;
  return union > 0 && intersection / union >= 0.45;
}

export function findMatchingOpenIssue(finding: Finding, openIssues: OpenIssue[]): OpenIssue | null {
  for (const issue of openIssues) {
    if (titleOverlap(finding.title, issue.title)) return issue;
  }
  return null;
}

export function formatReReportComment(finding: Finding): string {
  return [
    "**Returning-user re-report** (still unresolved)",
    "",
    neutralizeMentions(finding.body),
    "",
    `— ${finding.agentName} (${finding.role}), run \`${finding.runId}\``,
  ].join("\n");
}

export interface ReReportResult {
  findingId: string;
  issueNumber: number | string;
  issueTitle: string;
  commented: boolean;
}

/** 再訪ユーザーの「未改善」finding を既存 open issue へコメントする */
export async function commentReturningUserReReports(
  findings: Finding[],
  openIssues: OpenIssue[],
  tracker: IssueTracker,
): Promise<{ results: ReReportResult[]; remaining: Finding[] }> {
  if (tracker.isEmpty || openIssues.length === 0) {
    return { results: [], remaining: findings };
  }

  const commentedIds = new Set<string>();
  const results: ReReportResult[] = [];

  for (const finding of findings) {
    if (!isReturningUserReReport(finding)) continue;
    const match = findMatchingOpenIssue(finding, openIssues);
    if (!match) continue;

    const body = formatReReportComment(finding);
    const ok = await tracker.commentOnIssue(match.number, body);
    results.push({
      findingId: finding.id,
      issueNumber: match.number,
      issueTitle: match.title,
      commented: ok,
    });
    if (ok) commentedIds.add(finding.id);
  }

  return {
    results,
    remaining: findings.filter((f) => !commentedIds.has(f.id)),
  };
}
