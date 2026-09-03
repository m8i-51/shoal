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
      text: async () => JSON.stringify({ message: "Validation Failed" }),
    } as Response);
    expect(await postGitHubIssue("t", "b", [], { token: "tok", repo: "owner/repo" })).toBeNull();
  });

  it("失敗レスポンスの本文が読めなくても落ちない", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => { throw new Error("body already consumed"); },
    } as unknown as Response);
    expect(await postGitHubIssue("t", "b", [], { token: "tok", repo: "owner/repo" })).toBeNull();
  });

  it("Authorization ヘッダは Bearer 形式を使う", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ html_url: "https://github.com/owner/repo/issues/1" }),
    } as Response);
    await postGitHubIssue("t", "b", [], { token: "tok", repo: "owner/repo" });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });

  it("成功レスポンスの本文が不正な JSON でも例外にせず null を返す", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("Unexpected token"); },
    } as unknown as Response);
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
        { number: 1, title: "Bug A", body: "details", labels: [{ name: "bug" }, { name: "feedback-agent" }], html_url: "https://github.com/owner/repo/issues/1", state_reason: "completed" },
      ],
    } as Response);
    const result = await fetchClosedIssues({ token: "tok", repo: "owner/repo" });
    expect(result).toEqual([{ number: 1, title: "Bug A", body: "details", labels: ["bug", "feedback-agent"], url: "https://github.com/owner/repo/issues/1", stateReason: "completed" }]);
  });

  it("html_url / state_reason がない issue は url=undefined, stateReason=null になる", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [{ number: 2, title: "Bug B", body: "", labels: [] }],
    } as Response);
    const result = await fetchClosedIssues({ token: "tok", repo: "owner/repo" });
    expect(result[0].url).toBeUndefined();
    expect(result[0].stateReason).toBeNull();
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

  it("1 ページ目が満杯（100件）なら 2 ページ目も取得する", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, body: "", labels: [] }));
    const page2 = [{ number: 101, title: "Issue 101", body: "", labels: [] }];
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response);

    const result = await fetchClosedIssues({ token: "tok", repo: "owner/repo" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(101);
    expect(result[100].number).toBe(101);
    const [firstUrl] = vi.mocked(fetch).mock.calls[0];
    const [secondUrl] = vi.mocked(fetch).mock.calls[1];
    expect(String(firstUrl)).toContain("page=1");
    expect(String(secondUrl)).toContain("page=2");
  });

  it("満杯でないページで打ち切り、それ以上ページを取りに行かない", async () => {
    const page1 = [{ number: 1, title: "Only issue", body: "", labels: [] }];
    vi.mocked(fetch).mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response);

    const result = await fetchClosedIssues({ token: "tok", repo: "owner/repo" });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it("MAX_PAGES（10）を超えて無限にページを取りに行かない", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({ number: i, title: "x", body: "", labels: [] }));
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => fullPage } as Response);

    const result = await fetchClosedIssues({ token: "tok", repo: "owner/repo" });

    expect(fetch).toHaveBeenCalledTimes(10);
    expect(result).toHaveLength(1000);
  });

  it("途中のページが失敗したら truncate を throw する（部分リストを完全扱いしない）", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i, title: "x", body: "", labels: [] }));
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => "Bad Gateway" } as Response);

    await expect(fetchClosedIssues({ token: "tok", repo: "owner/repo" })).rejects.toThrow(/truncated/);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("1 ページ目が失敗したら空配列を返す（ソフトフェイル）", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response);

    expect(await fetchClosedIssues({ token: "tok", repo: "owner/repo" })).toEqual([]);
  });

  it("labels が null / 欠落でも TypeError にせず空配列にフォールバックする", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [
        { number: 1, title: "No labels key", body: "" },
        { number: 2, title: "Null labels", body: "", labels: null },
      ],
    } as Response);
    const result = await fetchClosedIssues({ token: "tok", repo: "owner/repo" });
    expect(result).toEqual([
      { number: 1, title: "No labels key", body: "", labels: [], url: undefined, stateReason: null },
      { number: 2, title: "Null labels", body: "", labels: [], url: undefined, stateReason: null },
    ]);
  });

  it("Authorization ヘッダは Bearer 形式を使う", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
    await fetchClosedIssues({ token: "tok", repo: "owner/repo" });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
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

  it("1 ページ目が満杯（100件）なら 2 ページ目も取得する", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, labels: [] }));
    const page2 = [{ number: 101, title: "Issue 101", labels: [] }];
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => page1 } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => page2 } as Response);

    const result = await fetchOpenIssues({ token: "tok", repo: "owner/repo" });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toHaveLength(101);
  });

  it("labels が欠落していても TypeError にしない", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => [{ number: 5, title: "UX issue" }],
    } as Response);
    const result = await fetchOpenIssues({ token: "tok", repo: "owner/repo" });
    expect(result).toEqual([{ number: 5, title: "UX issue", labels: [] }]);
  });

  it("Authorization ヘッダは Bearer 形式を使う", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, json: async () => [] } as Response);
    await fetchOpenIssues({ token: "tok", repo: "owner/repo" });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts as RequestInit).headers).toMatchObject({ Authorization: "Bearer tok" });
  });
});
