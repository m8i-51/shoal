import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";

vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("path")>();
  return { ...actual, join: (...args: string[]) => args.join("/"), dirname: (p: string) => p.split("/").slice(0, -1).join("/") };
});

const mockCreateMessage = vi.fn();
vi.mock("../llm-client.js", () => ({
  createLLMClient: vi.fn(() => ({
    client: { createMessage: mockCreateMessage },
    defaultModel: "mock-model",
  })),
}));

import { generateDiary, getDiaryPath } from "../diary";

const DIARY_TEXT = "# 探索日誌 — run_123\n冒険が始まった。";

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.mkdirSync).mockReturnValue(undefined);
  vi.mocked(fs.writeFileSync).mockReturnValue(undefined);
  vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
  mockCreateMessage.mockClear();
  mockCreateMessage.mockResolvedValue({
    content: [{ type: "text", text: DIARY_TEXT }],
  });
});

describe("getDiaryPath", () => {
  it("run_\\d+ 形式 + ファイル存在 → パスを返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    const result = getDiaryPath("run_123");
    expect(result).not.toBeNull();
    expect(result).toContain("run_123");
  });

  it("run_\\d+ 形式だがファイルなし → null", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(getDiaryPath("run_123")).toBeNull();
  });

  it("不正な runId（英字）→ null", () => {
    expect(getDiaryPath("run_abc")).toBeNull();
  });

  it("パストラバーサル試みは null", () => {
    expect(getDiaryPath("../etc/passwd")).toBeNull();
    expect(getDiaryPath("run_123/../../../etc")).toBeNull();
  });
});

describe("generateDiary", () => {
  it("生成されたテキストを返す", async () => {
    const result = await generateDiary("run_123", []);
    expect(result).toBe(DIARY_TEXT);
  });

  it("生成テキストをファイルに書き込む", async () => {
    await generateDiary("run_123", []);
    expect(fs.writeFileSync).toHaveBeenCalled();
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    expect(content).toBe(DIARY_TEXT);
  });

  it("ファイル書き込み前にディレクトリを作成する", async () => {
    await generateDiary("run_123", []);
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.any(String), { recursive: true });
  });

  it("findings がない場合はプロンプトに「発見なし」を含める", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    await generateDiary("run_123", []);
    const [params] = mockCreateMessage.mock.calls[0];
    const userContent = (params.messages[0].content as string);
    expect(userContent).toContain("発見なし");
  });

  it("findings がある場合はタイトルをプロンプトに含める", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readdirSync).mockReturnValue(["f1.json"] as unknown as ReturnType<typeof fs.readdirSync>);
    const finding = { id: "f1", runId: "run_123", agentId: "a", agentName: "A", role: "r", title: "Login is broken", body: "", category: "bug", timestamp: new Date().toISOString() };
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(finding) as unknown as ReturnType<typeof fs.readFileSync>);

    await generateDiary("run_123", []);
    const [params] = mockCreateMessage.mock.calls[0];
    expect(params.messages[0].content).toContain("Login is broken");
  });

  it("ログが空の場合はプロンプトに「イベントログなし」を含める", async () => {
    await generateDiary("run_123", []);
    const [params] = mockCreateMessage.mock.calls[0];
    expect(params.messages[0].content).toContain("イベントログなし");
  });

  it("navigate 行は最大 25 件まで抽出する", async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `  → navigate({"path":"/page${i}"})`);
    await generateDiary("run_123", lines);
    const [params] = mockCreateMessage.mock.calls[0];
    const content: string = params.messages[0].content;
    const navCount = (content.match(/navigate/g) ?? []).length;
    expect(navCount).toBeLessThanOrEqual(25);
  });

  it("agent start/done 行はすべて抽出する", async () => {
    const lines = [
      "[explorer] Alice start",
      "[browser] Bob start",
      "[explorer] Alice done",
    ];
    await generateDiary("run_123", lines);
    const [params] = mockCreateMessage.mock.calls[0];
    const content: string = params.messages[0].content;
    expect(content).toContain("[explorer] Alice start");
    expect(content).toContain("[browser] Bob start");
    expect(content).toContain("[explorer] Alice done");
  });

  it("finding 発見ログは抽出される", async () => {
    const lines = ['  → [findings] saved: "Login page crashes" (bug)'];
    await generateDiary("run_123", lines);
    const [params] = mockCreateMessage.mock.calls[0];
    expect(params.messages[0].content).toContain("[findings] saved");
  });

  it("navigate 行が 100 文字超えると切り詰められる", async () => {
    const longPath = "/very/long/path/" + "a".repeat(200);
    const lines = [`  → navigate({"path":"${longPath}"})`];
    await generateDiary("run_123", lines);
    const [params] = mockCreateMessage.mock.calls[0];
    const content: string = params.messages[0].content;
    const lines2 = content.split("\n");
    const navLine = lines2.find((l) => l.includes("navigate"));
    expect(navLine!.length).toBeLessThanOrEqual(103); // 100 + "…"
  });
});
