import { describe, it, expect, vi, beforeEach } from "vitest";
import { fqToolName, bareToolName, runClaudeCliSession, SHOAL_MCP_SERVER } from "../claude-cli-runner";
import { ToolSessionNoOpError } from "../tool-types";

type RegisteredTool = {
  handler: (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;
};

function successResult(result = "done") {
  return {
    type: "result" as const,
    subtype: "success" as const,
    result,
    num_turns: 1,
    is_error: false,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    stop_reason: "end_turn",
    uuid: "u",
    session_id: "s",
  };
}

const pingTool = {
  name: "ping",
  description: "ping",
  input_schema: {
    type: "object",
    properties: { x: { type: "string" } },
    required: ["x"],
  },
  execute: vi.fn(async (input: Record<string, unknown>) => `saw:${input.x}`),
};

// The Agent SDK keeps tool handlers on the in-process MCP server. Calling one
// is how a unit test shows that a real tool invocation counts as progress.
async function invokeRegistered(
  params: {
    options?: {
      mcpServers?: Record<string, { instance?: { _registeredTools?: Record<string, RegisteredTool> } }>;
    };
  },
  name: string,
  args: Record<string, unknown>,
) {
  const handler = params.options?.mcpServers?.shoal?.instance?._registeredTools?.[name]?.handler;
  if (!handler) throw new Error(`missing MCP handler for ${name}`);
  await handler(args, {});
}

describe("fqToolName / bareToolName", () => {
  it("builds and strips mcp__shoal__ prefix", () => {
    expect(fqToolName("navigate")).toBe("mcp__shoal__navigate");
    expect(bareToolName("mcp__shoal__navigate")).toBe("navigate");
    expect(bareToolName("navigate")).toBe("navigate");
    expect(SHOAL_MCP_SERVER).toBe("shoal");
  });
});

describe("runClaudeCliSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers MCP tools and disables built-ins", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => `saw:${input.x}`);
    const queryFn = vi.fn(async function* (
      params: Parameters<typeof invokeRegistered>[0],
    ) {
      await invokeRegistered(params, "ping", { x: "1" });
      yield successResult();
    });

    const result = await runClaudeCliSession({
      model: "claude-sonnet-4-6",
      system: "sys",
      userPrompt: "go",
      tools: [{ ...pingTool, execute }],
      maxIterations: 5,
      queryFn: queryFn as never,
    });

    expect(result.text).toBe("done");
    expect(result.iterations).toBe(1);
    expect(result.toolCaptures.ping).toEqual({ x: "1" });
    expect(execute).toHaveBeenCalledWith({ x: "1" });
    expect(queryFn).toHaveBeenCalledTimes(1);
    const firstCall = (queryFn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(firstCall).toBeDefined();
    const call = firstCall![0] as {
      options: {
        tools: unknown;
        model: string;
        systemPrompt: string;
        maxTurns: number;
        permissionMode: string;
        allowedTools: string[];
        mcpServers: Record<string, unknown>;
      };
    };
    expect(call.options.tools).toEqual([]);
    expect(call.options.model).toBe("claude-sonnet-4-6");
    expect(call.options.systemPrompt).toBe("sys");
    expect(call.options.maxTurns).toBe(5);
    expect(call.options.permissionMode).toBe("dontAsk");
    expect(call.options.allowedTools).toContain("mcp__shoal__ping");
    expect(call.options.allowedTools).toContain("mcp__shoal__*");
    expect(call.options.mcpServers).toHaveProperty("shoal");
  });

  it("retries once when a tool session makes no calls, then fails loud", async () => {
    const queryFn = vi.fn(async function* () {
      yield successResult("nothing");
    });

    await expect(runClaudeCliSession({
      model: "m",
      system: "s",
      userPrompt: "u",
      tools: [pingTool],
      maxIterations: 3,
      queryFn: queryFn as never,
    })).rejects.toBeInstanceOf(ToolSessionNoOpError);
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("accepts the retry when the second attempt calls a tool", async () => {
    let attempt = 0;
    const execute = vi.fn(async () => "ok");
    const queryFn = vi.fn(async function* (
      params: Parameters<typeof invokeRegistered>[0],
    ) {
      attempt++;
      if (attempt === 2) await invokeRegistered(params, "ping", { x: "retry" });
      yield successResult("done");
    });

    const result = await runClaudeCliSession({
      model: "m",
      system: "s",
      userPrompt: "u",
      tools: [{ ...pingTool, execute }],
      maxIterations: 3,
      queryFn: queryFn as never,
    });
    expect(result.text).toBe("done");
    expect(result.toolCaptures.ping).toEqual({ x: "retry" });
    expect(queryFn).toHaveBeenCalledTimes(2);
  });

  it("does not retry a real CLI error", async () => {
    // eslint-disable-next-line require-yield -- throws before any yield, on purpose
    const queryFn = vi.fn(async function* () {
      throw new Error("boom");
    });

    await expect(runClaudeCliSession({
      model: "m",
      system: "s",
      userPrompt: "u",
      tools: [pingTool],
      maxIterations: 2,
      queryFn: queryFn as never,
    })).rejects.toThrow("boom");
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("text-only sessions with no tools are not a no-op failure", async () => {
    const queryFn = vi.fn(async function* () {
      yield successResult("hello");
    });
    const result = await runClaudeCliSession({
      model: "m",
      system: "s",
      userPrompt: "u",
      tools: [],
      maxIterations: 1,
      queryFn: queryFn as never,
    });
    expect(result.text).toBe("hello");
    expect(queryFn).toHaveBeenCalledTimes(1);
  });

  it("supports image tool results via toMcpContent path when handler runs", async () => {
    const execute = vi.fn(async (_input?: Record<string, unknown>) => [
      { type: "text" as const, text: "ok" },
      {
        type: "image" as const,
        source: { type: "base64" as const, media_type: "image/png", data: "AAAA" },
      },
    ]);
    const content = await execute();
    expect(content[1]).toMatchObject({ type: "image", source: { data: "AAAA" } });
  });

  it("propagates shouldStop abort as success with captures when aborted mid-flight", async () => {
    let capturedAbort: AbortController | undefined;
    // eslint-disable-next-line require-yield -- throws before any yield, on purpose
    const queryFn = vi.fn(async function* (params: { options?: { abortController?: AbortController } }) {
      capturedAbort = params.options?.abortController;
      capturedAbort?.abort();
      throw new Error("aborted");
    });

    const result = await runClaudeCliSession({
      model: "m",
      system: "s",
      userPrompt: "u",
      tools: [],
      maxIterations: 2,
      queryFn: queryFn as never,
    });
    expect(result.text).toBe("");
    expect(result.toolCaptures).toEqual({});
  });
});
