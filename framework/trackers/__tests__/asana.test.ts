import { describe, it, expect, vi, beforeEach } from "vitest";
import { AsanaTracker } from "../asana";

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

function makeTracker() {
  return new AsanaTracker("secret-token", "proj-123");
}

describe("AsanaTracker", () => {
  describe("createIssue", () => {
    it("成功時は permalink_url を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: { gid: "task1", permalink_url: "https://app.asana.com/0/proj-123/task1" } }),
      } as Response);
      const result = await makeTracker().createIssue("title", "body", ["bug"]);
      expect(result).toBe("https://app.asana.com/0/proj-123/task1");
      const [, opts] = vi.mocked(fetch).mock.calls[0];
      expect((opts as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer secret-token");
    });

    it("permalink_url が無ければ gid から URL を組み立てる", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: { gid: "task2" } }),
      } as Response);
      const result = await makeTracker().createIssue("t", "b", []);
      expect(result).toBe("https://app.asana.com/0/proj-123/task2");
    });

    it("gid がなければ null を返す", async () => {
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
      expect(await makeTracker().commentOnIssue("task1", "nice")).toBe(true);
      const [url] = vi.mocked(fetch).mock.calls[0];
      expect(url).toBe("https://app.asana.com/api/1.0/tasks/task1/stories");
    });

    it("失敗時は false を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403, text: async () => "forbidden" } as Response);
      expect(await makeTracker().commentOnIssue("task1", "nice")).toBe(false);
    });

    it("text() が失敗しても例外にならない", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false, status: 500, text: async () => { throw new Error("closed"); },
      } as unknown as Response);
      expect(await makeTracker().commentOnIssue("task1", "nice")).toBe(false);
    });
  });

  describe("fetchOpenIssues", () => {
    it("gid/name を OpenIssue 形式にマッピングする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ gid: "task1", name: "Bug A" }] }),
      } as Response);
      const result = await makeTracker().fetchOpenIssues();
      expect(result).toEqual([{ number: "task1", title: "Bug A", labels: [] }]);
    });

    it("失敗時は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      expect(await makeTracker().fetchOpenIssues()).toEqual([]);
    });

    it("data フィールドがなければ空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      expect(await makeTracker().fetchOpenIssues()).toEqual([]);
    });
  });

  describe("fetchClosedIssues", () => {
    it("notes を body にマッピングする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ gid: "task2", name: "Fixed bug", notes: "details" }] }),
      } as Response);
      const result = await makeTracker().fetchClosedIssues();
      expect(result).toEqual([{ number: "task2", title: "Fixed bug", body: "details", labels: [] }]);
    });

    it("notes が無い場合は空文字にフォールバックする", async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: async () => ({ data: [{ gid: "task3", name: "Fixed bug" }] }),
      } as Response);
      const result = await makeTracker().fetchClosedIssues();
      expect(result[0].body).toBe("");
    });

    it("失敗時は空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
      expect(await makeTracker().fetchClosedIssues()).toEqual([]);
    });

    it("data フィールドがなければ空配列を返す", async () => {
      vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
      expect(await makeTracker().fetchClosedIssues()).toEqual([]);
    });
  });
});
