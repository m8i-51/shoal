import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../llm-retry", () => ({ createMessageWithRetry: vi.fn() }));
vi.mock("../findings", () => ({ saveFinding: vi.fn() }));

import * as fs from "fs";
import { createMessageWithRetry } from "../llm-retry";
import { saveFinding } from "../findings";
import { loadTestAccounts, inspectAccountsFile, resolveAccountSetup, runAccountManager, persistAccountSessions, loginCandidateUrls, resolveLoginUrl, planBrowserAuth, authPrompt, describeAuthPlan, loginLooksEstablished, storageStateHasSession, describeLoginFailure, pickAdminAccount, type TestAccount } from "../account-manager";
import type { ProductSpec } from "../product-discovery";
import type { LLMClient } from "../llm-client";
import type { Page, BrowserContext } from "playwright";
import type { Credentials } from "../../targets/types";

function makeFakeLocator(overrides: Record<string, unknown> = {}) {
  const locator = {
    first: vi.fn(() => locator),
    count: vi.fn().mockResolvedValue(0),
    isVisible: vi.fn().mockResolvedValue(false),
    fill: vi.fn().mockResolvedValue(undefined),
    click: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return locator;
}

const SAVED_SESSION_STATE = {
  cookies: [{ name: "session", value: "abc" }],
  origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "t" }] }],
};

function makeFakePage(overrides: Record<string, unknown> = {}): Page {
  let currentUrl = "";
  return {
    goto: vi.fn(async (url: string) => { currentUrl = url; }),
    url: vi.fn(() => currentUrl),
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

/** Login form that can stay put, hide in-place (SPA), or navigate away after submit. */
function makeSessionPage(opts: {
  formVisibleOn?: (url: string) => boolean;
  afterSubmit?: "leave-login" | "spa-hide-form" | "stay-on-form";
  overrides?: Record<string, unknown>;
} = {}): Page {
  let currentUrl = "";
  let formVisible = false;
  let sessionHeld = false;
  const formVisibleOn = opts.formVisibleOn ?? ((url: string) => url.length > 0);
  const afterSubmit = opts.afterSubmit ?? "leave-login";

  const showFormIfOnLogin = () => {
    // SPA / localStorage auth: the form does not come back after a session is held.
    if (sessionHeld) {
      formVisible = false;
      return;
    }
    formVisible = formVisibleOn(currentUrl);
  };

  const emailLocator = makeFakeLocator({ isVisible: vi.fn(async () => formVisible) });
  const passLocator = makeFakeLocator({ isVisible: vi.fn(async () => formVisible) });
  const submitLocator = makeFakeLocator({
    isVisible: vi.fn(async () => formVisible),
    click: vi.fn(async () => {
      if (afterSubmit === "leave-login") {
        try {
          currentUrl = new URL("/", currentUrl).toString();
        } catch {
          currentUrl = "https://example.com/";
        }
        formVisible = false;
        sessionHeld = true;
      } else if (afterSubmit === "spa-hide-form") {
        formVisible = false;
        sessionHeld = true;
      }
    }),
  });

  return makeFakePage({
    goto: vi.fn(async (url: string) => {
      currentUrl = url;
      showFormIfOnLogin();
    }),
    url: vi.fn(() => currentUrl),
    locator: vi.fn((sel: string) => {
      if (sel.includes("password")) return passLocator;
      if (sel.includes("submit") || sel.includes("Login") || sel.includes("Sign in") || sel.includes("ログイン") || sel.includes("サインイン")) {
        return submitLocator;
      }
      return emailLocator;
    }),
    ...opts.overrides,
  });
}

function makeLoggedInPage(overrides: Record<string, unknown> = {}): Page {
  return makeSessionPage({ afterSubmit: "leave-login", overrides });
}

function makeFakeContext(page: Page, extras: Record<string, unknown> = {}): BrowserContext {
  return {
    newPage: vi.fn().mockResolvedValue(page),
    storageState: vi.fn().mockResolvedValue(SAVED_SESSION_STATE),
    clearCookies: vi.fn().mockResolvedValue(undefined),
    browser: vi.fn().mockReturnValue(null),
    ...extras,
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

  it("storageStatePath や role が無くても正規化する", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([{ email: "a@x.com", password: "p" }]) as unknown as ReturnType<typeof fs.readFileSync>,
    );
    expect(loadTestAccounts()).toEqual([{ email: "a@x.com", password: "p", role: "user", storageStatePath: "" }]);
  });

  it("壊れた JSON の場合は空配列を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadTestAccounts()).toEqual([]);
  });
});

describe("inspectAccountsFile", () => {
  it("ファイルが無い場合は missing", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(inspectAccountsFile().state).toBe("missing");
  });

  it("壊れた JSON は invalid-json", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("{" as unknown as ReturnType<typeof fs.readFileSync>);
    const result = inspectAccountsFile();
    expect(result.state).toBe("invalid-json");
  });

  it("配列でない JSON は not-array", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({ email: "a@x.com" }) as unknown as ReturnType<typeof fs.readFileSync>);
    expect(inspectAccountsFile().state).toBe("not-array");
  });

  it("空配列は empty", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("[]" as unknown as ReturnType<typeof fs.readFileSync>);
    expect(inspectAccountsFile().state).toBe("empty");
  });
});

describe("resolveAccountSetup", () => {
  it("config credentials があればそれをシードにする", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const plan = resolveAccountSetup({ email: "admin@example.com", password: "secret" });
    expect(plan.action).toBe("run");
    if (plan.action !== "run") return;
    expect(plan.seedSource).toBe("config");
    expect(plan.seed).toEqual({ email: "admin@example.com", password: "secret" });
    expect(plan.logs.some((l) => l.includes("config credentials: present"))).toBe(true);
    expect(plan.logs.some((l) => l.includes("starting"))).toBe(true);
  });

  it("accounts.json に使えるアカウントがあれば探索せずセッション保存だけにする", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([
        { email: "test@example.com", password: "testpassword", role: "user" },
        { email: "admin@example.com", password: "adminpassword", role: "admin" },
      ]) as unknown as ReturnType<typeof fs.readFileSync>,
    );
    const plan = resolveAccountSetup(undefined);
    expect(plan.action).toBe("persist");
    if (plan.action !== "persist") return;
    expect(plan.existing).toHaveLength(2);
    expect(plan.logs.some((l) => l.includes("loaded 2 account(s)"))).toBe(true);
    expect(plan.logs.some((l) => l.includes("capturing sessions only"))).toBe(true);
  });

  it("どちらも無い場合はスキップ理由をログする", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const plan = resolveAccountSetup(undefined);
    expect(plan.action).toBe("skip");
    expect(plan.logs.some((l) => l.includes("accounts.json: not found"))).toBe(true);
    expect(plan.logs.some((l) => l.includes("config credentials: not set"))).toBe(true);
    expect(plan.logs.some((l) => l.includes("skipped"))).toBe(true);
  });

  it("accounts.json があるのに email/password が無い場合はスキップ理由を出す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([{ role: "user", storageStatePath: "/x.json" }]) as unknown as ReturnType<typeof fs.readFileSync>,
    );
    const plan = resolveAccountSetup(undefined);
    expect(plan.action).toBe("skip");
    expect(plan.logs.some((l) => l.includes("skipped"))).toBe(true);
    expect(plan.logs.some((l) => /email and password/.test(l) || /empty/.test(l))).toBe(true);
  });

  it("壊れた accounts.json は読んだこととスキップ理由を出す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    const plan = resolveAccountSetup(undefined);
    expect(plan.action).toBe("skip");
    expect(plan.logs.some((l) => l.includes("could not parse"))).toBe(true);
    expect(plan.logs.some((l) => l.includes("skipped"))).toBe(true);
  });

  it("accounts.json にアカウントがあるときは config credentials があっても探索しない", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([{ email: "file@example.com", password: "filepw", role: "user" }]) as unknown as ReturnType<typeof fs.readFileSync>,
    );
    const plan = resolveAccountSetup({ email: "config@example.com", password: "configpw" });
    expect(plan.action).toBe("persist");
    if (plan.action !== "persist") return;
    expect(plan.existing[0].email).toBe("file@example.com");
    expect(plan.logs.some((l) => l.includes("capturing sessions only"))).toBe(true);
  });
});

describe("runAccountManager", () => {
  it("ログインに失敗した場合は資格情報を残して返し、ページを閉じる", async () => {
    // performLogin: email セレクタが一つも visible にならない -> false
    const page = makeFakePage();
    const context = makeFakeContext(page);
    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toEqual([{ email: "seed@example.com", password: "pw", role: "user", storageStatePath: "" }]);
    expect(page.close).toHaveBeenCalled();
    expect(createMessageWithRetry).not.toHaveBeenCalled();
  });

  it("ログイン成功後 done が即座に呼ばれた場合はシードアカウントのセッションを返す", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ email: "seed@example.com", role: "user" });
    expect(result[0].storageStatePath).not.toBe("");
    expect(createMessageWithRetry).toHaveBeenCalledTimes(1);
  });

  it("end_turn（tool_use なし）でもループを終了する", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(endTurn() as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("seed@example.com");
  });

  it("save_account で保存したアカウントは done 後に isolated context で storageState 保存される", async () => {
    const seedPage = makeLoggedInPage();
    const extraPage = makeSessionPage({ afterSubmit: "leave-login" });
    const isolatedContext = {
      newPage: vi.fn().mockResolvedValue(extraPage),
      storageState: vi.fn().mockResolvedValue(SAVED_SESSION_STATE),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = { newContext: vi.fn().mockResolvedValue(isolatedContext) };
    const context = makeFakeContext(seedPage, { browser: vi.fn().mockReturnValue(browser) });

    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("save_account", { email: "test-admin@example.com", password: "pw123", role: "admin" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toHaveLength(2);
    expect(result.map((a) => a.email)).toEqual(["seed@example.com", "test-admin@example.com"]);
    expect(result[1]).toMatchObject({ email: "test-admin@example.com", role: "admin" });
    expect(result[1].storageStatePath).not.toBe("");
    expect(context.clearCookies).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalled();
    expect(isolatedContext.storageState).toHaveBeenCalled();
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("save_account で必須フィールドが欠けている場合は保存しない", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);

    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("save_account", { email: "x@y.com" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toHaveLength(1);
    expect(result[0].email).toBe("seed@example.com");
  });

  it("post_finding で saveFinding が呼ばれる", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);

    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("post_finding", { title: "Confusing UI", body: "details" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(saveFinding).toHaveBeenCalledWith(expect.objectContaining({ title: "Confusing UI", category: "ux", runId: "run_1" }));
  });

  it("12 イテレーションに達するとループを終了する", async () => {
    const page = makeLoggedInPage();
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
    // ログイン時の goto 以外で呼ばれていないことを確認（セッションは同じ context から保存し、再ログインしない）
    expect(vi.mocked(page.goto).mock.calls).toHaveLength(1);
  });

  it("click は getByRole(button) で見つかった要素をクリックする", async () => {
    const clickableButton = makeFakeLocator({ isVisible: vi.fn().mockResolvedValue(true), count: vi.fn().mockResolvedValue(1) });
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
    ).resolves.toMatchObject([{ email: "seed@example.com" }]);
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
    ).resolves.toMatchObject([{ email: "seed@example.com" }]);
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
    ).resolves.toMatchObject([{ email: "seed@example.com" }]);
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

  it("accounts.json の既存アカウントも isolated context でセッション保存する（LLM が新規作成しなくても）", async () => {
    const page = makeLoggedInPage();
    const extraPage = makeSessionPage({ afterSubmit: "leave-login" });
    const isolatedContext = {
      newPage: vi.fn().mockResolvedValue(extraPage),
      storageState: vi.fn().mockResolvedValue(SAVED_SESSION_STATE),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = { newContext: vi.fn().mockResolvedValue(isolatedContext) };
    const context = makeFakeContext(page, { browser: vi.fn().mockReturnValue(browser) });
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const existing: TestAccount[] = [
      { email: "seed@example.com", password: "pw", role: "admin", storageStatePath: "" },
      { email: "member@example.com", password: "pw2", role: "member", storageStatePath: "" },
    ];
    const result = await runAccountManager(
      "https://example.com",
      credentials,
      makeSpec(),
      context,
      {} as LLMClient,
      "m",
      "run_1",
      existing,
    );
    expect(result.map((a) => a.email)).toEqual(["seed@example.com", "member@example.com"]);
    expect(result.every((a) => a.storageStatePath)).toBe(true);
    expect(context.clearCookies).not.toHaveBeenCalled();
    expect(context.storageState).toHaveBeenCalledTimes(1);
    expect(browser.newContext).toHaveBeenCalledTimes(1);
  });

  it("spec.loginPath があれば BASE_URL より先にそこにログインする", async () => {
    const page = makeLoggedInPage();
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    await runAccountManager(
      "https://example.com",
      credentials,
      makeSpec({ loginPath: "/signin" }),
      context,
      {} as LLMClient,
      "m",
      "run_1",
    );
    expect(page.goto).toHaveBeenNthCalledWith(1, "https://example.com/signin", expect.any(Object));
  });

  it("トップにフォームが無くても loginPath でログインできる", async () => {
    const page = makeSessionPage({
      formVisibleOn: (url) => url.includes("/signin"),
      afterSubmit: "leave-login",
    });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager(
      "https://example.com",
      credentials,
      makeSpec({ loginPath: "/signin" }),
      context,
      {} as LLMClient,
      "m",
      "run_1",
    );
    expect(page.goto).toHaveBeenCalledWith("https://example.com/signin", expect.any(Object));
    expect(result[0].storageStatePath).not.toBe("");
  });

  it("loginPath にフォームが無ければ BASE_URL を試す", async () => {
    const page = makeSessionPage({
      formVisibleOn: (url) => url === "https://example.com" || url === "https://example.com/",
      afterSubmit: "leave-login",
    });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager(
      "https://example.com",
      credentials,
      makeSpec({ loginPath: "/missing" }),
      context,
      {} as LLMClient,
      "m",
      "run_1",
    );
    expect(page.goto).toHaveBeenCalledWith("https://example.com/missing", expect.any(Object));
    expect(page.goto).toHaveBeenCalledWith("https://example.com", expect.any(Object));
    expect(result[0].storageStatePath).not.toBe("");
  });

  it("フォームを送信できてもログインページにフォームが残っていれば成功にしない", async () => {
    const page = makeSessionPage({ afterSubmit: "stay-on-form" });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(endTurn() as never);
    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result).toEqual([{ email: "seed@example.com", password: "pw", role: "user", storageStatePath: "" }]);
    expect(createMessageWithRetry).not.toHaveBeenCalled();
    expect(context.storageState).not.toHaveBeenCalled();
  });

  it("SPA で送信後にフォームが消えたら同じ URL でも seed セッションを同じ context から保存する", async () => {
    const page = makeSessionPage({ afterSubmit: "spa-hide-form" });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");

    expect(result[0].storageStatePath).not.toBe("");
    expect(context.clearCookies).not.toHaveBeenCalled();
    expect(context.newPage).toHaveBeenCalledTimes(1);
    expect(context.storageState).toHaveBeenCalledTimes(1);
    expect(createMessageWithRetry).toHaveBeenCalledTimes(1);
  });

  it("seed の storageState はロール探索の前に保存する", async () => {
    const page = makeSessionPage({ afterSubmit: "leave-login" });
    const order: string[] = [];
    const context = makeFakeContext(page, {
      storageState: vi.fn(async () => {
        order.push("storage");
        return SAVED_SESSION_STATE;
      }),
    });
    vi.mocked(createMessageWithRetry).mockImplementation(async () => {
      order.push("llm");
      return toolUseResponse("done", {}) as never;
    });

    await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(order[0]).toBe("storage");
    expect(order).toContain("llm");
  });

  it("送信直後はフォームが残っていても、その後消えれば成功する", async () => {
    let submitted = false;
    let postSubmitLooks = 0;
    let currentUrl = "";
    const isFormVisible = async () => {
      if (!submitted) return currentUrl.length > 0;
      postSubmitLooks += 1;
      return postSubmitLooks < 2;
    };
    const emailLocator = makeFakeLocator({ isVisible: vi.fn(isFormVisible) });
    const passLocator = makeFakeLocator({ isVisible: vi.fn(isFormVisible) });
    const submitLocator = makeFakeLocator({
      isVisible: vi.fn(isFormVisible),
      click: vi.fn(async () => { submitted = true; }),
    });
    const page = makeFakePage({
      goto: vi.fn(async (url: string) => { currentUrl = url; }),
      url: vi.fn(() => currentUrl),
      locator: vi.fn((sel: string) => {
        if (sel.includes("password")) return passLocator;
        if (sel.includes("submit") || sel.includes("Login") || sel.includes("Sign in") || sel.includes("ログイン") || sel.includes("サインイン")) {
          return submitLocator;
        }
        return emailLocator;
      }),
    });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(result[0].storageStatePath).not.toBe("");
    expect(createMessageWithRetry).toHaveBeenCalled();
  });

  it("seed ログイン成功後は cookie を消して取り直さず、storageState が空ならパスを残さない", async () => {
    const page = makeSessionPage({ afterSubmit: "leave-login" });
    const context = makeFakeContext(page, {
      storageState: vi.fn().mockResolvedValue({ cookies: [], origins: [] }),
    });
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(context.clearCookies).not.toHaveBeenCalled();
    expect(result[0].storageStatePath).toBe("");
    expect(result[0].email).toBe("seed@example.com");
  });

  it("追加アカウントは seed context をログアウトせず isolated context でセッションを取る", async () => {
    const seedPage = makeSessionPage({ afterSubmit: "spa-hide-form" });
    const extraPage = makeSessionPage({ afterSubmit: "leave-login" });
    const isolatedContext = {
      newPage: vi.fn().mockResolvedValue(extraPage),
      storageState: vi.fn().mockResolvedValue(SAVED_SESSION_STATE),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = { newContext: vi.fn().mockResolvedValue(isolatedContext) };
    const context = makeFakeContext(seedPage, {
      browser: vi.fn().mockReturnValue(browser),
    });
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("save_account", { email: "test-admin@example.com", password: "pw123", role: "admin" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");

    expect(context.clearCookies).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledTimes(1);
    expect(isolatedContext.storageState).toHaveBeenCalled();
    expect(isolatedContext.close).toHaveBeenCalled();
    expect(context.storageState).toHaveBeenCalledTimes(1);
    expect(result.map((a) => a.email)).toEqual(["seed@example.com", "test-admin@example.com"]);
    expect(result.every((a) => a.storageStatePath)).toBe(true);
  });

  it("isolated context が無い追加アカウントは資格情報だけ残す", async () => {
    const page = makeSessionPage({ afterSubmit: "leave-login" });
    const context = makeFakeContext(page);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("save_account", { email: "test-admin@example.com", password: "pw123", role: "admin" }) as never)
      .mockResolvedValueOnce(toolUseResponse("done", {}) as never);

    const result = await runAccountManager("https://example.com", credentials, makeSpec(), context, {} as LLMClient, "m", "run_1");
    expect(context.clearCookies).not.toHaveBeenCalled();
    expect(result[0].storageStatePath).not.toBe("");
    expect(result[1]).toMatchObject({ email: "test-admin@example.com", role: "admin", storageStatePath: "" });
  });
});

describe("loginCandidateUrls / resolveLoginUrl", () => {
  it("loginPath を BASE_URL より先に置く", () => {
    expect(loginCandidateUrls("https://example.com", "/login")).toEqual([
      "https://example.com/login",
      "https://example.com",
    ]);
  });

  it("同じ URL は重複しない", () => {
    expect(loginCandidateUrls("https://example.com/", "/")).toEqual(["https://example.com/"]);
    expect(loginCandidateUrls("https://example.com")).toEqual(["https://example.com"]);
  });

  it("絶対 URL の loginPath をそのまま使う", () => {
    expect(resolveLoginUrl("https://example.com", "https://example.com/auth/login")).toBe("https://example.com/auth/login");
  });
});

describe("planBrowserAuth / authPrompt", () => {
  const sessionAccount: TestAccount = { email: "a@x.com", password: "secret", role: "admin", storageStatePath: "/states/admin.json" };
  const credsOnly: TestAccount = { email: "b@x.com", password: "secret2", role: "member", storageStatePath: "" };

  it("セッションがあるロールは注入する", () => {
    const plan = planBrowserAuth({
      testAccounts: [sessionAccount],
      accountRole: "admin",
      preferAccountSession: false,
    });
    expect(plan.handoff.kind).toBe("session");
    expect(plan.storageStatePath).toBe("/states/admin.json");
    expect(authPrompt(plan.handoff)).toContain("already logged in as a@x.com");
    expect(authPrompt(plan.handoff)).not.toContain("secret");
  });

  it("再訪セッションはアカウントより優先する（マルチアクターでなければ）", () => {
    const plan = planBrowserAuth({
      testAccounts: [sessionAccount],
      accountRole: "admin",
      returningSessionPath: "/cache/sessions/agent.json",
      preferAccountSession: false,
    });
    expect(plan.handoff).toEqual({ kind: "session" });
    expect(plan.storageStatePath).toBe("/cache/sessions/agent.json");
    expect(authPrompt(plan.handoff)).toBe("");
  });

  it("マルチアクターはアカウントセッションを再訪より優先する", () => {
    const plan = planBrowserAuth({
      testAccounts: [sessionAccount],
      accountRole: "admin",
      returningSessionPath: "/cache/sessions/agent.json",
      preferAccountSession: true,
    });
    expect(plan.storageStatePath).toBe("/states/admin.json");
  });

  it("セッションが無いときは accounts.json の値と loginPath を渡す", () => {
    const plan = planBrowserAuth({
      testAccounts: [credsOnly],
      accountRole: "member",
      loginPath: "/signin",
      preferAccountSession: false,
    });
    expect(plan.handoff).toEqual({
      kind: "credentials",
      email: "b@x.com",
      password: "secret2",
      role: "member",
      loginPath: "/signin",
    });
    expect(plan.startPath).toBe("/signin");
    const prompt = authPrompt(plan.handoff);
    expect(prompt).toContain("b@x.com");
    expect(prompt).toContain("secret2");
    expect(prompt).toContain("/signin");
    expect(prompt).toMatch(/do NOT invent/i);
    expect(describeAuthPlan("Ada", plan)).toContain("handing off credentials");
  });

  it("ペルソナ role はテストアカウント role と大文字小文字・部分一致で突き合わせる", () => {
    const plan = planBrowserAuth({
      testAccounts: [sessionAccount],
      accountRole: "Administrator",
      preferAccountSession: true,
    });
    expect(plan.handoff.kind).toBe("session");
    expect(plan.storageStatePath).toBe("/states/admin.json");
  });

  it("ロール不一致でも既知の資格情報があれば推測させない", () => {
    const plan = planBrowserAuth({
      testAccounts: [credsOnly],
      accountRole: "explorer",
      loginPath: "/login",
      preferAccountSession: false,
    });
    expect(plan.handoff.kind).toBe("credentials");
    if (plan.handoff.kind !== "credentials") return;
    expect(plan.handoff.email).toBe("b@x.com");
  });

  it("資格情報が無いときはゲストにして推測を禁ずる", () => {
    const plan = planBrowserAuth({
      testAccounts: [],
      accountRole: "user",
      preferAccountSession: false,
    });
    expect(plan.handoff).toEqual({ kind: "guest" });
    const prompt = authPrompt(plan.handoff);
    expect(prompt).toMatch(/Do NOT invent, guess/i);
    expect(prompt).not.toContain("Password:");
    expect(describeAuthPlan("Bea", plan)).toContain("guest");
  });

  it("ペルソナ role が説明文でトークン一致しなくても保存済みセッションを注入する", () => {
    const userSession: TestAccount = {
      email: "user@x.com",
      password: "secret",
      role: "user",
      storageStatePath: "/states/user.json",
    };
    const plan = planBrowserAuth({
      testAccounts: [userSession],
      accountRole: "趣味で学ぶシニア学習者",
      preferAccountSession: false,
    });
    expect(plan.handoff.kind).toBe("session");
    expect(plan.storageStatePath).toBe("/states/user.json");
    expect(plan.roleMismatch).toEqual({
      requested: "趣味で学ぶシニア学習者",
      used: "user",
    });
    expect(describeAuthPlan("Ada", plan)).toContain("role mismatch");
    expect(authPrompt(plan.handoff)).not.toContain("secret");
  });

  it("セッションが一つも無いときだけ資格情報を渡す", () => {
    const plan = planBrowserAuth({
      testAccounts: [credsOnly],
      accountRole: "趣味で学ぶシニア学習者",
      loginPath: "/login",
      preferAccountSession: false,
    });
    expect(plan.handoff.kind).toBe("credentials");
  });
});

describe("loginLooksEstablished", () => {
  it("送信後もログイン URL にパスワード欄があれば失敗", () => {
    expect(loginLooksEstablished({
      currentUrl: "https://example.com/login",
      submittedFromUrl: "https://example.com/login",
      passwordFieldVisible: true,
    })).toBe(false);
  });

  it("ログインページを抜けていれば成功", () => {
    expect(loginLooksEstablished({
      currentUrl: "https://example.com/dashboard",
      submittedFromUrl: "https://example.com/login",
      passwordFieldVisible: false,
    })).toBe(true);
  });

  it("同じ URL でもパスワード欄が消えていれば成功（SPA）", () => {
    expect(loginLooksEstablished({
      currentUrl: "https://example.com/login",
      submittedFromUrl: "https://example.com/login",
      passwordFieldVisible: false,
    })).toBe(true);
  });

  it("トップのフォームが残っていれば失敗", () => {
    expect(loginLooksEstablished({
      currentUrl: "https://example.com/",
      submittedFromUrl: "https://example.com",
      passwordFieldVisible: true,
    })).toBe(false);
  });

  it("トップでフォームが消えていれば成功", () => {
    expect(loginLooksEstablished({
      currentUrl: "https://example.com/",
      submittedFromUrl: "https://example.com",
      passwordFieldVisible: false,
    })).toBe(true);
  });

  it("遷移先がまだ login パスでフォームも残っていれば失敗", () => {
    expect(loginLooksEstablished({
      currentUrl: "https://example.com/login/success",
      submittedFromUrl: "https://example.com/login",
      passwordFieldVisible: true,
    })).toBe(false);
  });
});

describe("storageStateHasSession", () => {
  it("cookie があれば true", () => {
    expect(storageStateHasSession({ cookies: [{ name: "sid" }], origins: [] })).toBe(true);
  });

  it("localStorage があれば true", () => {
    expect(storageStateHasSession({
      cookies: [],
      origins: [{ localStorage: [{ name: "token", value: "t" }] }],
    })).toBe(true);
  });

  it("空なら false", () => {
    expect(storageStateHasSession({ cookies: [], origins: [] })).toBe(false);
    expect(storageStateHasSession({})).toBe(false);
  });
});

describe("describeLoginFailure", () => {
  it("フォームが埋まっていなければその旨を返す", () => {
    expect(describeLoginFailure({
      ok: false,
      triedUrls: ["https://example.com/login"],
      lastUrl: "https://example.com/login",
      formFilled: false,
    })).toMatch(/login form not found/);
  });

  it("ログイン URL に残っている・パスワード欄が残っている理由を出す", () => {
    const text = describeLoginFailure({
      ok: false,
      triedUrls: ["https://example.com/login"],
      lastUrl: "https://example.com/login",
      formFilled: true,
      passwordFieldVisible: true,
    });
    expect(text).toContain("still on login URL");
    expect(text).toContain("password field still visible");
  });
});

describe("pickAdminAccount", () => {
  it("admin / 管理者を優先する", () => {
    const accounts: TestAccount[] = [
      { email: "u@x.com", password: "p", role: "user", storageStatePath: "" },
      { email: "a@x.com", password: "p", role: "admin", storageStatePath: "" },
    ];
    expect(pickAdminAccount(accounts)?.email).toBe("a@x.com");
  });

  it("admin が無ければ undefined", () => {
    expect(pickAdminAccount([
      { email: "u@x.com", password: "p", role: "user", storageStatePath: "" },
    ])).toBeUndefined();
  });
});
