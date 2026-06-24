import { describe, it, expect, vi, beforeEach } from "vitest";
import { BacklogTracker } from "../backlog";

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

function makeTracker() {
  return new BacklogTracker("myspace", "api-key-1", 42);
}

describe("BacklogTracker", () => {
  it("baseUrl は space から構築され、apiKey がクエリパラメータに含まれる", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ issueKey: "PROJ-1" }) } as Response);
    await makeTracker().createIssue("t", "b", []);
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toContain("https://myspace.backlog.com/api/v2/issues?");
    expect(url).toContain("apiKey=api-key-1");
  });

  describe("createIssue", () => {
    it("成功時は view URL を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ issueKey: "PROJ-99" }) } as Response);
      const result = await makeTracker().createIssue("title", "body", ["bug", "ux"]);
      expect(result).toBe("https://myspace.backlog.com/view/PROJ-99");
      const [, opts] = vi.mocked(fetch).mock.calls[0];
      const body = (opts as RequestInit).body as URLSearchParams;
      expect(body.get("summary")).toBe("title");
      expect(body.get("description")).toContain("Labels: bug, ux");
    });

    it("レスポンスに issueKey がなければ null を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      expect(await makeTracker().createIssue("t", "b", [])).toBeNull();
    });

    it("失敗時は null を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400, text: async () => "bad" } as Response);
      expect(await makeTracker().createIssue("t", "b", [])).toBeNull();
    });
  });

  describe("commentOnIssue", () => {
    it("成功時は true を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
      expect(await makeTracker().commentOnIssue(123, "nice")).toBe(true);
      const [url] = vi.mocked(fetch).mock.calls[0];
      expect(url).toContain("/issues/123/comments");
    });

    it("失敗時は false を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" } as Response);
      expect(await makeTracker().commentOnIssue(123, "nice")).toBe(false);
    });

    it("text() が失敗しても例外にならない", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false, status: 500, text: async () => { throw new Error("closed"); },
      } as unknown as Response);
      expect(await makeTracker().commentOnIssue(123, "nice")).toBe(false);
    });
  });

  describe("fetchOpenIssues", () => {
    it("issueKey/summary を OpenIssue 形式にマッピングする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => [{ issueKey: "PROJ-1", summary: "Bug A" }],
      } as Response);
      const result = await makeTracker().fetchOpenIssues();
      expect(result).toEqual([{ number: "PROJ-1", title: "Bug A", labels: [] }]);
    });

    it("失敗時は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      expect(await makeTracker().fetchOpenIssues()).toEqual([]);
    });

    it("レスポンスが配列でない場合は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ error: "x" }) } as Response);
      expect(await makeTracker().fetchOpenIssues()).toEqual([]);
    });
  });

  describe("fetchClosedIssues", () => {
    it("description を body にマッピングする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => [{ issueKey: "PROJ-2", summary: "Fixed bug", description: "details" }],
      } as Response);
      const result = await makeTracker().fetchClosedIssues();
      expect(result).toEqual([{ number: "PROJ-2", title: "Fixed bug", body: "details", labels: [] }]);
    });

    it("description が無い場合は空文字にフォールバックする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => [{ issueKey: "PROJ-3", summary: "Fixed bug" }],
      } as Response);
      const result = await makeTracker().fetchClosedIssues();
      expect(result[0].body).toBe("");
    });

    it("失敗時は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      expect(await makeTracker().fetchClosedIssues()).toEqual([]);
    });

    it("レスポンスが配列でない場合は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      expect(await makeTracker().fetchClosedIssues()).toEqual([]);
    });
  });
});
