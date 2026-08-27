/**
 * Unified tool session: Messages API turn loop OR Claude CLI / Agent SDK.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessageParams, MessageParam, Tool } from "./llm-client";
import { createMessageWithRetry } from "./llm-retry";
import { runClaudeCliSession } from "./claude-cli-runner";
import type { ToolSessionParams, ToolSessionResult, SessionTool } from "./tool-types";

export type { ToolSessionParams, ToolSessionResult, SessionTool, UserPrompt, ToolResultContent } from "./tool-types";

function toAnthropicTools(tools: SessionTool[]): Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Tool["input_schema"],
  }));
}

function extractText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

async function runMessagesSession(params: ToolSessionParams): Promise<ToolSessionResult> {
  if (!params.client) {
    throw new Error("runToolSession: client is required for Messages-compatible providers");
  }

  const messages: MessageParam[] = [
    { role: "user", content: params.userPrompt as MessageParam["content"] },
  ];
  const toolCaptures: Record<string, unknown> = {};
  let text = "";
  let iterations = 0;
  const tools = toAnthropicTools(params.tools);
  const executeByName = new Map(params.tools.map((t) => [t.name, t.execute]));

  while (iterations < params.maxIterations) {
    iterations++;
    const response = await createMessageWithRetry(params.client, {
      model: params.model,
      max_tokens: params.maxTokens ?? 1024,
      system: params.system,
      tools,
      messages,
    } as CreateMessageParams);

    const assistantContent = response.content;
    messages.push({ role: "assistant", content: assistantContent });
    text = extractText(assistantContent);

    const toolUses = assistantContent.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );

    if (toolUses.length === 0 || response.stop_reason === "end_turn") {
      break;
    }

    for (const tu of toolUses) {
      toolCaptures[tu.name] = tu.input;
    }

    const mapped = toolUses.map((tu) => ({
      name: tu.name,
      input: tu.input as Record<string, unknown>,
      id: tu.id,
    }));

    // Capture-only early stop (no execute) when shouldStop says so before tools run.
    // Callers that need execute side effects (e.g. output_spec → mutate state) should
    // use shouldStop that becomes true only after execute — so we run tools first when
    // any tool has an execute handler. Convention: if shouldStop is true on the tool_use
    // names alone AND every matching tool's execute is a no-op capture, skip execute.
    // Simpler rule: always execute, then shouldStop.
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const exec = executeByName.get(toolUse.name);
      let result: string | Anthropic.ToolResultBlockParam["content"];
      if (!exec) {
        result = `Unknown tool: ${toolUse.name}`;
      } else {
        try {
          result = await exec(toolUse.input as Record<string, unknown>);
        } catch (e) {
          result = `Error: ${String(e)}`;
        }
      }
      toolResults.push({
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: result,
      });
    }

    await params.onAfterTools?.({
      toolUses: mapped,
      results: toolResults,
      iteration: iterations,
      maxIterations: params.maxIterations,
    });

    if (params.shouldStop?.({ toolUses: mapped, iteration: iterations })) {
      break;
    }

    messages.push({ role: "user", content: toolResults });
  }

  return { text, toolCaptures, iterations };
}

export async function runToolSession(params: ToolSessionParams): Promise<ToolSessionResult> {
  if (params.provider === "claude-cli") {
    return runClaudeCliSession({
      model: params.model,
      system: params.system,
      userPrompt: params.userPrompt,
      tools: params.tools,
      maxIterations: params.maxIterations,
      maxTokens: params.maxTokens,
      onAfterTools: params.onAfterTools,
      shouldStop: params.shouldStop,
    });
  }
  return runMessagesSession(params);
}

/** Convenience: text-only completion (no tools). */
export async function completeText(params: {
  provider: string;
  model: string;
  system: string;
  userPrompt: string;
  maxTokens?: number;
  client?: ToolSessionParams["client"];
}): Promise<string> {
  const result = await runToolSession({
    provider: params.provider,
    model: params.model,
    system: params.system,
    userPrompt: params.userPrompt,
    tools: [],
    maxIterations: 1,
    maxTokens: params.maxTokens ?? 1024,
    client: params.client,
  });
  return result.text;
}

/** Convenience: one structured tool call; returns captured input or null. */
export async function captureStructuredTool<T = Record<string, unknown>>(params: {
  provider: string;
  model: string;
  system: string;
  userPrompt: string;
  tool: SessionTool;
  maxTokens?: number;
  client?: ToolSessionParams["client"];
}): Promise<T | null> {
  const result = await runToolSession({
    provider: params.provider,
    model: params.model,
    system: params.system,
    userPrompt: params.userPrompt,
    tools: [
      {
        ...params.tool,
        execute: params.tool.execute ?? (async () => "ok"),
      },
    ],
    maxIterations: 3,
    maxTokens: params.maxTokens ?? 2048,
    client: params.client,
    shouldStop: ({ toolUses }) => toolUses.some((t) => t.name === params.tool.name),
  });
  const captured = result.toolCaptures[params.tool.name];
  return (captured as T) ?? null;
}
