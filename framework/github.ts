import type { ClosedIssue } from "./trackers/types";

interface GitHubOptions {
  token: string;
  repo: string;
}

/** GitHub's own page size ceiling. */
const PER_PAGE = 100;

/**
 * Safety ceiling on pages fetched per call (1000 issues at PER_PAGE=100).
 * Without one, a very active repo's issue list would make this loop for as
 * many pages as the label has ever accumulated, once per triage run.
 */
const MAX_PAGES = 10;

/**
 * Fetch every page of a GitHub issue-list endpoint, stopping at the first
 * short page (fewer than PER_PAGE items — GitHub's signal that it was the
 * last one) or at MAX_PAGES, whichever comes first.
 *
 * `fetchClosedIssues` / `fetchOpenIssues` used to request a single page
 * (`per_page=20` / `per_page=50` with no `page` follow-up), which silently
 * capped deduplication and regression-check coverage to whichever issues
 * happened to be newest — undocumented, and wrong for any repo whose
 * `feedback-agent`-labeled issues outgrew that page.
 */
async function fetchAllPages(baseUrl: string, token: string): Promise<unknown[]> {
  const all: unknown[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetch(`${baseUrl}&per_page=${PER_PAGE}&page=${page}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error(`[github] failed to list issues (${res.status}): ${msg.slice(0, 200)}`);
      break;
    }
    const data = await safeJson(res);
    if (!Array.isArray(data) || data.length === 0) break;
    all.push(...data);
    if (data.length < PER_PAGE) break;
  }
  return all;
}

/** Parse a response body as JSON, treating a malformed body as "nothing" rather than throwing. */
async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch (e) {
    console.error(`[github] response body was not valid JSON: ${String(e)}`);
    return null;
  }
}

export async function postGitHubIssue(
  title: string,
  body: string,
  labels: string[],
  { token, repo }: GitHubOptions
): Promise<string | null> {
  if (!token || !repo) {
    console.log("[github] skip (GITHUB_TOKEN or GITHUB_REPO not set)");
    return null;
  }
  const [owner, repoName] = repo.split("/");
  const res = await fetch(`https://api.github.com/repos/${owner}/${repoName}/issues`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, labels }),
  });
  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    console.error(`[github] failed to create issue (${res.status}): ${msg.slice(0, 200)}`);
    return null;
  }
  const data = await safeJson(res) as { html_url?: string } | null;
  console.log(`[github] issue created: ${data?.html_url}`);
  return data?.html_url ?? null;
}

export async function fetchClosedIssues({ token, repo }: GitHubOptions): Promise<ClosedIssue[]> {
  if (!token || !repo) return [];
  const [owner, repoName] = repo.split("/");
  const data = await fetchAllPages(
    `https://api.github.com/repos/${owner}/${repoName}/issues?state=closed&labels=feedback-agent`,
    token,
  );
  return data.map((issue) => {
    const i = issue as { number: number; title: string; body: string; labels: { name: string }[]; html_url?: string; state_reason?: string | null };
    return {
      number: i.number,
      title: i.title,
      body: i.body ?? "",
      labels: i.labels.map((l) => l.name),
      url: i.html_url,
      stateReason: i.state_reason ?? null,
    };
  });
}

export async function fetchOpenIssues({ token, repo }: GitHubOptions): Promise<{ number: number; title: string; labels: string[] }[]> {
  if (!token || !repo) return [];
  const [owner, repoName] = repo.split("/");
  const data = await fetchAllPages(
    `https://api.github.com/repos/${owner}/${repoName}/issues?state=open&labels=feedback-agent`,
    token,
  );
  return data.map((issue) => {
    const i = issue as { number: number; title: string; labels: { name: string }[] };
    return {
      number: i.number,
      title: i.title,
      labels: i.labels.map((l) => l.name),
    };
  });
}
