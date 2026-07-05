import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import type { BrowserContext } from "playwright";

vi.mock("fs");
vi.mock("path", async (importOriginal) => {
  const actual = await importOriginal<typeof path>();
  return { ...actual, join: (...args: string[]) => args.join("/") };
});

import { agentSessionPath, hasAgentSession, saveAgentSession, sessionContinuityPrompt } from "../session-store";

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReset().mockReturnValue(false);
  vi.mocked(fs.mkdirSync).mockReset().mockReturnValue(undefined);
});

describe("agentSessionPath / hasAgentSession", () => {
  it("agentId ごとの cache/sessions パスを返す", () => {
    expect(agentSessionPath("agent_1")).toContain("cache/sessions/agent_1.json");
  });

  it("セッションファイルの有無を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(hasAgentSession("agent_1")).toBe(true);
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(hasAgentSession("agent_1")).toBe(false);
  });

  it("fs が例外を投げても false を返す", () => {
    vi.mocked(fs.existsSync).mockImplementation(() => { throw new Error("boom"); });
    expect(hasAgentSession("agent_1")).toBe(false);
  });
});

describe("saveAgentSession", () => {
  it("ディレクトリを作成して storageState を保存する", async () => {
    const storageState = vi.fn().mockResolvedValue({});
    const context = { storageState } as unknown as BrowserContext;
    await saveAgentSession(context, "agent_1");
    expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining("cache/sessions"), { recursive: true });
    expect(storageState).toHaveBeenCalledWith({ path: expect.stringContaining("agent_1.json") });
  });

  it("storageState が失敗しても例外を投げない", async () => {
    const context = { storageState: vi.fn().mockRejectedValue(new Error("closed")) } as unknown as BrowserContext;
    await expect(saveAgentSession(context, "agent_1")).resolves.toBeUndefined();
  });
});

describe("sessionContinuityPrompt", () => {
  it("復元されていなければ空文字", () => {
    expect(sessionContinuityPrompt(false)).toBe("");
  });

  it("復元されていれば再訪ユーザーとしての指示を返す", () => {
    const text = sessionContinuityPrompt(true);
    expect(text).toContain("[Session Continuity]");
    expect(text).toContain("returning user");
  });
});
