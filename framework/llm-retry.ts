import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessageParams } from "./llm-client";
import { runLog } from "./findings";
import { assertWithinBudget, recordSpend } from "./budget";

export let rateLimitRetries = 0;

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function createMessageWithRetry(
  client: { createMessage: (params: CreateMessageParams) => Promise<Anthropic.Message> },
  params: CreateMessageParams,
  retries = 5
): Promise<Anthropic.Message> {
  // Refuse to start another call once the run has spent its SHOAL_MAX_USD cap.
  assertWithinBudget();

  for (let i = 0; i < retries; i++) {
    try {
      const response = await client.createMessage(params);
      const inputTokens = response.usage?.input_tokens ?? 0;
      const outputTokens = response.usage?.output_tokens ?? 0;
      if (runLog?.summary?.cost) {
        runLog.summary.cost.inputTokens += inputTokens;
        runLog.summary.cost.outputTokens += outputTokens;
      }
      recordSpend(
        params.model,
        process.env.LLM_PROVIDER ?? "anthropic",
        inputTokens,
        outputTokens,
      );
      return response;
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

/** @deprecated kept for tests that reset the counter via this module path */
export function _resetRateLimitRetriesForTests(): void {
  rateLimitRetries = 0;
}
