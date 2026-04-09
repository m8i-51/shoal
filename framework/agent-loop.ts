import Anthropic from "@anthropic-ai/sdk";
import type { LLMClient, CreateMessageParams, Tool } from "./llm-client";
import type { AgentLog } from "./types";
import { runLog } from "./findings";

export let rateLimitRetries = 0;

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createMessageWithRetry(
  client: LLMClient,
  params: CreateMessageParams,
  retries = 5
): Promise<Anthropic.Message> {
  for (let i = 0; i < retries; i++) {
    try {
      return await client.createMessage(params);
    } catch (e: unknown) {
      const err = e as { status?: number; headers?: { get?: (key: string) => string | null } };
      if (err?.status === 429 && i < retries - 1) {
        const retryAfter = err?.headers?.get?.("retry-after");
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : (i + 1) * 10000;
        console.log(`  [rate-limit] waiting ${waitMs / 1000}s (attempt ${i + 1}/${retries})`);
        rateLimitRetries++;
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
  throw new Error("max retries exceeded");
}

export async function runAgentLoop(
  agentLog: AgentLog,
  systemPrompt: string,
  tools: Tool[],
  client: LLMClient,
  model: string,
  executeToolFn: (toolName: string, input: Record<string, unknown>) => Promise<string>
): Promise<void> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "Use the app." },
  ];

  try {
    while (agentLog.iterations < 10) {
      agentLog.iterations++;

      const response = await createMessageWithRetry(client, {
        model,
        max_tokens: 1024,
        system: systemPrompt,
        tools,
        messages,
      });

      const assistantContent: Anthropic.ContentBlock[] = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      const toolUses = assistantContent.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      if (toolUses.length === 0 || response.stop_reason === "end_turn") {
        agentLog.status = "completed";
        break;
      }

      if (agentLog.iterations >= 10) {
        agentLog.status = "iteration_limit";
        runLog.summary.iterationLimitReached++;
      }

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        console.log(`  → ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 80)})`);
        const result = await executeToolFn(
          toolUse.name,
          toolUse.input as Record<string, unknown>
        );
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
      }

      messages.push({ role: "user", content: toolResults });
    }
    runLog.summary.completed++;
  } catch (e) {
    agentLog.status = "error";
    agentLog.error = String(e);
    runLog.summary.errors++;
    console.error(`[${agentLog.agentName}] error:`, e);
  } finally {
    agentLog.completedAt = new Date().toISOString();
  }
}
