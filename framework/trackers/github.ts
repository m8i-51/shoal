import type { IssueTracker, OpenIssue, ClosedIssue } from "./types";
import { postGitHubIssue, fetchOpenIssues as ghFetchOpen, fetchClosedIssues as ghFetchClosed } from "../github";

export class GitHubTracker implements IssueTracker {
  readonly name = "github";
  readonly isEmpty = false;
  private opts: { token: string; repo: string };

  constructor(token: string, repo: string) {
    this.opts = { token, repo };
  }

  createIssue(title: string, body: string, labels: string[]): Promise<string | null> {
    return postGitHubIssue(title, body, labels, this.opts);
  }

  async fetchOpenIssues(): Promise<OpenIssue[]> {
    return ghFetchOpen(this.opts);
  }

  async fetchClosedIssues(): Promise<ClosedIssue[]> {
    return ghFetchClosed(this.opts);
  }

  async commentOnIssue(issueNumber: number | string, body: string): Promise<boolean> {
    const [owner, repo] = this.opts.repo.split("/");
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.opts.token}`,
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
      },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error(`[github] failed to comment on issue #${issueNumber} (${res.status}): ${msg.slice(0, 200)}`);
    }
    return res.ok;
  }
}
