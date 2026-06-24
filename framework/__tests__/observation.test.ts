import { describe, it, expect, vi } from "vitest";
import {
  setupObservation,
  getRecentConsoleLogs,
  getRecentNetworkErrors,
  readPageText,
  saveSnapshotBeforeAction,
  getDiffFromSnapshot,
  readAccessibilityTree,
  buildObservationWarning,
  type ObservationState,
} from "../observation";
import type { Page } from "playwright";

function makeFakePage() {
  const handlers: Record<string, (arg: unknown) => void> = {};
  const page = {
    on: vi.fn((event: string, cb: (arg: unknown) => void) => { handlers[event] = cb; }),
    evaluate: vi.fn(),
    ariaSnapshot: vi.fn(),
  };
  return { page: page as unknown as Page, handlers };
}

function makeState(overrides: Partial<ObservationState> = {}): ObservationState {
  return { consoleLogs: [], networkErrors: [], previousSnapshot: null, ...overrides };
}

describe("setupObservation", () => {
  it("console の error/warning のみ consoleLogs に追加する", () => {
    const { page, handlers } = makeFakePage();
    const state = setupObservation(page);
    handlers.console({ type: () => "error", text: () => "boom" });
    handlers.console({ type: () => "warning", text: () => "careful" });
    handlers.console({ type: () => "log", text: () => "info msg" });
    expect(state.consoleLogs).toHaveLength(2);
    expect(state.consoleLogs.map((l) => l.type)).toEqual(["error", "warning"]);
  });

  it("requestfailed は networkErrors に追加し failure().errorText を使う", () => {
    const { page, handlers } = makeFakePage();
    const state = setupObservation(page);
    handlers.requestfailed({
      url: () => "https://example.com/api",
      method: () => "POST",
      failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
    });
    expect(state.networkErrors).toHaveLength(1);
    expect(state.networkErrors[0]).toMatchObject({ url: "https://example.com/api", method: "POST", status: null, errorText: "net::ERR_CONNECTION_RESET" });
  });

  it("requestfailed で failure() が無い場合は errorText を unknown にフォールバックする", () => {
    const { page, handlers } = makeFakePage();
    const state = setupObservation(page);
    handlers.requestfailed({ url: () => "https://x.com", method: () => "GET", failure: () => null });
    expect(state.networkErrors[0].errorText).toBe("unknown");
  });

  it("response が 400 以上の場合は networkErrors に追加する", () => {
    const { page, handlers } = makeFakePage();
    const state = setupObservation(page);
    handlers.response({
      status: () => 404,
      url: () => "https://example.com/missing",
      request: () => ({ method: () => "GET" }),
    });
    expect(state.networkErrors).toHaveLength(1);
    expect(state.networkErrors[0]).toMatchObject({ status: 404, errorText: "HTTP 404" });
  });

  it("response が 400 未満の場合は追加しない", () => {
    const { page, handlers } = makeFakePage();
    const state = setupObservation(page);
    handlers.response({ status: () => 200, url: () => "https://example.com/ok", request: () => ({ method: () => "GET" }) });
    expect(state.networkErrors).toHaveLength(0);
  });

  it("response の URL が /_next/ を含む場合は除外する", () => {
    const { page, handlers } = makeFakePage();
    const state = setupObservation(page);
    handlers.response({ status: () => 404, url: () => "https://example.com/_next/static/x.js", request: () => ({ method: () => "GET" }) });
    expect(state.networkErrors).toHaveLength(0);
  });
});

describe("getRecentConsoleLogs / getRecentNetworkErrors", () => {
  it("limit で直近 N 件に絞る", () => {
    const state = makeState({
      consoleLogs: Array.from({ length: 5 }, (_, i) => ({ type: "error" as const, text: `e${i}`, timestamp: "" })),
    });
    const result = getRecentConsoleLogs(state, 2);
    expect(result.map((l) => l.text)).toEqual(["e3", "e4"]);
  });

  it("デフォルトの limit は 10", () => {
    const state = makeState({
      networkErrors: Array.from({ length: 15 }, (_, i) => ({ url: `u${i}`, method: "GET", status: 500, errorText: "", timestamp: "" })),
    });
    expect(getRecentNetworkErrors(state)).toHaveLength(10);
  });
});

describe("readPageText", () => {
  it("page.evaluate の結果を返す", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.evaluate).mockResolvedValue("hello world");
    expect(await readPageText(page)).toBe("hello world");
  });

  it("maxLength を超える場合は切り詰めて (truncated) を付ける", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.evaluate).mockResolvedValue("a".repeat(100));
    const result = await readPageText(page, 10);
    expect(result).toBe("a".repeat(10) + "\n...(truncated)");
  });
});

describe("saveSnapshotBeforeAction", () => {
  it("ariaSnapshot の結果を previousSnapshot に保存する", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockResolvedValue("snapshot text");
    const state = makeState();
    await saveSnapshotBeforeAction(page, state);
    expect(state.previousSnapshot).toBe("snapshot text");
  });

  it("ariaSnapshot が失敗しても例外を投げない（previousSnapshot は変化なし）", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockRejectedValue(new Error("navigation in progress"));
    const state = makeState();
    await expect(saveSnapshotBeforeAction(page, state)).resolves.toBeUndefined();
    expect(state.previousSnapshot).toBeNull();
  });
});

describe("getDiffFromSnapshot", () => {
  it("previousSnapshot が無い場合は (no previous snapshot)", async () => {
    const { page } = makeFakePage();
    expect(await getDiffFromSnapshot(page, makeState())).toBe("(no previous snapshot)");
  });

  it("ariaSnapshot が失敗した場合は (failed to get snapshot)", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockRejectedValue(new Error("x"));
    expect(await getDiffFromSnapshot(page, makeState({ previousSnapshot: "old" }))).toBe("(failed to get snapshot)");
  });

  it("差分が無い場合は no changes", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockResolvedValue("line1\nline2");
    expect(await getDiffFromSnapshot(page, makeState({ previousSnapshot: "line1\nline2" }))).toBe("no changes");
  });

  it("追加・削除された行を added/removed として表示する", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockResolvedValue("line1\nline3");
    const result = await getDiffFromSnapshot(page, makeState({ previousSnapshot: "line1\nline2" }));
    expect(result).toContain("added:\n+ line3");
    expect(result).toContain("removed:\n- line2");
  });

  it("[ref=xxx] 表記を正規化してから比較する（同一とみなす）", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockResolvedValue("button [ref=e2]");
    const result = await getDiffFromSnapshot(page, makeState({ previousSnapshot: "button [ref=e1]" }));
    expect(result).toBe("no changes");
  });

  it("maxLength を超える場合は省略表記にする", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockResolvedValue(Array.from({ length: 50 }, (_, i) => `new-line-${i}`).join("\n"));
    const result = await getDiffFromSnapshot(page, makeState({ previousSnapshot: "old" }), 50);
    expect(result.endsWith("...(省略)")).toBe(true);
  });
});

describe("readAccessibilityTree", () => {
  it("ariaSnapshot の結果を返す", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockResolvedValue("tree");
    expect(await readAccessibilityTree(page)).toBe("tree");
  });

  it("maxLength を超える場合は省略表記にする", async () => {
    const { page } = makeFakePage();
    vi.mocked(page.ariaSnapshot).mockResolvedValue("a".repeat(20));
    const result = await readAccessibilityTree(page, 10);
    expect(result).toBe("a".repeat(10) + "\n...(省略)");
  });
});

describe("buildObservationWarning", () => {
  it("エラーが無い場合は null", () => {
    expect(buildObservationWarning(makeState())).toBeNull();
  });

  it("JS エラーがある場合は直近3件を含める", () => {
    const state = makeState({
      consoleLogs: Array.from({ length: 5 }, (_, i) => ({ type: "error" as const, text: `err${i}`, timestamp: "" })),
    });
    const result = buildObservationWarning(state);
    expect(result).toContain("JS errors:");
    expect(result).toContain("err2 | err3 | err4");
    expect(result).not.toContain("err0");
  });

  it("warning は JS errors に含めない", () => {
    const state = makeState({ consoleLogs: [{ type: "warning", text: "w", timestamp: "" }] });
    expect(buildObservationWarning(state)).toBeNull();
  });

  it("status:null または 500 以上のネットワークエラーを fatal として含める", () => {
    const state = makeState({
      networkErrors: [
        { url: "https://x.com/a", method: "GET", status: 404, errorText: "HTTP 404", timestamp: "" },
        { url: "https://x.com/b", method: "POST", status: 500, errorText: "HTTP 500", timestamp: "" },
        { url: "https://x.com/c", method: "GET", status: null, errorText: "net::FAILED", timestamp: "" },
      ],
    });
    const result = buildObservationWarning(state);
    expect(result).toContain("network errors:");
    expect(result).toContain("/b");
    expect(result).toContain("/c");
    expect(result).not.toContain("/a");
  });
});
