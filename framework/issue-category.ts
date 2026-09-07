/**
 * issue-category.ts — the four kinds of finding a run can file.
 *
 * Category is written into issue bodies and applied as a tracker label, so it
 * has to be an allowlist rather than free text: a hallucinated value becomes
 * a label nobody filters on, and in the worst case a string the tracker
 * treats as something else. Both the browser `post_feedback` tool and the
 * triage `create_issue` tool share this list so they cannot drift.
 */

export const ISSUE_CATEGORIES = ["ux", "feature-request", "bug", "goal-gap"] as const;

export type IssueCategory = (typeof ISSUE_CATEGORIES)[number];

const ISSUE_CATEGORY_SET: ReadonlySet<string> = new Set(ISSUE_CATEGORIES);

export function isIssueCategory(value: string): value is IssueCategory {
  return ISSUE_CATEGORY_SET.has(value);
}
