import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("openai", () => ({
  default: vi.fn().mockImplementation(function () {
    return { chat: { completions: { create: mockCreate } } };
  }),
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: vi.fn() }));
vi.mock("@anthropic-ai/bedrock-sdk", () => ({ default: vi.fn() }));

import { createLLMClient } from "../llm-client";
import type { LLMClient, CreateMessageParams } from "../llm-client";

const ENV_KEYS = ["LLM_PROVIDER", "LLM_BASE_URL", "LLM_MODEL", "LLM_API_KEY", "OPENAI_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  mockCreate.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function makeOpenAICompatClient(): LLMClient {
  process.env.LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "sk-test";
  return createLLMClient().client;
}

function basicResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    model: "gpt-4o-mini",
    choices: [{ message: { content: "hello", tool_calls: undefined }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
    ...overrides,
  };
}

describe("OpenAICompatClient.createMessage", () => {
  it("テキストのみのレスポンスを Message 形式に変換する", async () => {
    mockCreate.mockResolvedValue(basicResponse());
    const client = makeOpenAICompatClient();
    const result = await client.createMessage({
      model: "gpt-4o-mini", max_tokens: 100, system: "sys", tools: [], messages: [],
    });
    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(result.stop_reason).toBe("end_turn");
    expect(result.usage.input_tokens).toBe(10);
    expect(result.usage.output_tokens).toBe(5);
  });

  it("tool_calls を含むレスポンスは tool_use ブロックに変換され stop_reason が tool_use になる", async () => {
    mockCreate.mockResolvedValue(basicResponse({
      choices: [{
        message: {
          content: null,
          tool_calls: [{ type: "function", id: "call_1", function: { name: "click", arguments: '{"x":1}' } }],
        },
        finish_reason: "tool_calls",
      }],
    }));
    const client = makeOpenAICompatClient();
    const result = await client.createMessage({
      model: "m", max_tokens: 100, system: "s", tools: [], messages: [],
    });
    expect(result.stop_reason).toBe("tool_use");
    expect(result.content).toEqual([{ type: "tool_use", id: "call_1", name: "click", input: { x: 1 } }]);
  });

  it("tool_calls の arguments が不正な JSON でも例外にならず空オブジェクトになる", async () => {
    mockCreate.mockResolvedValue(basicResponse({
      choices: [{
        message: { content: null, tool_calls: [{ type: "function", id: "call_1", function: { name: "x", arguments: "not json" } }] },
        finish_reason: "tool_calls",
      }],
    }));
    const client = makeOpenAICompatClient();
    const result = await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });
    expect(result.content).toEqual([{ type: "tool_use", id: "call_1", name: "x", input: {} }]);
  });

  it("usage が無いレスポンスでもトークン数は 0 にフォールバックする", async () => {
    mockCreate.mockResolvedValue(basicResponse({ usage: undefined }));
    const client = makeOpenAICompatClient();
    const result = await client.createMessage({ model: "m", max_tokens: 100, system: "s", tools: [], messages: [] });
    expect(result.usage.input_tokens).toBe(0);
    expect(result.usage.output_tokens).toBe(0);
  });

  it("params.model が空文字の場合はデフォルトモデルを使う", async () => {
    mockCreate.mockResolvedValue(basicResponse());
    const client = makeOpenAICompatClient();
    await client.createMessage({ model: "", max_tokens: 100, system: "s", tools: [], messages: [] });
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("gpt-4o-mini");
  });

  it("tools を OpenAI function 形式に変換する", async () => {
    mockCreate.mockResolvedValue(basicResponse());
    const client = makeOpenAICompatClient();
    await client.createMessage({
      model: "m", max_tokens: 100, system: "s",
      tools: [{ name: "click", description: "Click something", input_schema: { type: "object", properties: {} } }],
      messages: [],
    });
    const callArgs = mockCreate.mock.calls[0][0];
    expect(callArgs.tools).toEqual([{ type: "function", function: { name: "click", description: "Click something", parameters: { type: "object", properties: {} } } }]);
  });

  describe("メッセージ変換 (toOpenAIMessages)", () => {
    it("system プロンプトを先頭の system メッセージにする", async () => {
      mockCreate.mockResolvedValue(basicResponse());
      const client = makeOpenAICompatClient();
      await client.createMessage({ model: "m", max_tokens: 100, system: "be helpful", tools: [], messages: [] });
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[0]).toEqual({ role: "system", content: "be helpful" });
    });

    it("user role + string content をそのまま渡す", async () => {
      mockCreate.mockResolvedValue(basicResponse());
      const client = makeOpenAICompatClient();
      await client.createMessage({
        model: "m", max_tokens: 100, system: "s", tools: [],
        messages: [{ role: "user", content: "hi there" }],
      });
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[1]).toEqual({ role: "user", content: "hi there" });
    });

    it("user role + tool_result content を tool メッセージに変換する", async () => {
      mockCreate.mockResolvedValue(basicResponse());
      const client = makeOpenAICompatClient();
      await client.createMessage({
        model: "m", max_tokens: 100, system: "s", tools: [],
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "result text" }] }],
      });
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[1]).toEqual({ role: "tool", tool_call_id: "call_1", content: "result text" });
    });

    it("tool_result の content が配列（text block）の場合は結合する", async () => {
      mockCreate.mockResolvedValue(basicResponse());
      const client = makeOpenAICompatClient();
      await client.createMessage({
        model: "m", max_tokens: 100, system: "s", tools: [],
        messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "line1" }, { type: "text", text: "line2" }] }] }],
      });
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[1].content).toBe("line1\nline2");
    });

    it("assistant role + tool_use content を tool_calls に変換する", async () => {
      mockCreate.mockResolvedValue(basicResponse());
      const client = makeOpenAICompatClient();
      await client.createMessage({
        model: "m", max_tokens: 100, system: "s", tools: [],
        messages: [{ role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "click", input: { x: 1 } }] }],
      });
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[1].tool_calls).toEqual([
        { id: "call_1", type: "function", function: { name: "click", arguments: '{"x":1}' } },
      ]);
      expect(callArgs.messages[1].content).toBeNull();
    });

    it("assistant role + string content をそのまま渡す", async () => {
      mockCreate.mockResolvedValue(basicResponse());
      const client = makeOpenAICompatClient();
      await client.createMessage({
        model: "m", max_tokens: 100, system: "s", tools: [],
        messages: [{ role: "assistant", content: "ack" }],
      });
      const callArgs = mockCreate.mock.calls[0][0];
      expect(callArgs.messages[1]).toEqual({ role: "assistant", content: "ack" });
    });
  });
});
