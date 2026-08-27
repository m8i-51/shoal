import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../agent-loop", () => ({ createMessageWithRetry: vi.fn() }));
vi.stubGlobal("fetch", vi.fn());

import * as fs from "fs";
import { createMessageWithRetry } from "../agent-loop";
import { discoverProduct, loadCachedSpec, isLoginPath, inferLoginPathFromText, normalizeLoginPath, resolveLoginPath, detectLoginPath, type ProductSpec } from "../product-discovery";
import type { LLMClient } from "../llm-client";
import type { Page } from "playwright";

function makeFakePage(overrides: Record<string, unknown> = {}): Page {
  const locator = {
    first: () => locator,
    isVisible: vi.fn().mockResolvedValue(false),
  };
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue("page text"),
    ariaSnapshot: vi.fn().mockResolvedValue("aria tree"),
    locator: vi.fn(() => locator),
    ...overrides,
  } as unknown as Page;
}

function endTurn() {
  return { content: [], stop_reason: "end_turn", usage: {} };
}

function toolUseResponse(name: string, input: unknown, id = "t1") {
  return { content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use", usage: {} };
}

function makeOutputSpecInput(overrides: Partial<ProductSpec> = {}): ProductSpec {
  return {
    appName: "MyApp",
    appDescription: "desc",
    targetUsers: "users",
    features: "f1",
    designContext: "dc",
    uiFeatures: "",
    appGoals: ["goal1"],
    confidence: "high",
    sources: ["/"],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue("{}" as unknown as ReturnType<typeof fs.readFileSync>);
  vi.mocked(fs.writeFileSync).mockReset().mockReturnValue(undefined);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(createMessageWithRetry).mockReset();
  vi.mocked(fetch).mockReset();
  delete process.env.GITHUB_REPO;
});

describe("loadCachedSpec", () => {
  it("キャッシュファイルが存在しない場合は null を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadCachedSpec("https://example.com")).toBeNull();
  });

  it("キャッシュファイルが存在する場合はパースして返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const spec = makeOutputSpecInput();
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(spec) as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadCachedSpec("https://example.com")).toEqual({ ...spec, thresholdCandidates: [] });
  });

  it("キャッシュの不正 thresholdCandidates は空配列に正規化する", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const spec = makeOutputSpecInput({
      thresholdCandidates: [{ id: "x", kind: "bad" }] as never,
    });
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(spec) as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadCachedSpec("https://example.com")?.thresholdCandidates).toEqual([]);
  });

  it("壊れた JSON の場合は null を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadCachedSpec("https://example.com")).toBeNull();
  });
});

describe("discoverProduct", () => {
  it("output_spec が呼ばれた場合はその内容を ProductSpec として保存する", async () => {
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput({ appName: "Discovered" })) as never);
    const result = await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    expect(result.appName).toBe("Discovered");
    expect(result.discoveredAt).toBeDefined();
    expect(result.thresholdCandidates).toEqual([]);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it("thresholdCandidates を normalize して保存する", async () => {
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput({
        thresholdCandidates: [
          { id: "ok", kind: "business", area: "/billing", signal: "seat cap", howToProbe: "add seats", priority: 1 },
          { id: "bad", kind: "nope", area: "/x", signal: "s", howToProbe: "h", priority: 1 } as never,
        ],
      })) as never);
    const result = await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    expect(result.thresholdCandidates).toHaveLength(1);
    expect(result.thresholdCandidates![0].id).toBe("ok");
  });

  it("thresholdCandidates 欠落・不正は空配列として扱う", async () => {
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput({
        thresholdCandidates: "not-an-array" as unknown as [],
      })) as never);
    const result = await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    expect(result.thresholdCandidates).toEqual([]);
  });

  it("output_spec が一度も呼ばれない場合はフォールバック spec を使う（8イテレーション後）", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(
      toolUseResponse("navigate_and_read", { path: "/" }) as never
    );
    const result = await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    expect(result.confidence).toBe("low");
    expect(result.appDescription).toBe("(auto-discovery failed)");
    expect(result.appName).toBe("example.com");
    expect(createMessageWithRetry).toHaveBeenCalledTimes(8);
  });

  it("end_turn で tool_use が無い場合は即座にループを終了する", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(endTurn() as never);
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    expect(createMessageWithRetry).toHaveBeenCalledTimes(1);
  });

  it("navigate_and_read は page.goto/evaluate/ariaSnapshot を呼ぶ", async () => {
    const page = makeFakePage();
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("navigate_and_read", { path: "/tasks" }) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", page, {} as LLMClient, "m");
    expect(page.goto).toHaveBeenCalledWith("https://example.com/tasks", expect.any(Object));
  });

  it("navigate_and_read で path が無い場合はエラーを返しページ操作しない", async () => {
    const page = makeFakePage();
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("navigate_and_read", {}) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", page, {} as LLMClient, "m");
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("navigate_and_read が例外を投げても fetch failed として処理を継続する", async () => {
    const page = makeFakePage();
    vi.mocked(page.goto).mockRejectedValue(new Error("timeout"));
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("navigate_and_read", { path: "/" }) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await expect(discoverProduct("https://example.com", page, {} as LLMClient, "m")).resolves.toBeDefined();
  });

  it("fetch_url は外部URLを取得しHTMLタグを除去する", async () => {
    vi.mocked(fetch).mockResolvedValue({ text: async () => "<p>Hello <b>World</b></p>" } as Response);
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("fetch_url", { url: "https://example.com/readme" }) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    const [, secondParams] = vi.mocked(createMessageWithRetry).mock.calls[1];
    const toolResultContent = (secondParams.messages[2].content as { content: string }[])[0].content;
    expect(toolResultContent).toContain("Hello World");
  });

  it("fetch_url で url が無い場合はエラーを返す", async () => {
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("fetch_url", {}) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await expect(discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m")).resolves.toBeDefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetch_url が例外を投げても fetch failed として処理を継続する", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network error"));
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("fetch_url", { url: "https://x.com" }) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await expect(discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m")).resolves.toBeDefined();
  });

  it("未知のツール名はエラー結果を返すがループは継続する", async () => {
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("unknown_tool", {}) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await expect(discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m")).resolves.toBeDefined();
    expect(createMessageWithRetry).toHaveBeenCalledTimes(2);
  });

  it("projectPath があり README が見つかる場合はそれをプロンプトに含める", async () => {
    vi.mocked(fs.existsSync).mockImplementation((p: unknown) => String(p).endsWith("README.md"));
    vi.mocked(fs.readFileSync).mockReturnValue("# My Project\nThis is a test app." as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(createMessageWithRetry).mockResolvedValue(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m", "/some/project");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).toContain("[Available Documentation]");
    expect(content).toContain("This is a test app.");
  });

  it("projectPath もローカルドキュメントも無い場合は GITHUB_REPO から README を取得する", async () => {
    process.env.GITHUB_REPO = "myorg/myrepo";
    vi.mocked(fetch).mockResolvedValue({ ok: true, text: async () => "# GitHub README" } as Response);
    vi.mocked(createMessageWithRetry).mockResolvedValue(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).toContain("GitHub README");
  });

  it("projectPath を指定したがローカルドキュメントが見つからない場合は GitHub にフォールバックする", async () => {
    process.env.GITHUB_REPO = "myorg/myrepo";
    vi.mocked(fs.existsSync).mockReturnValue(false); // projectPath 配下に候補ファイルなし
    vi.mocked(fetch).mockResolvedValue({ ok: true, text: async () => "# Fallback README" } as Response);
    vi.mocked(createMessageWithRetry).mockResolvedValue(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m", "/empty/project");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    expect(params.messages[0].content as string).toContain("Fallback README");
  });

  it("GITHUB_REPO がデフォルト値 owner/repo のままなら GitHub README は取得しない", async () => {
    process.env.GITHUB_REPO = "owner/repo";
    vi.mocked(createMessageWithRetry).mockResolvedValue(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ドキュメントが何も見つからない場合は基本プロンプトのみになる", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const content = params.messages[0].content as string;
    expect(content).not.toContain("[Available Documentation]");
  });

  it("system / output_spec は appGoals を成果条件に限定し features と役割分離する", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    const [, params] = vi.mocked(createMessageWithRetry).mock.calls[0];
    const system = params.system as string;
    expect(system).toContain("Field roles");
    expect(system).toContain("appGoals: WHETHER users/business succeed");
    expect(system).toContain("never widget names");
    expect(system).toContain("UI observation only");
    expect(system).toContain("Hall-editable drafts");

    const outputSpec = (params.tools as { name: string; input_schema: { properties: Record<string, { description?: string }> } }[])
      .find((t) => t.name === "output_spec");
    expect(outputSpec).toBeDefined();
    const goalsDesc = outputSpec!.input_schema.properties.appGoals.description ?? "";
    const featuresDesc = outputSpec!.input_schema.properties.features.description ?? "";
    const uiDesc = outputSpec!.input_schema.properties.uiFeatures.description ?? "";
    expect(goalsDesc).toContain("SUCCESS CONDITIONS");
    expect(goalsDesc).toMatch(/Bad \(do NOT write\)/i);
    expect(goalsDesc).toContain("search");
    expect(featuresDesc).toContain("Do NOT put success criteria");
    expect(uiDesc).toMatch(/NEVER in appGoals/i);
  });

  it("spec.uiFeatures がある場合は UI_FEATURES.md も保存する", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(
      toolUseResponse("output_spec", makeOutputSpecInput({ uiFeatures: "drag and drop" })) as never
    );
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    const mdCall = vi.mocked(fs.writeFileSync).mock.calls.find(([p]) => String(p).includes("_UI_FEATURES.md"));
    expect(mdCall).toBeDefined();
    expect(mdCall![1] as string).toContain("drag and drop");
  });

  it("spec.uiFeatures が空の場合は UI_FEATURES.md を保存しない", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValue(
      toolUseResponse("output_spec", makeOutputSpecInput({ uiFeatures: "" })) as never
    );
    await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    const mdCall = vi.mocked(fs.writeFileSync).mock.calls.find(([p]) => String(p).includes("_UI_FEATURES.md"));
    expect(mdCall).toBeUndefined();
  });
});

describe("login path helpers", () => {
  it("isLoginPath はログインらしいパスだけを認める", () => {
    expect(isLoginPath("/login")).toBe(true);
    expect(isLoginPath("/signin")).toBe(true);
    expect(isLoginPath("/sign-in")).toBe(true);
    expect(isLoginPath("/auth/login")).toBe(true);
    expect(isLoginPath("/users/sign_in")).toBe(true);
    expect(isLoginPath("/")).toBe(false);
    expect(isLoginPath("/logout")).toBe(false);
    expect(isLoginPath("/login-history")).toBe(false);
    expect(isLoginPath("/dashboard")).toBe(false);
  });

  it("normalizeLoginPath は同一オリジンの pathname を返す", () => {
    expect(normalizeLoginPath("/login", "https://example.com")).toBe("/login");
    expect(normalizeLoginPath("https://example.com/signin", "https://example.com")).toBe("/signin");
    expect(normalizeLoginPath("https://other.com/login", "https://example.com")).toBeUndefined();
    expect(normalizeLoginPath("", "https://example.com")).toBeUndefined();
  });

  it("inferLoginPathFromText は sources/features から /login を拾う", () => {
    expect(inferLoginPathFromText("/ (top page)\n/login (UI)")).toBe("/login");
    expect(inferLoginPathFromText("Screen: Dashboard · /signin form")).toBe("/signin");
    expect(inferLoginPathFromText("no auth here")).toBeUndefined();
  });

  it("resolveLoginPath は明示フィールドを優先し、無ければテキストから推論する", () => {
    expect(resolveLoginPath(makeOutputSpecInput({ loginPath: "/signin" }))).toBe("/signin");
    expect(resolveLoginPath(makeOutputSpecInput({ loginPath: "https://example.com/auth/login" }))).toBe("/auth/login");
    expect(resolveLoginPath(makeOutputSpecInput({ sources: ["/login (UI)"] }))).toBe("/login");
    expect(resolveLoginPath(makeOutputSpecInput())).toBeUndefined();
  });
});

describe("detectLoginPath / discoverProduct loginPath", () => {
  it("password フィールドがあるページを loginPath として記録する", async () => {
    const locator = {
      first: () => locator,
      isVisible: vi.fn().mockResolvedValue(true),
    };
    const page = makeFakePage({ locator: vi.fn(() => locator) });
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("navigate_and_read", { path: "/signin" }) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    const result = await discoverProduct("https://example.com", page, {} as LLMClient, "m");
    expect(result.loginPath).toBe("/signin");
  });

  it("フォーム未観測なら output_spec の loginPath を使う", async () => {
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput({ loginPath: "/auth/login" })) as never);
    const result = await discoverProduct("https://example.com", makeFakePage(), {} as LLMClient, "m");
    expect(result.loginPath).toBe("/auth/login");
  });

  it("観測したフォームは LLM の loginPath より優先する", async () => {
    const locator = {
      first: () => locator,
      isVisible: vi.fn().mockResolvedValue(true),
    };
    const page = makeFakePage({ locator: vi.fn(() => locator) });
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("navigate_and_read", { path: "/login" }) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput({ loginPath: "/wrong" })) as never);
    const result = await discoverProduct("https://example.com", page, {} as LLMClient, "m");
    expect(result.loginPath).toBe("/login");
  });

  it("ログインリンクの href を loginPath にする", async () => {
    const page = makeFakePage({
      evaluate: vi.fn()
        .mockResolvedValueOnce("Welcome")
        .mockResolvedValueOnce(["/docs", "/signin"]),
    });
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseResponse("navigate_and_read", { path: "/" }) as never)
      .mockResolvedValueOnce(toolUseResponse("output_spec", makeOutputSpecInput()) as never);
    const result = await discoverProduct("https://example.com", page, {} as LLMClient, "m");
    expect(result.loginPath).toBe("/signin");
  });

  it("detectLoginPath は password が見えるページを formPath にする", async () => {
    const locator = {
      first: () => locator,
      isVisible: vi.fn().mockResolvedValue(true),
    };
    const page = makeFakePage({ locator: vi.fn(() => locator) });
    await expect(detectLoginPath(page, "/login", "https://example.com")).resolves.toEqual({ formPath: "/login" });
  });
});
