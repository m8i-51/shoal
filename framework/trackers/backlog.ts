import type { IssueTracker, OpenIssue, ClosedIssue } from "./types";

export class BacklogTracker implements IssueTracker {
  readonly name = "backlog";
  private baseUrl: string;
  private apiKey: string;
  private projectId: number;

  constructor(space: string, apiKey: string, projectId: number) {
    this.baseUrl = `https://${space}.backlog.com`;
    this.apiKey = apiKey;
    this.projectId = projectId;
  }

  private endpoint(path: string, params?: Record<string, string>): string {
    const q = new URLSearchParams({ apiKey: this.apiKey, ...params });
    return `${this.baseUrl}/api/v2${path}?${q}`;
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<string | null> {
    const form = new URLSearchParams({
      projectId: String(this.projectId),
      summary: title,
      description: `${body}\n\nLabels: ${labels.join(", ")}`,
      issueTypeId: "1",
      priorityId: "3",
    });
    const res = await fetch(this.endpoint("/issues"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const data = await res.json() as { issueKey?: string; message?: string };
    if (!res.ok) {
      console.error(`[backlog] failed to create issue (${res.status}): ${data.message}`);
      return null;
    }
    const url = `${this.baseUrl}/view/${data.issueKey}`;
    console.log(`[backlog] issue created: ${url}`);
    return url;
  }

  async fetchOpenIssues(): Promise<OpenIssue[]> {
    const res = await fetch(this.endpoint("/issues", {
      "projectId[]": String(this.projectId),
      "statusId[]": "1",
      count: "50",
      keyword: "feedback-agent",
    }));
    if (!res.ok) return [];
    const data = await res.json() as { issueKey: string; summary: string }[];
    return Array.isArray(data)
      ? data.map((i) => ({ number: i.issueKey, title: i.summary, labels: [] }))
      : [];
  }

  async fetchClosedIssues(): Promise<ClosedIssue[]> {
    const res = await fetch(this.endpoint("/issues", {
      "projectId[]": String(this.projectId),
      "statusId[]": "4",
      count: "20",
      keyword: "feedback-agent",
    }));
    if (!res.ok) return [];
    const data = await res.json() as { issueKey: string; summary: string; description: string }[];
    return Array.isArray(data)
      ? data.map((i) => ({ number: i.issueKey, title: i.summary, body: i.description ?? "", labels: [] }))
      : [];
  }
}
