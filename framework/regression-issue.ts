/**
 * Closed-issue classification for the regression lane.
 * UI-only tickets must not be marked verified / regressed from API evidence alone.
 */

export type IssueLike = {
  title: string;
  body?: string;
  labels?: string[];
};

const UI_LABEL_RE = /\b(ux|ui|a11y|frontend|css)\b/i;
const UI_TEXT_RE =
  /oauth|sso|theme|dark mode|light mode|hamburger|notification panel|dropdown|layout|modal|sidebar|css|クリック|テーマ|通知パネル|ハンバーガー|ボタン/i;
const API_TEXT_RE = /\bapi\b|endpoint|status code|\b50[0-9]\b|\b403\b|graphql|json payload/i;

export function issueLooksUiOnly(issue: IssueLike): boolean {
  const labels = (issue.labels ?? []).join(" ");
  if (UI_LABEL_RE.test(labels)) return true;
  const text = `${issue.title} ${issue.body ?? ""}`;
  return UI_TEXT_RE.test(text) && !API_TEXT_RE.test(text);
}

export function partitionClosedIssues<T extends IssueLike>(issues: T[]): { ui: T[]; api: T[] } {
  const ui: T[] = [];
  const api: T[] = [];
  for (const issue of issues) {
    if (issueLooksUiOnly(issue)) ui.push(issue);
    else api.push(issue);
  }
  return { ui, api };
}

/** Extra turns so a regression pass can cover more than a handful of closed issues. */
export function regressionMaxIterations(issueCount: number): number {
  const n = Math.max(0, Math.floor(issueCount));
  return Math.min(30, Math.max(12, n * 2));
}
