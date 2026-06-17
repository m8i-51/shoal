import type { IssueTracker, OpenIssue, ClosedIssue } from "./types";
import { GitHubTracker } from "./github";
import { JiraTracker } from "./jira";
import { NotionTracker } from "./notion";
import { BacklogTracker } from "./backlog";
import { AsanaTracker } from "./asana";

export type { IssueTracker, OpenIssue, ClosedIssue } from "./types";

export class AggregatedTracker implements IssueTracker {
  readonly name = "aggregated";
  private trackers: IssueTracker[];

  constructor(trackers: IssueTracker[]) {
    this.trackers = trackers;
  }

  get isEmpty(): boolean {
    return this.trackers.length === 0;
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<string | null> {
    if (this.trackers.length === 0) return null;
    const results = await Promise.allSettled(this.trackers.map((t) => t.createIssue(title, body, labels)));
    for (const r of results) {
      if (r.status === "rejected") console.error("[trackers] createIssue error:", r.reason);
    }
    const urls = results.filter((r): r is PromiseFulfilledResult<string | null> => r.status === "fulfilled");
    return urls.map((r) => r.value).find((u) => u !== null) ?? null;
  }

  async fetchOpenIssues(): Promise<OpenIssue[]> {
    const results = await Promise.allSettled(this.trackers.map((t) => t.fetchOpenIssues()));
    return results.flatMap((r) => {
      if (r.status === "rejected") { console.error("[trackers] fetchOpenIssues error:", r.reason); return []; }
      return r.value;
    });
  }

  async fetchClosedIssues(): Promise<ClosedIssue[]> {
    const results = await Promise.allSettled(this.trackers.map((t) => t.fetchClosedIssues()));
    return results.flatMap((r) => {
      if (r.status === "rejected") { console.error("[trackers] fetchClosedIssues error:", r.reason); return []; }
      return r.value;
    });
  }

  async commentOnIssue(issueNumber: number | string, body: string): Promise<boolean> {
    if (this.trackers.length === 0) return false;
    const results = await Promise.allSettled(this.trackers.map((t) => t.commentOnIssue(issueNumber, body)));
    for (const r of results) {
      if (r.status === "rejected") console.error("[trackers] commentOnIssue error:", r.reason);
    }
    return results.some((r) => r.status === "fulfilled" && r.value === true);
  }
}

export function buildTrackers(): AggregatedTracker {
  const raw = process.env.ISSUE_TRACKERS ?? "";
  const enabled = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  // Backward compat: if ISSUE_TRACKERS not set but GITHUB_TOKEN/GITHUB_REPO are present, default to github
  if (enabled.length === 0 && process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    enabled.push("github");
  }

  const trackers: IssueTracker[] = [];

  for (const name of enabled) {
    switch (name) {
      case "github": {
        const token = process.env.GITHUB_TOKEN ?? "";
        const repo = process.env.GITHUB_REPO ?? "";
        if (token && repo) {
          trackers.push(new GitHubTracker(token, repo));
        } else {
          console.warn("[trackers] github: GITHUB_TOKEN or GITHUB_REPO not set, skipping");
        }
        break;
      }
      case "jira": {
        const baseUrl = process.env.JIRA_BASE_URL ?? "";
        const email = process.env.JIRA_EMAIL ?? "";
        const apiToken = process.env.JIRA_API_TOKEN ?? "";
        const projectKey = process.env.JIRA_PROJECT_KEY ?? "";
        if (baseUrl && email && apiToken && projectKey) {
          trackers.push(new JiraTracker(baseUrl, email, apiToken, projectKey));
        } else {
          console.warn("[trackers] jira: JIRA_BASE_URL / JIRA_EMAIL / JIRA_API_TOKEN / JIRA_PROJECT_KEY required, skipping");
        }
        break;
      }
      case "notion": {
        const token = process.env.NOTION_API_KEY ?? "";
        const databaseId = process.env.NOTION_DATABASE_ID ?? "";
        if (token && databaseId) {
          trackers.push(new NotionTracker(token, databaseId));
        } else {
          console.warn("[trackers] notion: NOTION_API_KEY or NOTION_DATABASE_ID not set, skipping");
        }
        break;
      }
      case "backlog": {
        const space = process.env.BACKLOG_SPACE ?? "";
        const apiKey = process.env.BACKLOG_API_KEY ?? "";
        const projectId = parseInt(process.env.BACKLOG_PROJECT_ID ?? "", 10);
        if (space && apiKey && !isNaN(projectId)) {
          trackers.push(new BacklogTracker(space, apiKey, projectId));
        } else {
          console.warn("[trackers] backlog: BACKLOG_SPACE / BACKLOG_API_KEY / BACKLOG_PROJECT_ID required, skipping");
        }
        break;
      }
      case "asana": {
        const token = process.env.ASANA_ACCESS_TOKEN ?? "";
        const projectId = process.env.ASANA_PROJECT_ID ?? "";
        if (token && projectId) {
          trackers.push(new AsanaTracker(token, projectId));
        } else {
          console.warn("[trackers] asana: ASANA_ACCESS_TOKEN or ASANA_PROJECT_ID not set, skipping");
        }
        break;
      }
      default:
        console.warn(`[trackers] unknown tracker: "${name}"`);
    }
  }

  if (trackers.length > 0) {
    console.log(`[trackers] enabled: ${trackers.map((t) => t.name).join(", ")}`);
  } else {
    console.log("[trackers] no issue trackers configured — findings saved locally only");
  }

  return new AggregatedTracker(trackers);
}
