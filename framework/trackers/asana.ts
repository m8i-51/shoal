import type { IssueTracker, OpenIssue, ClosedIssue } from "./types";

export class AsanaTracker implements IssueTracker {
  readonly name = "asana";
  readonly isEmpty = false;
  private token: string;
  private projectId: string;

  constructor(token: string, projectId: string) {
    this.token = token;
    this.projectId = projectId;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<string | null> {
    const res = await fetch("https://app.asana.com/api/1.0/tasks", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        data: {
          name: title,
          notes: `${body}\n\nLabels: ${labels.join(", ")}`,
          projects: [this.projectId],
        },
      }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error(`[asana] failed to create task (${res.status}): ${msg.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as {
      data?: { gid: string; permalink_url?: string };
    };
    if (!data.data?.gid) {
      console.error("[asana] create task response missing gid");
      return null;
    }
    const url = data.data.permalink_url ?? `https://app.asana.com/0/${this.projectId}/${data.data.gid}`;
    console.log(`[asana] task created: ${url}`);
    return url;
  }

  async commentOnIssue(issueNumber: number | string, body: string): Promise<boolean> {
    const res = await fetch(`https://app.asana.com/api/1.0/tasks/${issueNumber}/stories`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({ data: { text: body } }),
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error(`[asana] failed to comment on task ${issueNumber} (${res.status}): ${msg.slice(0, 200)}`);
    }
    return res.ok;
  }

  async fetchOpenIssues(): Promise<OpenIssue[]> {
    const res = await fetch(
      `https://app.asana.com/api/1.0/tasks?project=${this.projectId}&completed_since=now&opt_fields=gid,name&limit=50`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    const data = await res.json() as { data?: { gid: string; name: string }[] };
    return (data.data ?? []).map((t) => ({ number: t.gid, title: t.name, labels: [] }));
  }

  async fetchClosedIssues(): Promise<ClosedIssue[]> {
    const res = await fetch(
      `https://app.asana.com/api/1.0/tasks?project=${this.projectId}&completed=true&opt_fields=gid,name,notes&limit=20`,
      { headers: this.headers }
    );
    if (!res.ok) return [];
    const data = await res.json() as { data?: { gid: string; name: string; notes: string }[] };
    return (data.data ?? []).map((t) => ({
      number: t.gid,
      title: t.name,
      body: t.notes ?? "",
      labels: [],
    }));
  }
}
