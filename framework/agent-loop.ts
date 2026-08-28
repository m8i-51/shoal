import type { LLMClient, Tool } from "./llm-client";
import type { AgentLog } from "./types";
import { runLog } from "./findings";
import { runToolSession } from "./tool-session";
import { createMessageWithRetry, sleep, rateLimitRetries } from "./llm-retry";
import { formatToolCallLog } from "./redact";

export { createMessageWithRetry, sleep, rateLimitRetries };

export async function runAgentLoop(
  agentLog: AgentLog,
  systemPrompt: string,
  tools: Tool[],
  client: LLMClient,
  model: string,
  executeToolFn: (toolName: string, input: Record<string, unknown>) => Promise<string>,
  provider = process.env.LLM_PROVIDER ?? "anthropic",
  maxIterations = 10,
): Promise<void> {
  try {
    const sessionTools = tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      input_schema: t.input_schema as Record<string, unknown>,
      execute: async (input: Record<string, unknown>) => {
        console.log(`  → ${formatToolCallLog(t.name, input)}`);
        return executeToolFn(t.name, input);
      },
    }));

    const result = await runToolSession({
      provider,
      client,
      model,
      system: systemPrompt,
      userPrompt: "Use the app.",
      tools: sessionTools,
      maxIterations,
      maxTokens: 1024,
    });

    agentLog.iterations = result.iterations;
    if (agentLog.iterations >= maxIterations) {
      agentLog.status = "iteration_limit";
      runLog.summary.iterationLimitReached++;
    } else {
      agentLog.status = "completed";
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
