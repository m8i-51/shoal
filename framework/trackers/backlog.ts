import type { IssueTracker, OpenIssue, ClosedIssue } from "./types";
import { normalizeCloseReason } from "./close-reason";
import {
  categoryFromLabels,
  pickCatalogItem,
  toCatalogItems,
  type CatalogItem,
  type FindingCategory,
  type ModelPicker,
} from "./catalog-pick";

interface BacklogIssueType {
  id: number;
  name: string;
}

interface BacklogPriority {
  id: number;
  name: string;
}

export class BacklogTracker implements IssueTracker {
  readonly name = "backlog";
  readonly isEmpty = false;
  private baseUrl: string;
  private apiKey: string;
  private projectId: number;
  private pickWithModel?: ModelPicker;
  private issueTypes: CatalogItem[] | null = null;
  private priorities: CatalogItem[] | null = null;
  private pickedTypes = new Map<FindingCategory, CatalogItem>();
  private pickedPriorities = new Map<FindingCategory, CatalogItem>();

  constructor(space: string, apiKey: string, projectId: number, pickWithModel?: ModelPicker) {
    this.baseUrl = `https://${space}.backlog.com`;
    this.apiKey = apiKey;
    this.projectId = projectId;
    this.pickWithModel = pickWithModel;
  }

  private endpoint(path: string, params?: Record<string, string>): string {
    const q = new URLSearchParams({ apiKey: this.apiKey, ...params });
    return `${this.baseUrl}/api/v2${path}?${q}`;
  }

  private async fetchJson<T>(path: string, params?: Record<string, string>): Promise<T | null> {
    const res = await fetch(this.endpoint(path, params));
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error(`[backlog] GET ${path} failed (${res.status}): ${msg.slice(0, 200)}`);
      return null;
    }
    return await res.json() as T;
  }

  private async loadIssueTypes(): Promise<CatalogItem[]> {
    if (this.issueTypes) return this.issueTypes;
    const raw = await this.fetchJson<BacklogIssueType[]>(`/projects/${this.projectId}/issueTypes`);
    this.issueTypes = toCatalogItems(raw ?? []);
    return this.issueTypes;
  }

  private async loadPriorities(): Promise<CatalogItem[]> {
    if (this.priorities) return this.priorities;
    const raw = await this.fetchJson<BacklogPriority[]>("/priorities");
    this.priorities = toCatalogItems(raw ?? []);
    return this.priorities;
  }

  private async resolveField(
    kind: "issueType" | "priority",
    category: FindingCategory,
    items: CatalogItem[],
    cache: Map<FindingCategory, CatalogItem>,
  ): Promise<CatalogItem | null> {
    const cached = cache.get(category);
    if (cached) return cached;
    const picked = await pickCatalogItem({
      items,
      category,
      kind,
      logPrefix: "[backlog]",
      pickWithModel: this.pickWithModel,
    });
    if (picked) cache.set(category, picked);
    return picked;
  }

  async createIssue(title: string, body: string, labels: string[]): Promise<string | null> {
    const category = categoryFromLabels(labels);
    const [issueTypes, priorities] = await Promise.all([this.loadIssueTypes(), this.loadPriorities()]);

    if (issueTypes.length === 0) {
      console.error("[backlog] could not load issue types for the project — refusing to file with a hardcoded type id");
      return null;
    }
    if (priorities.length === 0) {
      console.error("[backlog] could not load priorities — refusing to file with a hardcoded priority id");
      return null;
    }

    const issueType = await this.resolveField("issueType", category, issueTypes, this.pickedTypes);
    const priority = await this.resolveField("priority", category, priorities, this.pickedPriorities);
    if (!issueType || !priority) {
      console.error(`[backlog] missing issue type or priority for category=${category}`);
      return null;
    }

    const form = new URLSearchParams({
      projectId: String(this.projectId),
      summary: title,
      description: `${body}\n\nLabels: ${labels.join(", ")}`,
      issueTypeId: issueType.id,
      priorityId: priority.id,
    });
    const res = await fetch(this.endpoint("/issues"), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error(`[backlog] failed to create issue (${res.status}): ${msg.slice(0, 200)}`);
      return null;
    }
    const data = await res.json() as { issueKey?: string };
    if (!data.issueKey) {
      console.error("[backlog] create issue response missing issueKey");
      return null;
    }
    const url = `${this.baseUrl}/view/${data.issueKey}`;
    console.log(`[backlog] issue created: ${url}`);
    return url;
  }

  async commentOnIssue(issueNumber: number | string, body: string): Promise<boolean> {
    const form = new URLSearchParams({ content: body });
    const res = await fetch(this.endpoint(`/issues/${issueNumber}/comments`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!res.ok) {
      const msg = await res.text().catch(() => "");
      console.error(`[backlog] failed to comment on issue ${issueNumber} (${res.status}): ${msg.slice(0, 200)}`);
    }
    return res.ok;
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
    const data = await res.json() as {
      issueKey: string;
      summary: string;
      description: string;
      resolution?: { name?: string } | null;
      status?: { name?: string };
    }[];
    return Array.isArray(data)
      ? data.map((i) => ({
          number: i.issueKey,
          title: i.summary,
          body: i.description ?? "",
          labels: [],
          url: `${this.baseUrl}/view/${i.issueKey}`,
          stateReason: normalizeCloseReason({
            resolutionName: i.resolution?.name ?? null,
            statusName: i.status?.name,
          }),
        }))
      : [];
  }
}
