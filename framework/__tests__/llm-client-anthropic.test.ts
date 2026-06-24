import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAnthropicCreate = vi.fn();
const mockBedrockCreate = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockAnthropicCreate } };
  }),
}));
vi.mock("@anthropic-ai/bedrock-sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockBedrockCreate } };
  }),
}));
vi.mock("openai", () => ({ default: vi.fn() }));

import { createLLMClient } from "../llm-client";

const ENV_KEYS = ["LLM_PROVIDER", "ANTHROPIC_API_KEY"] as const;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  mockAnthropicCreate.mockReset();
  mockBedrockCreate.mockReset();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("AnthropicClient.createMessage", () => {
  it("Anthropic SDK の messages.create にパラメータをそのまま渡す", async () => {
    const fakeMessage = { id: "m1", content: [], stop_reason: "end_turn" };
    mockAnthropicCreate.mockResolvedValue(fakeMessage);
    const { client } = createLLMClient();
    const params = { model: "claude-haiku-4-5-20251001", max_tokens: 100, system: "s", tools: [], messages: [] };
    const result = await client.createMessage(params);
    expect(result).toBe(fakeMessage);
    expect(mockAnthropicCreate).toHaveBeenCalledWith(params);
  });
});

describe("BedrockClient.createMessage", () => {
  it("Bedrock SDK の messages.create にパラメータをそのまま渡す", async () => {
    process.env.LLM_PROVIDER = "bedrock";
    const fakeMessage = { id: "m2", content: [], stop_reason: "end_turn" };
    mockBedrockCreate.mockResolvedValue(fakeMessage);
    const { client } = createLLMClient();
    const params = { model: "anthropic.claude-3-5-haiku-20241022-v1:0", max_tokens: 100, system: "s", tools: [], messages: [] };
    const result = await client.createMessage(params);
    expect(result).toBe(fakeMessage);
    expect(mockBedrockCreate).toHaveBeenCalledWith(params);
  });
});
