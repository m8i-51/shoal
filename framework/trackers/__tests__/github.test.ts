import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../github", () => ({
  postGitHubIssue: vi.fn(),
  fetchOpenIssues: vi.fn(),
  fetchClosedIssues: vi.fn(),
}));

import { postGitHubIssue, fetchOpenIssues, fetchClosedIssues } from "../../github";
import { GitHubTracker } from "../github";

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GitHubTracker", () => {
  it("name は github、isEmpty は常に false", () => {
    const tracker = new GitHubTracker("tok", "owner/repo");
    expect(tracker.name).toBe("github");
    expect(tracker.isEmpty).toBe(false);
  });

  it("createIssue は framework/github.ts の postGitHubIssue に委譲する", async () => {
    vi.mocked(postGitHubIssue).mockResolvedValue("https://github.com/owner/repo/issues/1");
    const tracker = new GitHubTracker("tok", "owner/repo");
    const result = await tracker.createIssue("title", "body", ["bug"]);
    expect(result).toBe("https://github.com/owner/repo/issues/1");
    expect(postGitHubIssue).toHaveBeenCalledWith("title", "body", ["bug"], { token: "tok", repo: "owner/repo" });
  });

  it("fetchOpenIssues は framework/github.ts に委譲する", async () => {
    vi.mocked(fetchOpenIssues).mockResolvedValue([{ number: 1, title: "A", labels: [] }]);
    const tracker = new GitHubTracker("tok", "owner/repo");
    expect(await tracker.fetchOpenIssues()).toEqual([{ number: 1, title: "A", labels: [] }]);
  });

  it("fetchClosedIssues は framework/github.ts に委譲する", async () => {
    vi.mocked(fetchClosedIssues).mockResolvedValue([{ number: 1, title: "A", body: "", labels: [] }]);
    const tracker = new GitHubTracker("tok", "owner/repo");
    expect(await tracker.fetchClosedIssues()).toEqual([{ number: 1, title: "A", body: "", labels: [] }]);
  });

  describe("commentOnIssue", () => {
    it("成功時は true を返し正しい URL/ヘッダーで POST する", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
      const tracker = new GitHubTracker("tok", "owner/repo");
      const result = await tracker.commentOnIssue(42, "nice work");
      expect(result).toBe(true);
      const [url, opts] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("https://api.github.com/repos/owner/repo/issues/42/comments");
      expect((opts as RequestInit).method).toBe("POST");
      expect(JSON.parse((opts as RequestInit).body as string)).toEqual({ body: "nice work" });
    });

    it("失敗時は false を返す（エラーメッセージのテキスト取得も行う）", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Not Found",
      } as Response);
      const tracker = new GitHubTracker("tok", "owner/repo");
      expect(await tracker.commentOnIssue(42, "x")).toBe(false);
    });

    it("text() が失敗しても例外にならず false を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => { throw new Error("stream closed"); },
      } as unknown as Response);
      const tracker = new GitHubTracker("tok", "owner/repo");
      expect(await tracker.commentOnIssue(42, "x")).toBe(false);
    });
  });
});
