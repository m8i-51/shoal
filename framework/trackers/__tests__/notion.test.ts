import { describe, it, expect, vi, beforeEach } from "vitest";
import { NotionTracker } from "../notion";

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

function makeTracker() {
  return new NotionTracker("secret-token", "db-123");
}

describe("NotionTracker", () => {
  describe("createIssue", () => {
    it("成功時は url を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ url: "https://notion.so/page1" }) } as Response);
      const result = await makeTracker().createIssue("title", "body", ["bug"]);
      expect(result).toBe("https://notion.so/page1");
      const [url, opts] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("https://api.notion.com/v1/pages");
      expect((opts as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer secret-token");
    });

    it("レスポンスに url がなければ null を返す", async () => {
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
      expect(await makeTracker().commentOnIssue("page-1", "nice")).toBe(true);
      const [, opts] = vi.mocked(fetch).mock.calls[0];
      expect(JSON.parse((opts as RequestInit).body as string).parent).toEqual({ page_id: "page-1" });
    });

    it("失敗時は false を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" } as Response);
      expect(await makeTracker().commentOnIssue("page-1", "nice")).toBe(false);
    });

    it("text() が失敗しても例外にならない", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false, status: 500, text: async () => { throw new Error("closed"); },
      } as unknown as Response);
      expect(await makeTracker().commentOnIssue("page-1", "nice")).toBe(false);
    });
  });

  describe("fetchOpenIssues", () => {
    it("Open ステータスでクエリし結果をマッピングする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ id: "p1", properties: { Name: { title: [{ plain_text: "Bug A" }] }, Labels: { multi_select: [{ name: "bug" }] } } }],
        }),
      } as Response);
      const result = await makeTracker().fetchOpenIssues();
      expect(result).toEqual([{ number: "p1", title: "Bug A", labels: ["bug"] }]);
      const [, opts] = vi.mocked(fetch).mock.calls[0];
      expect(JSON.parse((opts as RequestInit).body as string).filter.select.equals).toBe("Open");
    });

    it("Name/Labels が欠けている場合はフォールバックする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ results: [{ id: "p2", properties: {} }] }),
      } as Response);
      const result = await makeTracker().fetchOpenIssues();
      expect(result).toEqual([{ number: "p2", title: "(no title)", labels: [] }]);
    });

    it("失敗時は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      expect(await makeTracker().fetchOpenIssues()).toEqual([]);
    });

    it("results フィールドがなければ空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      expect(await makeTracker().fetchOpenIssues()).toEqual([]);
    });
  });

  describe("fetchClosedIssues", () => {
    it("Closed ステータスでクエリし body:'' を付与する", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ id: "p3", properties: { Name: { title: [{ plain_text: "Fixed bug" }] } } }],
        }),
      } as Response);
      const result = await makeTracker().fetchClosedIssues();
      expect(result).toEqual([{ number: "p3", title: "Fixed bug", labels: [], body: "" }]);
      const [, opts] = vi.mocked(fetch).mock.calls[0];
      expect(JSON.parse((opts as RequestInit).body as string).filter.select.equals).toBe("Closed");
    });
  });
});
