import type { IssueTracker, OpenIssue, ClosedIssue } from "./types";

export class JiraTracker implements IssueTracker {
  readonly name = "jira";
  readonly isEmpty = false;
  private baseUrl: string;
  private authHeader: string;
  private projectKey: string;

  constructor(baseUrl: string, email: string, apiToken: string, projectKey: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.authHeader = `Basic ${Buffer.from(`${email}:${apiToken}`).toString("base64")}`;
    this.projectKey = projectKey;
  }

  private get headers() {
    return {
      Authorization: this.authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<string | null> {
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          summary: title,
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: body }] }],
          },
          issuetype: { name: "Task" },
          labels,
        },
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error(`[jira] failed to create issue (${res.status}): ${msg.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as { key?: string };
    if (!data.key) {
      console.error("[jira] create issue response missing key");
      return null;
    }
    const url = `${this.baseUrl}/browse/${data.key}`;
    console.log(`[jira] issue created: ${url}`);
    return url;
  }

  async fetchOpenIssues(): Promise<OpenIssue[]> {
    const jql = encodeURIComponent(
      `project = ${this.projectKey} AND statusCategory != Done AND labels = "feedback-agent" ORDER BY created DESC`
    );
    const res = await fetch(
      `${this.baseUrl}/rest/api/3/search?jql=${jql}&maxResults=50&fields=summary,labels`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    const data = await res.json() as {
      issues?: { key: string; fields: { summary: string; labels: string[] } }[];
    };
    return (data.issues ?? []).map((i) => ({
      number: i.key,
      title: i.fields.summary,
      labels: i.fields.labels,
    }));
  }

  async fetchClosedIssues(): Promise<ClosedIssue[]> {
    const jql = encodeURIComponent(
      `project = ${this.projectKey} AND statusCategory = Done AND labels = "feedback-agent" ORDER BY updated DESC`
    );
    const res = await fetch(
      `${this.baseUrl}/rest/api/3/search?jql=${jql}&maxResults=20&fields=summary,labels,description`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    const data = await res.json() as {
      issues?: { key: string; fields: { summary: string; labels: string[]; description: unknown } }[];
    };
    return (data.issues ?? []).map((i) => ({
      number: i.key,
      title: i.fields.summary,
      body: typeof i.fields.description === "string" ? i.fields.description : "",
      labels: i.fields.labels,
    }));
  }
}
