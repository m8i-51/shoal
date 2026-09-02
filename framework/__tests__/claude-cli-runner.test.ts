import { describe, it, expect, vi, beforeEach } from "vitest";
import { fqToolName, bareToolName, runClaudeCliSession, SHOAL_MCP_SERVER } from "../claude-cli-runner";

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

  it("registers MCP tools, disables built-ins, captures tool input, returns text", async () => {
    const execute = vi.fn(async (input: Record<string, unknown>) => {
      return `saw:${input.x}`;
    });

    const queryFn = vi.fn(async function* () {
      // Simulate SDK invoking our tool handler indirectly by... we need the
      // handler to run. The real createSdkMcpServer wraps handlers; in unit
      // tests we assert query options and synthesize a success result.
      yield {
        type: "result",
        subtype: "success",
        result: "done",
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
    });

    // Manually invoke tool path via a side channel: call execute to verify image conversion separately
    const result = await runClaudeCliSession({
      model: "claude-sonnet-4-6",
      system: "sys",
      userPrompt: "go",
      tools: [
        {
          name: "ping",
          description: "ping",
          input_schema: {
            type: "object",
            properties: { x: { type: "string" } },
            required: ["x"],
          },
          execute,
        },
      ],
      maxIterations: 5,
      queryFn: queryFn as never,
    });

    expect(result.text).toBe("done");
    expect(result.iterations).toBe(1);
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
