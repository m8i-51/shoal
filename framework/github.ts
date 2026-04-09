import type { ClosedIssue } from "./types";

interface GitHubOptions {
  token: string;
  repo: string;
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
    headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ title, body, labels }),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`[github] failed to create issue (${res.status}): ${JSON.stringify(data)}`);
    return null;
  }
  console.log(`[github] issue created: ${data.html_url}`);
  return data.html_url ?? null;
}

export async function fetchClosedIssues({ token, repo }: GitHubOptions): Promise<ClosedIssue[]> {
  if (!token || !repo) return [];
  const [owner, repoName] = repo.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues?state=closed&labels=feedback-agent&per_page=20`,
    { headers: { Authorization: `token ${token}` } }
  );
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((issue: { number: number; title: string; body: string; labels: { name: string }[] }) => ({
    number: issue.number,
    title: issue.title,
    body: issue.body ?? "",
    labels: issue.labels.map((l) => l.name),
  }));
}

export async function fetchOpenIssues({ token, repo }: GitHubOptions): Promise<{ number: number; title: string; labels: string[] }[]> {
  if (!token || !repo) return [];
  const [owner, repoName] = repo.split("/");
  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repoName}/issues?state=open&labels=feedback-agent&per_page=50`,
    { headers: { Authorization: `token ${token}` } }
  );
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data.map((i: { number: number; title: string; labels: { name: string }[] }) => ({
    number: i.number,
    title: i.title,
    labels: i.labels.map((l) => l.name),
  }));
}
