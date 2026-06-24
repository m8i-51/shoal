import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("fs");
vi.mock("openai", () => ({ default: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@anthropic-ai/bedrock-sdk", () => ({ default: vi.fn() }));

import * as fs from "fs";
import { createLLMClient } from "../llm-client";
import type { LLMClient } from "../llm-client";

vi.stubGlobal("fetch", vi.fn());

const ENV_KEYS = ["LLM_PROVIDER", "LLM_MODEL"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.LLM_PROVIDER = "codex";
  vi.mocked(fetch).mockReset();
  vi.mocked(fs.existsSync).mockReset();
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(fs.writeFileSync).mockReset().mockReturnValue(undefined);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makeClient(): LLMClient {
  return createLLMClient().client;
}

function makeAuthFile(overrides: Record<string, unknown> = {}) {
  return {
    tokens: {
      access_token: "access-tok",
      id_token: "id-tok",
      refresh_token: "refresh-tok",
      account_id: "acct-123",
    },
    last_refresh: new Date().toISOString(),
    ...overrides,
  };
}

function sseBody(events: Record<string, unknown>[]): string {
  return events.map((e) => `data: ${JSON.stringify(e)}`).join("\n") + "\ndata: [DONE]\n";
}

function makeFetchResponse(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body } as Response;
}

describe("CodexClient.createMessage", () => {
  it("auth.json が存在しない場合は分かりやすいエラーを throw する", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const client = makeClient();
    await expect(
      client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] })
    ).rejects.toThrow(/not found.*npm run auth:codex/);
  });

  it("トークンが新しい場合（55分以内）はリフレッシュせず既存トークンを使う", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile()) as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(sseBody([
      { type: "response.completed", response: { id: "r1", model: "gpt-5.1-codex-mini", output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }] } },
    ])));

    const client = makeClient();
    const result = await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });

    expect(result.content).toEqual([{ type: "text", text: "hi" }]);
    expect(fs.writeFileSync).not.toHaveBeenCalled(); // リフレッシュなし = auth.json 書き換えなし
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer access-tok");
    expect((opts as RequestInit & { headers: Record<string, string> }).headers["chatgpt-account-id"]).toBe("acct-123");
  });

  it("トークンが古い場合（55分超）はリフレッシュしてから使う", async () => {
    const oldRefresh = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile({ last_refresh: oldRefresh })) as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "new-access", id_token: "new-id" }) } as Response)
      .mockResolvedValueOnce(makeFetchResponse(sseBody([
        { type: "response.completed", response: { id: "r1", model: "m", output: [] } },
      ])));

    const client = makeClient();
    await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });

    expect(fs.writeFileSync).toHaveBeenCalled();
    const [, savedContent] = vi.mocked(fs.writeFileSync).mock.calls[0];
    const saved = JSON.parse(savedContent as string);
    expect(saved.tokens.access_token).toBe("new-access");

    const [, responsesOpts] = vi.mocked(fetch).mock.calls[1];
    expect((responsesOpts as RequestInit & { headers: Record<string, string> }).headers.Authorization).toBe("Bearer new-access");
  });

  it("トークンリフレッシュが失敗した場合はエラーを throw する", async () => {
    const oldRefresh = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile({ last_refresh: oldRefresh })) as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 401, text: async () => "invalid_grant" } as Response);

    const client = makeClient();
    await expect(
      client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] })
    ).rejects.toThrow(/Codex token refresh failed/);
  });

  it("Codex API がエラーを返した場合は throw する", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile()) as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500, text: async () => "server error" } as Response);

    const client = makeClient();
    await expect(
      client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] })
    ).rejects.toThrow(/Codex API error: 500/);
  });

  it("function_call イベントは tool_use として変換され stop_reason が tool_use になる", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile()) as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(sseBody([
      { type: "response.completed", response: { id: "r1", model: "m", output: [{ type: "function_call", call_id: "c1", name: "click", arguments: '{"x":1}' }] } },
    ])));

    const client = makeClient();
    const result = await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toEqual([{ type: "tool_use", id: "c1", name: "click", input: { x: 1 } }]);
  });

  it("response.completed の output が空でも output_item.done から復元する", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile()) as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(sseBody([
      { type: "response.output_item.done", item: { type: "message", content: [{ type: "output_text", text: "recovered" }] } },
      { type: "response.completed", response: { id: "r1", model: "m", output: [] } },
    ])));

    const client = makeClient();
    const result = await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });
    expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
  });

  it("reasoning 系の output_item は無視される", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile()) as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(sseBody([
      { type: "response.output_item.done", item: { type: "reasoning", summary: "thinking..." } },
      { type: "response.completed", response: { id: "r1", model: "m", output: [] } },
    ])));

    const client = makeClient();
    const result = await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });
    expect(result.content).toEqual([]);
  });

  it("完了イベントが一つも無い SSE ストリームは throw する", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile()) as unknown as ReturnType<typeof fs.readFileSync>);
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(sseBody([
      { type: "response.in_progress" },
    ])));

    const client = makeClient();
    await expect(
      client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] })
    ).rejects.toThrow(/No completed response found/);
  });

  it("不正な JSON 行は無視してパースを継続する", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile()) as unknown as ReturnType<typeof fs.readFileSync>);
    const body = "data: not valid json\n" + sseBody([
      { type: "response.completed", response: { id: "r1", model: "m", output: [] } },
    ]);
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(body));

    const client = makeClient();
    await expect(
      client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] })
    ).resolves.toBeDefined();
  });

  it("account_id が無い場合は id_token の JWT ペイロードから抽出する", async () => {
    const idToken = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { account_id: "from-jwt" } })).toString("base64url")}.sig`;
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(makeAuthFile({ tokens: { access_token: "tok", id_token: idToken, refresh_token: "r" } })) as unknown as ReturnType<typeof fs.readFileSync>
    );
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(sseBody([
      { type: "response.completed", response: { id: "r1", model: "m", output: [] } },
    ])));

    const client = makeClient();
    await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts as RequestInit & { headers: Record<string, string> }).headers["chatgpt-account-id"]).toBe("from-jwt");
  });

  describe("toCodexInput（メッセージ変換）", () => {
    async function runWithMessages(messages: unknown[]) {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(makeAuthFile()) as unknown as ReturnType<typeof fs.readFileSync>);
      vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(sseBody([
        { type: "response.completed", response: { id: "r1", model: "m", output: [] } },
      ])));
      const client = makeClient();
      await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: messages as never });
      const [, opts] = vi.mocked(fetch).mock.calls[0];
      return JSON.parse((opts as RequestInit).body as string).input;
    }

    it("user role + string content", async () => {
      const input = await runWithMessages([{ role: "user", content: "hello" }]);
      expect(input).toEqual([{ role: "user", content: "hello" }]);
    });

    it("user role + tool_result（string content）は function_call_output になる", async () => {
      const input = await runWithMessages([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "done" }] },
      ]);
      expect(input).toEqual([{ type: "function_call_output", call_id: "c1", output: "done" }]);
    });

    it("user role + tool_result（array of text blocks）は結合される", async () => {
      const input = await runWithMessages([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] },
      ]);
      expect(input).toEqual([{ type: "function_call_output", call_id: "c1", output: "a\nb" }]);
    });

    it("user role + text blocks（tool_result 以外）はまとめて user メッセージになる", async () => {
      const input = await runWithMessages([
        { role: "user", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] },
      ]);
      expect(input).toEqual([{ role: "user", content: "line1\nline2" }]);
    });

    it("assistant role + string content", async () => {
      const input = await runWithMessages([{ role: "assistant", content: "ack" }]);
      expect(input).toEqual([{ role: "assistant", content: "ack" }]);
    });

    it("assistant role + text blocks + tool_use は両方出力される", async () => {
      const input = await runWithMessages([
        { role: "assistant", content: [{ type: "text", text: "thinking" }, { type: "tool_use", id: "c1", name: "click", input: { x: 1 } }] },
      ]);
      expect(input).toEqual([
        { role: "assistant", content: "thinking" },
        { type: "function_call", call_id: "c1", name: "click", arguments: '{"x":1}' },
      ]);
    });

    it("ロンサロゲート（不正なサロゲート文字）は U+FFFD に置換される", async () => {
      const lone = "\uD800"; // 単独の high surrogate
      const input = await runWithMessages([
        { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: `broken${lone}text` }] },
      ]);
      expect((input[0] as { output: string }).output).toBe("broken�text");
    });
  });

  it("id_token が不正で JWT パースに失敗した場合は account_id が空文字になる", async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify(makeAuthFile({ tokens: { access_token: "tok", id_token: "not-a-jwt", refresh_token: "r" } })) as unknown as ReturnType<typeof fs.readFileSync>
    );
    vi.mocked(fetch).mockResolvedValueOnce(makeFetchResponse(sseBody([
      { type: "response.completed", response: { id: "r1", model: "m", output: [] } },
    ])));

    const client = makeClient();
    await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });
    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts as RequestInit & { headers: Record<string, string> }).headers["chatgpt-account-id"]).toBe("");
  });
});
