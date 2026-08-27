/**
 * Claude CLI / Agent SDK runner.
 * Uses the official Claude Code login; does not read or store OAuth tokens.
 */
import { createSdkMcpServer, tool, query as defaultQuery } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import type { SessionTool, ToolSessionResult, UserPrompt } from "./tool-types";

export const SHOAL_MCP_SERVER = "shoal";

export type QueryFn = typeof defaultQuery;

export interface ClaudeCliRunnerOptions {
  model: string;
  system: string;
  userPrompt: UserPrompt;
  tools: SessionTool[];
  maxIterations: number;
  maxTokens?: number;
  onAfterTools?: (ctx: {
    toolUses: { name: string; input: Record<string, unknown>; id: string }[];
    results: Anthropic.ToolResultBlockParam[];
    iteration: number;
    maxIterations: number;
  }) => void | Promise<void>;
  shouldStop?: (ctx: {
    toolUses: { name: string; input: Record<string, unknown>; id: string }[];
    iteration: number;
  }) => boolean;
  /** Injectable for tests. */
  queryFn?: QueryFn;
}

function jsonSchemaToZodShape(schema: Record<string, unknown>): Record<string, z.ZodTypeAny> {
  const properties = (schema.properties ?? {}) as Record<string, { type?: string; description?: string }>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let field: z.ZodTypeAny;
    switch (prop?.type) {
      case "string":
        field = z.string();
        break;
      case "number":
      case "integer":
        field = z.number();
        break;
      case "boolean":
        field = z.boolean();
        break;
      case "array":
        field = z.array(z.unknown());
        break;
      case "object":
        field = z.record(z.string(), z.unknown());
        break;
      default:
        field = z.unknown();
    }
    if (prop?.description) field = field.describe(prop.description);
    if (!required.has(key)) field = field.optional();
    shape[key] = field;
  }

  return shape;
}

function toMcpContent(result: string | Anthropic.ToolResultBlockParam["content"]): Array<
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
> {
  if (typeof result === "string") {
    return [{ type: "text", text: result }];
  }
  if (!Array.isArray(result)) {
    return [{ type: "text", text: String(result ?? "") }];
  }
  const out: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const block of result) {
    if (!block || typeof block !== "object") continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      out.push({ type: "text", text: b.text });
    } else if (b.type === "image") {
      const source = b.source as { type?: string; media_type?: string; data?: string } | undefined;
      if (source?.type === "base64" && typeof source.data === "string") {
        out.push({
          type: "image",
          data: source.data,
          mimeType: source.media_type ?? "image/png",
        });
      }
    }
  }
  return out.length > 0 ? out : [{ type: "text", text: "" }];
}

export function fqToolName(name: string): string {
  return `mcp__${SHOAL_MCP_SERVER}__${name}`;
}

export function bareToolName(fqOrBare: string): string {
  const prefix = `mcp__${SHOAL_MCP_SERVER}__`;
  return fqOrBare.startsWith(prefix) ? fqOrBare.slice(prefix.length) : fqOrBare;
}

async function* multimodalPrompt(userPrompt: UserPrompt): AsyncGenerator<{
  type: "user";
  message: Anthropic.MessageParam;
  parent_tool_use_id: null;
}> {
  const content =
    typeof userPrompt === "string"
      ? userPrompt
      : (userPrompt as Anthropic.ContentBlockParam[]);
  yield {
    type: "user",
    message: { role: "user", content },
    parent_tool_use_id: null,
  };
}

export async function runClaudeCliSession(opts: ClaudeCliRunnerOptions): Promise<ToolSessionResult> {
  const toolCaptures: Record<string, unknown> = {};
  let iteration = 0;
  const abort = new AbortController();
  const queryFn = opts.queryFn ?? defaultQuery;

  const mcpTools = opts.tools.map((t) => {
    const shape = jsonSchemaToZodShape(t.input_schema);
    // tool() requires a ZodRawShape; empty schemas get a dummy optional field
    const inputSchema = Object.keys(shape).length > 0 ? shape : { _empty: z.unknown().optional() };

    return tool(
      t.name,
      t.description || t.name,
      inputSchema,
      async (args) => {
        iteration++;
        const input = { ...(args as Record<string, unknown>) };
        delete input._empty;
        toolCaptures[t.name] = input;

        const toolUse = { name: t.name, input, id: `cli_${iteration}_${t.name}` };
        if (opts.shouldStop?.({ toolUses: [toolUse], iteration })) {
          // Still execute so captures are populated, then abort after return.
          queueMicrotask(() => abort.abort());
        }

        let result: string | Anthropic.ToolResultBlockParam["content"];
        try {
          result = await t.execute(input);
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `Error: ${String(e)}` }],
            isError: true,
          };
        }

        const toolResultBlock: Anthropic.ToolResultBlockParam = {
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: result,
        };
        const results = [toolResultBlock];
        await opts.onAfterTools?.({
          toolUses: [toolUse],
          results,
          iteration,
          maxIterations: opts.maxIterations,
        });
        // onAfterTools may mutate results[0].content
        return { content: toMcpContent(results[0].content) };
      },
    );
  });

  const server = createSdkMcpServer({
    name: SHOAL_MCP_SERVER,
    version: "1.0.0",
    tools: mcpTools,
  });

  const allowedTools = opts.tools.map((t) => fqToolName(t.name));
  // Wildcard also listed so newly added shoal tools stay auto-approved
  if (allowedTools.length > 0) allowedTools.push(`mcp__${SHOAL_MCP_SERVER}__*`);

  const prompt =
    typeof opts.userPrompt === "string"
      ? opts.userPrompt
      : multimodalPrompt(opts.userPrompt);

  let text = "";
  let numTurns = 0;

  try {
    for await (const message of queryFn({
      prompt,
      options: {
        model: opts.model,
        systemPrompt: opts.system,
        tools: [], // disable Claude Code built-ins
        mcpServers: { [SHOAL_MCP_SERVER]: server },
        allowedTools,
        permissionMode: "dontAsk",
        maxTurns: opts.maxIterations,
        abortController: abort,
        env: {
          ...process.env,
          CLAUDE_AGENT_SDK_CLIENT_APP: "shoal/claude-cli",
        },
      },
    })) {
      if (message.type === "result") {
        numTurns = message.num_turns ?? numTurns;
        if (message.subtype === "success" && "result" in message && typeof message.result === "string") {
          text = message.result;
        } else if (message.subtype !== "success" && "errors" in message) {
          const errors = (message as { errors?: string[] }).errors;
          if (errors?.length) {
            throw new Error(`Claude CLI session failed: ${errors.join("; ")}`);
          }
        }
      } else if (message.type === "assistant" && "message" in message) {
        const content = (message as { message?: { content?: unknown[] } }).message?.content;
        if (Array.isArray(content)) {
          const parts = content
            .filter((b): b is { type: "text"; text: string } =>
              !!b && typeof b === "object" && (b as { type?: string }).type === "text"
            )
            .map((b) => b.text);
          if (parts.length) text = parts.join("\n");
        }
      }
    }
  } catch (e) {
    if (abort.signal.aborted) {
      // Early stop via shouldStop — treat as success with captures
      return { text, toolCaptures, iterations: iteration || numTurns || 1 };
    }
    throw e;
  }

  return {
    text,
    toolCaptures,
    iterations: iteration || numTurns || 1,
  };
}
