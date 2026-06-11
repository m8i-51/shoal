import type { IssueTracker, OpenIssue, ClosedIssue } from "./types";

export class NotionTracker implements IssueTracker {
  readonly name = "notion";
  private token: string;
  private databaseId: string;

  constructor(token: string, databaseId: string) {
    this.token = token;
    this.databaseId = databaseId;
  }

  private get headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json",
      "Notion-Version": "2022-06-28",
    };
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<string | null> {
    const res = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        parent: { database_id: this.databaseId },
        properties: {
          Name: { title: [{ text: { content: title } }] },
          Labels: { multi_select: labels.map((l) => ({ name: l })) },
          Status: { select: { name: "Open" } },
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: { rich_text: [{ type: "text", text: { content: body } }] },
          },
        ],
      }),
    });
    const data = await res.json() as { id?: string; url?: string; message?: string };
    if (!res.ok) {
      console.error(`[notion] failed to create page (${res.status}): ${data.message}`);
      return null;
    }
    console.log(`[notion] page created: ${data.url}`);
    return data.url ?? null;
  }

  async fetchOpenIssues(): Promise<OpenIssue[]> {
    return this._queryPages("Open");
  }

  async fetchClosedIssues(): Promise<ClosedIssue[]> {
    const pages = await this._queryPages("Closed");
    return pages.map((p) => ({ ...p, body: "" }));
  }

  private async _queryPages(status: string): Promise<{ number: string; title: string; labels: string[] }[]> {
    const res = await fetch(`https://api.notion.com/v1/databases/${this.databaseId}/query`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        filter: { property: "Status", select: { equals: status } },
        page_size: 50,
      }),
    });
    if (!res.ok) return [];
    const data = await res.json() as {
      results?: {
        id: string;
        properties: {
          Name?: { title: { plain_text: string }[] };
          Labels?: { multi_select: { name: string }[] };
        };
      }[];
    };
    return (data.results ?? []).map((p) => ({
      number: p.id,
      title: p.properties.Name?.title[0]?.plain_text ?? "(no title)",
      labels: p.properties.Labels?.multi_select.map((l) => l.name) ?? [],
    }));
  }
}
