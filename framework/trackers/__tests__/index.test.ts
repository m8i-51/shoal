import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AggregatedTracker, buildTrackers } from "../index";
import type { IssueTracker, OpenIssue, ClosedIssue } from "../types";

function makeFakeTracker(overrides: Partial<IssueTracker> = {}): IssueTracker {
  return {
    name: "fake",
    isEmpty: false,
    createIssue: vi.fn().mockResolvedValue("https://example.com/issue/1"),
    fetchOpenIssues: vi.fn().mockResolvedValue([]),
    fetchClosedIssues: vi.fn().mockResolvedValue([]),
    commentOnIssue: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

describe("AggregatedTracker", () => {
  it("trackers が空配列なら isEmpty = true", () => {
    expect(new AggregatedTracker([]).isEmpty).toBe(true);
  });

  it("trackers が1件以上あれば isEmpty = false", () => {
    expect(new AggregatedTracker([makeFakeTracker()]).isEmpty).toBe(false);
  });

  describe("createIssue", () => {
    it("trackers が空なら null を返す", async () => {
      expect(await new AggregatedTracker([]).createIssue("t", "b", [])).toBeNull();
    });

    it("最初に成功した非null の URL を返す", async () => {
      const a = makeFakeTracker({ createIssue: vi.fn().mockResolvedValue(null) });
      const b = makeFakeTracker({ createIssue: vi.fn().mockResolvedValue("https://b.example.com/1") });
      const result = await new AggregatedTracker([a, b]).createIssue("t", "b", []);
      expect(result).toBe("https://b.example.com/1");
    });

    it("一部のトラッカーが reject しても他の結果は使われる", async () => {
      const failing = makeFakeTracker({ createIssue: vi.fn().mockRejectedValue(new Error("network error")) });
      const ok = makeFakeTracker({ createIssue: vi.fn().mockResolvedValue("https://ok.example.com/1") });
      const result = await new AggregatedTracker([failing, ok]).createIssue("t", "b", []);
      expect(result).toBe("https://ok.example.com/1");
    });

    it("全トラッカーが null/reject の場合は null を返す", async () => {
      const a = makeFakeTracker({ createIssue: vi.fn().mockResolvedValue(null) });
      const b = makeFakeTracker({ createIssue: vi.fn().mockRejectedValue(new Error("fail")) });
      const result = await new AggregatedTracker([a, b]).createIssue("t", "b", []);
      expect(result).toBeNull();
    });
  });

  describe("fetchOpenIssues", () => {
    it("全トラッカーの結果をフラットに結合する", async () => {
      const a = makeFakeTracker({ fetchOpenIssues: vi.fn().mockResolvedValue([{ number: 1, title: "A", labels: [] }] as OpenIssue[]) });
      const b = makeFakeTracker({ fetchOpenIssues: vi.fn().mockResolvedValue([{ number: 2, title: "B", labels: [] }] as OpenIssue[]) });
      const result = await new AggregatedTracker([a, b]).fetchOpenIssues();
      expect(result.map((i) => i.number)).toEqual([1, 2]);
    });

    it("reject したトラッカーは結果から除外される（エラーは握りつぶす）", async () => {
      const failing = makeFakeTracker({ fetchOpenIssues: vi.fn().mockRejectedValue(new Error("boom")) });
      const ok = makeFakeTracker({ fetchOpenIssues: vi.fn().mockResolvedValue([{ number: 1, title: "A", labels: [] }] as OpenIssue[]) });
      const result = await new AggregatedTracker([failing, ok]).fetchOpenIssues();
      expect(result).toHaveLength(1);
    });
  });

  describe("fetchClosedIssues", () => {
    it("全トラッカーの結果をフラットに結合する", async () => {
      const a = makeFakeTracker({ fetchClosedIssues: vi.fn().mockResolvedValue([{ number: 1, title: "A", body: "", labels: [] }] as ClosedIssue[]) });
      const result = await new AggregatedTracker([a]).fetchClosedIssues();
      expect(result).toHaveLength(1);
    });

    it("reject したトラッカーは結果から除外される", async () => {
      const failing = makeFakeTracker({ fetchClosedIssues: vi.fn().mockRejectedValue(new Error("boom")) });
      const result = await new AggregatedTracker([failing]).fetchClosedIssues();
      expect(result).toEqual([]);
    });
  });

  describe("commentOnIssue", () => {
    it("trackers が空なら false", async () => {
      expect(await new AggregatedTracker([]).commentOnIssue(1, "hi")).toBe(false);
    });

    it("いずれか1つでも true を返せば true", async () => {
      const a = makeFakeTracker({ commentOnIssue: vi.fn().mockResolvedValue(false) });
      const b = makeFakeTracker({ commentOnIssue: vi.fn().mockResolvedValue(true) });
      expect(await new AggregatedTracker([a, b]).commentOnIssue(1, "hi")).toBe(true);
    });

    it("全て false/reject なら false", async () => {
      const a = makeFakeTracker({ commentOnIssue: vi.fn().mockResolvedValue(false) });
      const b = makeFakeTracker({ commentOnIssue: vi.fn().mockRejectedValue(new Error("boom")) });
      expect(await new AggregatedTracker([a, b]).commentOnIssue(1, "hi")).toBe(false);
    });
  });
});

describe("buildTrackers", () => {
  const ENV_KEYS = [
    "ISSUE_TRACKERS", "GITHUB_TOKEN", "GITHUB_REPO",
    "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT_KEY",
    "NOTION_API_KEY", "NOTION_DATABASE_ID",
    "BACKLOG_SPACE", "BACKLOG_API_KEY", "BACKLOG_PROJECT_ID",
    "ASANA_ACCESS_TOKEN", "ASANA_PROJECT_ID",
  ] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("ISSUE_TRACKERS が未設定で GITHUB_TOKEN/GITHUB_REPO もなければ空", () => {
    const trackers = buildTrackers();
    expect(trackers.isEmpty).toBe(true);
  });

  it("ISSUE_TRACKERS 未設定でも GITHUB_TOKEN/GITHUB_REPO があれば github をデフォルト有効化する（後方互換）", () => {
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_REPO = "owner/repo";
    const trackers = buildTrackers();
    expect(trackers.isEmpty).toBe(false);
  });

  it("ISSUE_TRACKERS=github だが認証情報が無ければスキップされる", () => {
    process.env.ISSUE_TRACKERS = "github";
    const trackers = buildTrackers();
    expect(trackers.isEmpty).toBe(true);
  });

  it("ISSUE_TRACKERS で複数指定すると複数有効化される", () => {
    process.env.ISSUE_TRACKERS = "github,notion";
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_REPO = "owner/repo";
    process.env.NOTION_API_KEY = "key";
    process.env.NOTION_DATABASE_ID = "db1";
    const trackers = buildTrackers();
    expect(trackers.isEmpty).toBe(false);
  });

  it("jira は必須4変数が揃わないとスキップされる", () => {
    process.env.ISSUE_TRACKERS = "jira";
    process.env.JIRA_BASE_URL = "https://x.atlassian.net";
    // email/apiToken/projectKey 欠落
    const trackers = buildTrackers();
    expect(trackers.isEmpty).toBe(true);
  });

  it("jira は環境変数が一つも設定されていない場合もスキップされる", () => {
    process.env.ISSUE_TRACKERS = "jira";
    // JIRA_* を何も設定しない
    expect(buildTrackers().isEmpty).toBe(true);
  });

  it("jira は4変数すべて揃うと有効化される", () => {
    process.env.ISSUE_TRACKERS = "jira";
    process.env.JIRA_BASE_URL = "https://x.atlassian.net";
    process.env.JIRA_EMAIL = "a@example.com";
    process.env.JIRA_API_TOKEN = "tok";
    process.env.JIRA_PROJECT_KEY = "PROJ";
    expect(buildTrackers().isEmpty).toBe(false);
  });

  it("backlog は PROJECT_ID が数値でなければスキップされる", () => {
    process.env.ISSUE_TRACKERS = "backlog";
    process.env.BACKLOG_SPACE = "space";
    process.env.BACKLOG_API_KEY = "key";
    process.env.BACKLOG_PROJECT_ID = "not-a-number";
    expect(buildTrackers().isEmpty).toBe(true);
  });

  it("backlog は環境変数が一つも設定されていない場合もスキップされる", () => {
    process.env.ISSUE_TRACKERS = "backlog";
    // BACKLOG_* を何も設定しない
    expect(buildTrackers().isEmpty).toBe(true);
  });

  it("backlog は PROJECT_ID が数値なら有効化される", () => {
    process.env.ISSUE_TRACKERS = "backlog";
    process.env.BACKLOG_SPACE = "space";
    process.env.BACKLOG_API_KEY = "key";
    process.env.BACKLOG_PROJECT_ID = "123";
    expect(buildTrackers().isEmpty).toBe(false);
  });

  it("asana は ACCESS_TOKEN/PROJECT_ID が揃うと有効化される", () => {
    process.env.ISSUE_TRACKERS = "asana";
    process.env.ASANA_ACCESS_TOKEN = "tok";
    process.env.ASANA_PROJECT_ID = "proj1";
    expect(buildTrackers().isEmpty).toBe(false);
  });

  it("asana は認証情報が欠けるとスキップされる", () => {
    process.env.ISSUE_TRACKERS = "asana";
    expect(buildTrackers().isEmpty).toBe(true);
  });

  it("未知のトラッカー名は無視される", () => {
    process.env.ISSUE_TRACKERS = "unknown-tracker-xyz";
    expect(() => buildTrackers()).not.toThrow();
    expect(buildTrackers().isEmpty).toBe(true);
  });

  it("カンマ区切りの空白や大文字小文字を吸収する", () => {
    process.env.ISSUE_TRACKERS = " GitHub , notion ";
    process.env.GITHUB_TOKEN = "tok";
    process.env.GITHUB_REPO = "owner/repo";
    expect(buildTrackers().isEmpty).toBe(false);
  });
});
