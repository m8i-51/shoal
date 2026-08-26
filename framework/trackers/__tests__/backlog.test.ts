import { describe, it, expect, vi, beforeEach } from "vitest";
import { BacklogTracker } from "../backlog";

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

function makeTracker() {
  return new BacklogTracker("myspace", "api-key-1", 42);
}

const ISSUE_TYPES = [
  { id: 11, name: "バグ" },
  { id: 22, name: "タスク" },
  { id: 33, name: "要望" },
];
const PRIORITIES = [
  { id: 2, name: "高" },
  { id: 3, name: "中" },
  { id: 4, name: "低" },
];

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function mockCatalogAndCreate(issueKey = "PROJ-1") {
  vi.mocked(fetch).mockImplementation(async (url, opts) => {
    const u = String(url);
    if (u.includes("/issueTypes")) return jsonResponse(ISSUE_TYPES);
    if (u.includes("/priorities")) return jsonResponse(PRIORITIES);
    if (u.includes("/issues") && (opts as RequestInit | undefined)?.method === "POST") {
      return jsonResponse({ issueKey });
    }
    return jsonResponse({}, false, 404);
  });
}

function postedForm(): URLSearchParams {
  const post = vi.mocked(fetch).mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "POST");
  expect(post).toBeDefined();
  return (post![1] as RequestInit).body as URLSearchParams;
}

describe("BacklogTracker", () => {
  it("baseUrl は space から構築され、apiKey がクエリパラメータに含まれる", async () => {
    mockCatalogAndCreate();
    await makeTracker().createIssue("t", "b", ["bug"]);
    const post = vi.mocked(fetch).mock.calls.find(([, opts]) => (opts as RequestInit | undefined)?.method === "POST");
    expect(post).toBeDefined();
    expect(String(post![0])).toContain("https://myspace.backlog.com/api/v2/issues?");
    expect(String(post![0])).toContain("apiKey=api-key-1");
  });

  describe("createIssue", () => {
    it("成功時は view URL を返す", async () => {
      mockCatalogAndCreate("PROJ-99");
      const result = await makeTracker().createIssue("title", "body", ["bug", "ux"]);
      expect(result).toBe("https://myspace.backlog.com/view/PROJ-99");
      const body = postedForm();
      expect(body.get("summary")).toBe("title");
      expect(body.get("description")).toContain("Labels: bug, ux");
    });

    it("bug はプロジェクトの「バグ」タイプと優先度「高」を使う", async () => {
      mockCatalogAndCreate();
      await makeTracker().createIssue("t", "b", ["bug"]);
      const body = postedForm();
      expect(body.get("issueTypeId")).toBe("11");
      expect(body.get("priorityId")).toBe("2");
    });

    it("feature-request は「要望」と優先度「中」を使う", async () => {
      mockCatalogAndCreate();
      await makeTracker().createIssue("t", "b", ["feature-request"]);
      const body = postedForm();
      expect(body.get("issueTypeId")).toBe("33");
      expect(body.get("priorityId")).toBe("3");
    });

    it("名前が一致しないタイプはモデルに選ばせる", async () => {
      vi.mocked(fetch).mockImplementation(async (url, opts) => {
        const u = String(url);
        if (u.includes("/issueTypes")) return jsonResponse([{ id: 9, name: "調査" }, { id: 8, name: "リリース" }]);
        if (u.includes("/priorities")) return jsonResponse(PRIORITIES);
        if ((opts as RequestInit | undefined)?.method === "POST") return jsonResponse({ issueKey: "PROJ-1" });
        return jsonResponse({}, false, 404);
      });
      const pickWithModel = vi.fn().mockImplementation(async (items: { id: string; name: string }[], _cat: string, kind: string) => {
        if (kind === "issueType") return items.find((i) => i.name === "調査") ?? null;
        return null;
      });
      const tracker = new BacklogTracker("myspace", "api-key-1", 42, pickWithModel);
      await tracker.createIssue("t", "b", ["bug"]);
      expect(pickWithModel).toHaveBeenCalled();
      expect(postedForm().get("issueTypeId")).toBe("9");
    });

    it("課題タイプ一覧が取れなければ起票しない（固定 ID は使わない）", async () => {
      vi.mocked(fetch).mockImplementation(async (url) => {
        const u = String(url);
        if (u.includes("/issueTypes")) return jsonResponse({}, false, 403);
        if (u.includes("/priorities")) return jsonResponse(PRIORITIES);
        return jsonResponse({ issueKey: "PROJ-1" });
      });
      expect(await makeTracker().createIssue("t", "b", ["bug"])).toBeNull();
      const posts = vi.mocked(fetch).mock.calls.filter(([, opts]) => (opts as RequestInit | undefined)?.method === "POST");
      expect(posts).toHaveLength(0);
    });

    it("レスポンスに issueKey がなければ null を返す", async () => {
      vi.mocked(fetch).mockImplementation(async (url, opts) => {
        const u = String(url);
        if (u.includes("/issueTypes")) return jsonResponse(ISSUE_TYPES);
        if (u.includes("/priorities")) return jsonResponse(PRIORITIES);
        if ((opts as RequestInit | undefined)?.method === "POST") return jsonResponse({});
        return jsonResponse({}, false, 404);
      });
      expect(await makeTracker().createIssue("t", "b", ["bug"])).toBeNull();
    });

    it("失敗時は null を返す", async () => {
      vi.mocked(fetch).mockImplementation(async (url, opts) => {
        const u = String(url);
        if (u.includes("/issueTypes")) return jsonResponse(ISSUE_TYPES);
        if (u.includes("/priorities")) return jsonResponse(PRIORITIES);
        if ((opts as RequestInit | undefined)?.method === "POST") {
          return { ok: false, status: 400, text: async () => "bad", json: async () => ({}) } as Response;
        }
        return jsonResponse({}, false, 404);
      });
      expect(await makeTracker().createIssue("t", "b", ["bug"])).toBeNull();
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
