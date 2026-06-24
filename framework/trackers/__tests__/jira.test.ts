import { describe, it, expect, vi, beforeEach } from "vitest";
import { JiraTracker } from "../jira";

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

function makeTracker() {
  return new JiraTracker("https://x.atlassian.net/", "a@example.com", "tok", "PROJ");
}

describe("JiraTracker", () => {
  it("baseUrl の末尾スラッシュを除去する", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ key: "PROJ-1" }) } as Response);
    await makeTracker().createIssue("t", "b", []);
    const [url] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://x.atlassian.net/rest/api/3/issue");
  });

  it("Authorization ヘッダーは Basic + base64(email:token)", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ key: "PROJ-1" }) } as Response);
    await makeTracker().createIssue("t", "b", []);
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    const expected = `Basic ${Buffer.from("a@example.com:tok").toString("base64")}`;
    expect((opts as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe(expected);
  });

  describe("createIssue", () => {
    it("成功時は browse URL を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ key: "PROJ-42" }) } as Response);
      const result = await makeTracker().createIssue("title", "body", ["bug"]);
      expect(result).toBe("https://x.atlassian.net/browse/PROJ-42");
    });

    it("失敗時は null を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 400, text: async () => "bad request" } as Response);
      expect(await makeTracker().createIssue("t", "b", [])).toBeNull();
    });

    it("レスポンスに key がなければ null を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      expect(await makeTracker().createIssue("t", "b", [])).toBeNull();
    });
  });

  describe("fetchOpenIssues", () => {
    it("issues を OpenIssue 形式にマッピングする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ issues: [{ key: "PROJ-1", fields: { summary: "Bug A", labels: ["bug"] } }] }),
      } as Response);
      const result = await makeTracker().fetchOpenIssues();
      expect(result).toEqual([{ number: "PROJ-1", title: "Bug A", labels: ["bug"] }]);
    });

    it("失敗時は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      expect(await makeTracker().fetchOpenIssues()).toEqual([]);
    });

    it("issues フィールドがなければ空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      expect(await makeTracker().fetchOpenIssues()).toEqual([]);
    });
  });

  describe("fetchClosedIssues", () => {
    it("description が文字列の場合は body に使う", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ issues: [{ key: "PROJ-2", fields: { summary: "Bug B", labels: [], description: "details here" } }] }),
      } as Response);
      const result = await makeTracker().fetchClosedIssues();
      expect(result[0].body).toBe("details here");
    });

    it("description が文字列以外（ADF オブジェクト等）なら空文字にする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ issues: [{ key: "PROJ-3", fields: { summary: "Bug C", labels: [], description: { type: "doc" } } }] }),
      } as Response);
      const result = await makeTracker().fetchClosedIssues();
      expect(result[0].body).toBe("");
    });

    it("失敗時は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      expect(await makeTracker().fetchClosedIssues()).toEqual([]);
    });

    it("issues フィールドがなければ空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      expect(await makeTracker().fetchClosedIssues()).toEqual([]);
    });
  });

  describe("commentOnIssue", () => {
    it("成功時は true を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);
      expect(await makeTracker().commentOnIssue("PROJ-1", "nice")).toBe(true);
    });

    it("失敗時は false を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" } as Response);
      expect(await makeTracker().commentOnIssue("PROJ-1", "nice")).toBe(false);
    });

    it("text() が失敗しても例外にならない", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false, status: 500, text: async () => { throw new Error("closed"); },
      } as unknown as Response);
      expect(await makeTracker().commentOnIssue("PROJ-1", "nice")).toBe(false);
    });
  });
});
