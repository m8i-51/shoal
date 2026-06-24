import { describe, it, expect, vi, beforeEach } from "vitest";
import { postGitHubIssue, fetchClosedIssues, fetchOpenIssues } from "../github";

vi.stubGlobal("fetch", vi.fn());

beforeEach(() => {
  vi.mocked(fetch).mockReset();
});

describe("postGitHubIssue", () => {
  it("token が空なら fetch せず null を返す", async () => {
    const result = await postGitHubIssue("t", "b", [], { token: "", repo: "owner/repo" });
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("repo が空なら fetch せず null を返す", async () => {
    const result = await postGitHubIssue("t", "b", [], { token: "tok", repo: "" });
    expect(result).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("成功時は html_url を返す", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: "https://github.com/owner/repo/issues/1" }),
    } as Response);
    const result = await postGitHubIssue("t", "b", ["bug"], { token: "tok", repo: "owner/repo" });
    expect(result).toBe("https://github.com/owner/repo/issues/1");
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/owner/repo/issues");
    expect((opts as RequestInit).method).toBe("POST");
  });

  it("レスポンスに html_url がなければ null を返す", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({}) } as Response);
    expect(await postGitHubIssue("t", "b", [], { token: "tok", repo: "owner/repo" })).toBeNull();
  });

  it("レスポンスが失敗（ok:false）なら null を返す", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ message: "Validation Failed" }),
    } as Response);
    expect(await postGitHubIssue("t", "b", [], { token: "tok", repo: "owner/repo" })).toBeNull();
  });
});

describe("fetchClosedIssues", () => {
  it("token/repo が空なら fetch せず空配列を返す", async () => {
    expect(await fetchClosedIssues({ token: "", repo: "" })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("issue を ClosedIssue 形式にマッピングする", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [
        { number: 1, title: "Bug A", body: "details", labels: [{ name: "bug" }, { name: "feedback-agent" }] },
      ],
    } as Response);
    const result = await fetchClosedIssues({ token: "tok", repo: "owner/repo" });
    expect(result).toEqual([{ number: 1, title: "Bug A", body: "details", labels: ["bug", "feedback-agent"] }]);
  });

  it("body が null/undefined の場合は空文字にフォールバックする", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [{ number: 1, title: "Bug A", body: null, labels: [] }],
    } as Response);
    const result = await fetchClosedIssues({ token: "tok", repo: "owner/repo" });
    expect(result[0].body).toBe("");
  });

  it("レスポンスが配列でない場合は空配列を返す", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => ({ message: "Not Found" }) } as Response);
    expect(await fetchClosedIssues({ token: "tok", repo: "owner/repo" })).toEqual([]);
  });
});

describe("fetchOpenIssues", () => {
  it("token/repo が空なら fetch せず空配列を返す", async () => {
    expect(await fetchOpenIssues({ token: "", repo: "" })).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("issue を { number, title, labels } 形式にマッピングする", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [{ number: 5, title: "UX issue", labels: [{ name: "ux" }] }],
    } as Response);
    const result = await fetchOpenIssues({ token: "tok", repo: "owner/repo" });
    expect(result).toEqual([{ number: 5, title: "UX issue", labels: ["ux"] }]);
  });

  it("レスポンスが配列でない場合は空配列を返す", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => null } as Response);
    expect(await fetchOpenIssues({ token: "tok", repo: "owner/repo" })).toEqual([]);
  });
});
