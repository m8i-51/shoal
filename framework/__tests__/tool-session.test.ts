import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

vi.mock("../claude-cli-runner", () => ({
  runClaudeCliSession: vi.fn(),
}));

vi.mock("../llm-retry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm-retry")>();
  return {
    ...actual,
    createMessageWithRetry: vi.fn(),
  };
});

import { runToolSession, completeText, captureStructuredTool } from "../tool-session";
import { runClaudeCliSession } from "../claude-cli-runner";
import { createMessageWithRetry } from "../llm-retry";

function textMsg(text: string): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    model: "m",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Anthropic.Message;
}

function toolUseMsg(name: string, input: Record<string, unknown>): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id: "tu1", name, input }],
    model: "m",
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as Anthropic.Message;
}

describe("runToolSession", () => {
  beforeEach(() => {
    vi.mocked(createMessageWithRetry).mockReset();
    vi.mocked(runClaudeCliSession).mockReset();
  });

  it("claude-cli は runClaudeCliSession に委譲する", async () => {
    vi.mocked(runClaudeCliSession).mockResolvedValue({
      text: "cli",
      toolCaptures: { a: 1 },
      iterations: 2,
    });
    const result = await runToolSession({
      provider: "claude-cli",
      model: "claude-sonnet-4-6",
      system: "s",
      userPrompt: "u",
      tools: [],
      maxIterations: 3,
    });
    expect(result.text).toBe("cli");
    expect(runClaudeCliSession).toHaveBeenCalled();
    expect(createMessageWithRetry).not.toHaveBeenCalled();
  });

  it("Messages 経路で tool_use を実行し capture する", async () => {
    const execute = vi.fn(async () => "ok");
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseMsg("ping", { n: 1 }))
      .mockResolvedValueOnce(textMsg("bye"));

    const result = await runToolSession({
      provider: "anthropic",
      client: { createMessage: vi.fn() },
      model: "m",
      system: "s",
      userPrompt: "u",
      tools: [
        {
          name: "ping",
          description: "p",
          input_schema: { type: "object", properties: {} },
          execute,
        },
      ],
      maxIterations: 5,
    });

    expect(execute).toHaveBeenCalledWith({ n: 1 });
    expect(result.toolCaptures.ping).toEqual({ n: 1 });
    expect(result.text).toBe("bye");
    expect(result.iterations).toBe(2);
  });

  it("shouldStop で早期終了する（Messages・execute 後）", async () => {
    const execute = vi.fn(async () => "ok");
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(
      toolUseMsg("output_spec", { appName: "x" })
    );

    const result = await runToolSession({
      provider: "anthropic",
      client: { createMessage: vi.fn() },
      model: "m",
      system: "s",
      userPrompt: "u",
      tools: [
        {
          name: "output_spec",
          description: "o",
          input_schema: { type: "object", properties: {} },
          execute,
        },
      ],
      maxIterations: 8,
      shouldStop: ({ toolUses }) => toolUses.some((t) => t.name === "output_spec"),
    });

    expect(result.toolCaptures.output_spec).toEqual({ appName: "x" });
    expect(execute).toHaveBeenCalled();
    expect(createMessageWithRetry).toHaveBeenCalledTimes(1);
  });

  it("onAfterTools が results を書き換えられる", async () => {
    const execute = vi.fn(async () => "raw");
    vi.mocked(createMessageWithRetry)
      .mockResolvedValueOnce(toolUseMsg("ping", {}))
      .mockResolvedValueOnce(textMsg("done"));

    await runToolSession({
      provider: "anthropic",
      client: { createMessage: vi.fn() },
      model: "m",
      system: "s",
      userPrompt: "u",
      tools: [
        { name: "ping", description: "p", input_schema: { type: "object", properties: {} }, execute },
      ],
      maxIterations: 5,
      onAfterTools: ({ results }) => {
        results[0].content = `${results[0].content}\n[hint]`;
      },
    });

    expect(createMessageWithRetry).toHaveBeenCalledTimes(2);
    const secondParams = vi.mocked(createMessageWithRetry).mock.calls[1][1];
    const toolResultMsg = secondParams.messages.find(
      (m) =>
        m.role === "user" &&
        Array.isArray(m.content) &&
        m.content[0] &&
        typeof m.content[0] === "object" &&
        (m.content[0] as { type?: string }).type === "tool_result"
    );
    expect(toolResultMsg).toBeDefined();
    const block = (toolResultMsg!.content as Anthropic.ToolResultBlockParam[])[0];
    expect(block.content).toBe("raw\n[hint]");
  });
});

describe("completeText / captureStructuredTool", () => {
  beforeEach(() => {
    vi.mocked(createMessageWithRetry).mockReset();
  });

  it("completeText は最終テキストを返す", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(textMsg("hello"));
    const text = await completeText({
      provider: "anthropic",
      client: { createMessage: vi.fn() },
      model: "m",
      system: "s",
      userPrompt: "u",
    });
    expect(text).toBe("hello");
  });

  it("captureStructuredTool は tool input を返す", async () => {
    vi.mocked(createMessageWithRetry).mockResolvedValueOnce(
      toolUseMsg("output_scenarios", { scenarios: [] })
    );
    const captured = await captureStructuredTool({
      provider: "anthropic",
      client: { createMessage: vi.fn() },
      model: "m",
      system: "s",
      userPrompt: "u",
      tool: {
        name: "output_scenarios",
        description: "o",
        input_schema: { type: "object", properties: {} },
        execute: async () => "ok",
      },
    });
    expect(captured).toEqual({ scenarios: [] });
  });
});
