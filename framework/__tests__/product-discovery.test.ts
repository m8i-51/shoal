import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");
vi.mock("../agent-loop", () => ({ createMessageWithRetry: vi.fn() }));
vi.stubGlobal("fetch", vi.fn());

import * as fs from "fs";
import { createMessageWithRetry } from "../agent-loop";
import { discoverProduct, loadCachedSpec, type ProductSpec } from "../product-discovery";
import type { LLMClient } from "../llm-client";
import type { Page } from "playwright";

function makeFakePage(): Page {
  return {
    goto: vi.fn().mockResolvedValue(undefined),
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue("page text"),
    ariaSnapshot: vi.fn().mockResolvedValue("aria tree"),
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
    expect(loadCachedSpec("https://example.com")).toEqual(spec);
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
    expect(fs.writeFileSync).toHaveBeenCalled();
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
