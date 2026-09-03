import type Anthropic from "@anthropic-ai/sdk";
import type { CreateMessageParams } from "./llm-client";
import { runLog } from "./findings";
import { assertWithinBudget, recordSpend } from "./budget";

export let rateLimitRetries = 0;

export async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * HTTP statuses worth retrying: 429 (rate limit), Anthropic's 529
 * (overloaded), and the 5xx family a provider or an intermediary proxy can
 * return under load. Client errors (4xx other than 429) mean the request
 * itself is wrong and retrying changes nothing.
 */
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

/** Node/undici error codes for a connection that never reached the server. */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

interface RetryableErrorShape {
  status?: number;
  name?: string;
  code?: string;
  cause?: { code?: string };
  headers?: { get?: (key: string) => string | null };
}

/**
 * True for a transient failure worth retrying: a retryable HTTP status, or a
 * network-level error that never got a response at all (a dropped
 * connection, a DNS blip, a timeout). The Anthropic SDK raises the latter as
 * `APIConnectionError` with no `status`, typically wrapping the real cause.
 */
export function isRetryableLLMError(e: unknown): boolean {
  const err = e as RetryableErrorShape;
  if (typeof err?.status === "number") return RETRYABLE_STATUSES.has(err.status);
  if (err?.name === "APIConnectionError" || err?.name === "APIConnectionTimeoutError") return true;
  const code = err?.code ?? err?.cause?.code;
  return typeof code === "string" && RETRYABLE_NETWORK_CODES.has(code);
}

/**
 * Parse a `retry-after` header value into milliseconds. Per RFC 7231 it is
 * either a delay in seconds or an HTTP-date; `parseInt` on the date form
 * silently returns `NaN` (it starts with a weekday name, not a digit), which
 * used to make a date-form header retry immediately instead of waiting.
 * Returns null when the header is absent or unparseable either way, so the
 * caller falls back to its own backoff rather than waiting `NaN` ms.
 */
export function parseRetryAfterMs(retryAfter: string | null | undefined): number | null {
  if (!retryAfter) return null;
  const trimmed = retryAfter.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const dateMs = Date.parse(trimmed);
  if (!Number.isFinite(dateMs)) return null;
  return Math.max(0, dateMs - Date.now());
}

/**
 * Exponential backoff with a little jitter, so concurrent lanes hitting the
 * same rate limit at the same moment don't all wake up and retry in lockstep.
 */
function backoffMs(attempt: number): number {
  const base = (attempt + 1) * 10000;
  const jitter = Math.floor(Math.random() * 1000);
  return base + jitter;
}

export async function createMessageWithRetry(
  client: { createMessage: (params: CreateMessageParams) => Promise<Anthropic.Message> },
  params: CreateMessageParams,
  retries = 5
): Promise<Anthropic.Message> {
  for (let i = 0; i < retries; i++) {
    // Checked before *every* attempt, not once per call: a backoff can last
    // tens of seconds, and another lane may exhaust the cap while we wait.
    // Concurrent lanes can still each pass this check before any of them
    // records its spend, so the cap is overshot by at most the calls already in
    // flight — bounded by lane concurrency, not unbounded.
    assertWithinBudget();

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
      if (isRetryableLLMError(e) && i < retries - 1) {
        const err = e as RetryableErrorShape;
        const waitMs = parseRetryAfterMs(err?.headers?.get?.("retry-after")) ?? backoffMs(i);
        const label = typeof err?.status === "number" ? `status ${err.status}` : (err?.name ?? err?.code ?? "network error");
        console.log(`  [retry] ${label} — waiting ${(waitMs / 1000).toFixed(1)}s (attempt ${i + 1}/${retries})`);
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
