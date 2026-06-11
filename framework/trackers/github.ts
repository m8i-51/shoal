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
}
