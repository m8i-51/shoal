import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../agent-loop", () => ({ createMessageWithRetry: vi.fn() }));
vi.mock("../findings", () => ({ saveFinding: vi.fn() }));

import * as fs from "fs";
import { createMessageWithRetry } from "../agent-loop";
import { saveFinding } from "../findings";
import { loadTestAccounts, runAccountManager, type TestAccount } from "../account-manager";
import type { ProductSpec } from "../product-discovery";
import type { LLMClient } from "../llm-client";
import type { Page, BrowserContext } from "playwright";
import type { Credentials } from "../../targets/types";

function makeFakeLocator(overrides: Record<string, unknown> = {}) {
  const locator = {
    first: vi.fn(() => locator),
    isVisible: vi.fn().mockResolvedValue(false),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return locator;
}

function makeFakePage(overrides: Record<string, unknown> = {}): Page {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    locator: vi.fn(() => makeFakeLocator()),
    getByRole: vi.fn(() => makeFakeLocator()),
    getByText: vi.fn(() => makeFakeLocator()),
    getByLabel: vi.fn(() => makeFakeLocator()),
    getByPlaceholder: vi.fn(() => makeFakeLocator()),
    screenshot: vi.fn().mockResolvedValue(Buffer.from("fake-png")),
    close: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue("page text"),
    ariaSnapshot: vi.fn().mockResolvedValue("aria tree"),
    on: vi.fn(),
    ...overrides,
  } as unknown as Page;
}

function makeLoggedInPage(overrides: Record<string, unknown> = {}): Page {
  const emailLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
  const passLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
  const submitLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
  return makeFakePage({
    locator: vi.fn((sel: string) => sel.includes("password") ? passLocator : sel.includes("submit") ? submitLocator : emailLocator),
    ...overrides,
  });
}

function makeFakeContext(page: Page): BrowserContext {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    storageState: vi.fn().mockResolvedValue({}),
  } as unknown as BrowserContext;
}

function makeSpec(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    appName: "TestApp", appDescription: "desc", targetUsers: "users", features: "f",
    designContext: "", uiFeatures: "", appGoals: [], confidence: "high", sources: [],
    ...overrides,
  };
}

function endTurn() {
  return { content: [], stop_reason: "end_turn", usage: {} };
}

function toolUseResponse(name: string, input: unknown, id = "t1") {
  return { content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage: {} };
}

const credentials: Credentials = { email: "seed@example.com", password: "pw" };

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue("[]" as unknown as ReturnType<typeof fs.readFileSync>);
  vi.mocked(fs.writeFileSync).mockReset().mockReturnValue(undefined);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(createMessageWithRetry).mockReset();
  vi.mocked(saveFinding).mockReset();
});

describe("loadTestAccounts", () => {
  it("ファイルが存在しない場合は空配列を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadTestAccounts()).toEqual([]);
  });

  it("ファイルが存在する場合はパースして返す", () => {
    const accounts: TestAccount[] = [{ email: "a@x.com", password: "p", role: "admin", storageStatePath: "/x.json" }];
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(accounts) as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadTestAccounts()).toEqual(accounts);
  });

  it("壊れた JSON の場合は空配列を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadTestAccounts()).toEqual([]);
  });
});

describe("runAccountManager", () => {
  it("ログインに失敗した場合は空配列を返しページを閉じる", async () => {
    // performLogin: email セレクタが一つも visible にならない -> false
    const page = makeFakePage();
    const context = makeFakeContext(page);
    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toEqual([]);
    expect(page.close).toHaveBeenCalled();
    expect(createMessageWithRetry).not.toHaveBeenCalled();
  });

  it("ログイン成功後 done が即座に呼ばれた場合は空配列を返す（ロールが見つからないケース）", async () => {
    const emailLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const passLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const submitLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const page = makeFakePage({
      locator: vi.fn((sel: string) => {
        if (sel.includes("password")) return passLocator;
        if (sel.includes("submit") || sel.includes("Login") || sel.includes("Sign in")) return submitLocator;
        return emailLocator;
      }),
    });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toEqual([]);
    expect(createMessageWithRetry).toHaveBeenCalledTimes(1);
  });

  it("end_turn（tool_use なし）でもループを終了する", async () => {
    const emailLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const passLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const submitLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const page = makeFakePage({
      locator: vi.fn((sel: string) => sel.includes("password") ? passLocator : sel.includes("submit") ? submitLocator : emailLocator),
    });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(endTurn() as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toEqual([]);
  });

  it("save_account で保存したアカウントは done 後にログイン・storageState 保存される", async () => {
    const emailLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const passLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const submitLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const seedPage = makeFakePage({
      locator: vi.fn((sel: string) => sel.includes("password") ? passLocator : sel.includes("submit") ? submitLocator : emailLocator),
    });
    const newAccountPage = makeFakePage({
      locator: vi.fn((sel: string) => sel.includes("password") ? passLocator : sel.includes("submit") ? submitLocator : emailLocator),
    });
    let pageCallCount = 0;
    const context = {
      newPage: vi.fn().mockImplementation(() => {
        pageCallCount++;
        return Promise.resolve(pageCallCount === 1 ? seedPage : newAccountPage);
      }),
      storageState: vi.fn().mockResolvedValue({}),
    } as unknown as BrowserContext;

    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("save_account", { email: "test-admin@example.com", password: "pw123", role: "admin" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ email: "test-admin@example.com", role: "admin" });
    expect(result[0].storageStatePath).not.toBe("");
    expect(context.storageState).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("save_account で必須フィールドが欠けている場合は保存しない", async () => {
    const emailLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const passLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const submitLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const page = makeFakePage({
      locator: vi.fn((sel: string) => sel.includes("password") ? passLocator : sel.includes("submit") ? submitLocator : emailLocator),
    });
    const context = makeFakeContext(page);

    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("save_account", { email: "x@y.com" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toEqual([]);
  });

  it("post_finding で saveFinding が呼ばれる", async () => {
    const emailLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const passLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const submitLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const page = makeFakePage({
      locator: vi.fn((sel: string) => sel.includes("password") ? passLocator : sel.includes("submit") ? submitLocator : emailLocator),
    });
    const context = makeFakeContext(page);

    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("post_finding", { title: "Confusing UI", body: "details" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(saveFinding).toHaveBeenCalledWith(expect.objectContaining({ title: "Confusing UI", category: "ux", runId: "run_1" }));
  });

  it("12 イテレーションに達するとループを終了する", async () => {
    const emailLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const passLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const submitLocator = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const page = makeFakePage({
      locator: vi.fn((sel: string) => sel.includes("password") ? passLocator : sel.includes("submit") ? submitLocator : emailLocator),
    });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValue(toolUseResponse("view_screen", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(createMessageWithRetry).toHaveBeenCalledTimes(12);
  });

  it("navigate は page.goto を呼んでスクリーンショットを撮る", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("navigate", { path: "/settings" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(page.goto).toHaveBeenCalledWith("https://example.com/settings", expect.any(Object));
    expect(page.screenshot).toHaveBeenCalled();
  });

  it("navigate で path が無い場合は page.goto を呼ばない", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("navigate", {}) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    // ログイン時の goto 以外で呼ばれていないことを確認
    expect(vi.mocked(page.goto).mock.calls).toHaveLength(1);
  });

  it("click は getByRole(button) で見つかった要素をクリックする", async () => {
    const clickableButton = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const page = makeLoggedInPage({ getByRole: vi.fn(() => clickableButton) });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("click", { description: "Save" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(clickableButton.click).toHaveBeenCalled();
  });

  it("click で description が無い場合はエラーになる（throw せず継続）", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("click", {}) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await expect(
      runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1")
    ).resolves.toBeDefined();
  });

  it("click で一致する要素が無い場合はエラーになるがループは継続する", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("click", { description: "Nonexistent button" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await expect(
      runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1")
    ).resolves.toEqual([]);
    expect(createMessageWithRetry).toHaveBeenCalledTimes(2);
  });

  it("fill は getByLabel で見つかった入力欄に値を入れる", async () => {
    const fillableInput = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true) });
    const page = makeLoggedInPage({ getByLabel: vi.fn(() => fillableInput) });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("fill", { label: "Email", value: "test@example.com" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(fillableInput.fill).toHaveBeenCalledWith("test@example.com", expect.any(Object));
  });

  it("fill で label/value が無い場合はエラーになる", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("fill", { label: "Email" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await expect(
      runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1")
    ).resolves.toEqual([]);
  });

  it("view_screen はスクリーンショットを撮る", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("view_screen", {}) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(page.screenshot).toHaveBeenCalled();
  });

  it("read_page_text は page.evaluate の結果をそのまま使う", async () => {
    const page = makeLoggedInPage({ evaluate: vi.fn().mockResolvedValue("visible page text") });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("read_page_text", {}) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await expect(
      runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1")
    ).resolves.toEqual([]);
    expect(page.evaluate).toHaveBeenCalled();
  });

  it("read_accessibility_tree は page.ariaSnapshot の結果をそのまま使う", async () => {
    const page = makeLoggedInPage({ ariaSnapshot: vi.fn().mockResolvedValue("tree dump") });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("read_accessibility_tree", {}) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(page.ariaSnapshot).toHaveBeenCalled();
  });
});
