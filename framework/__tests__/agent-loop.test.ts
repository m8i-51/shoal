import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../findings", () => ({ runLog: undefined }));

import * as findingsModule from "../findings";
import { createMessageWithRetry, runAgentLoop, sleep } from "../agent-loop";
import type { LLMClient } from "../llm-client";
import type { AgentLog } from "../types";

function makeRunLog() {
  return {
    runId: "run_1",
    startedAt: "",
    completedAt: null,
    repo: "",
    agents: [],
    summary: {
      totalAgents: 0,
      completed: 0,
      errors: 0,
      iterationLimitReached: 0,
      totalActions: 0,
      totalIssuesPosted: 0,
      regressionChecked: 0,
      regressionFailed: 0,
      rateLimitRetries: 0,
      cost: { inputTokens: 0, outputTokens: 0, estimatedUSD: null },
    },
  };
}

function makeAgentLog(overrides: Partial<AgentLog> = {}): AgentLog {
  return {
    agentType: "explorer",
    agentId: "a1",
    agentName: "Alice",
    role: "tester",
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "completed",
    iterations: 0,
    actions: [],
    visitedPaths: [],
    issuesPosted: [],
    regressionChecks: [],
    error: null,
    ...overrides,
  };
}

function makeClient(createMessage: ReturnType<typeof vi.fn>): LLMClient {
  return { createMessage } as unknown as LLMClient;
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("sleep", () => {
  it("指定したミリ秒後に解決する", async () => {
    vi.useFakeTimers();
    const promise = sleep(1000);
    let resolved = false;
    promise.then(() => { resolved = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(resolved).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolved).toBe(true);
    vi.useRealTimers();
  });
});

describe("createMessageWithRetry", () => {
  it("成功時はレスポンスを返す", async () => {
    const response = { content: [], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
    const createMessage = vi.fn().mockResolvedValue(response);
    const result = await createMessageWithRetry(makeClient(createMessage), {
      model: "m", max_tokens: 100, system: "s", tools: [], messages: [],
    } as never);
    expect(result).toBe(response);
  });

  it("runLog が未初期化（undefined）でも例外にならない", async () => {
    vi.mocked(findingsModule).runLog = undefined as never;
    const createMessage = vi.fn().mockResolvedValue({ content: [], stop_reason: "end_turn", usage: {} });
    await expect(createMessageWithRetry(makeClient(createMessage), {} as never)).resolves.toBeDefined();
  });

  it("runLog.summary.cost がある場合はトークン数を加算する", async () => {
    const runLog = makeRunLog();
    vi.mocked(findingsModule).runLog = runLog as never;
    const createMessage = vi.fn().mockResolvedValue({ content: [], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } });
    await createMessageWithRetry(makeClient(createMessage), {} as never);
    expect(runLog.summary.cost.inputTokens).toBe(100);
    expect(runLog.summary.cost.outputTokens).toBe(50);
  });

  it("429 エラー時は retry-after ヘッダーに従って待機しリトライする", async () => {
    vi.useFakeTimers();
    const err = { status: 429, headers: { get: (k: string) => (k === "retry-after" ? "2" : null) } };
    const createMessage = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ content: [], stop_reason: "end_turn", usage: {} });

    const promise = createMessageWithRetry(makeClient(createMessage), {} as never, 3);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await promise;
    expect(result).toBeDefined();
    expect(createMessage).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("429 エラーで retry-after が無い場合は指数的に待機する", async () => {
    vi.useFakeTimers();
    const err = { status: 429, headers: { get: () => null } };
    const createMessage = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ content: [], stop_reason: "end_turn", usage: {} });

    const promise = createMessageWithRetry(makeClient(createMessage), {} as never, 3);
    await vi.advanceTimersByTimeAsync(10000);
    await expect(promise).resolves.toBeDefined();
    vi.useRealTimers();
  });

  it("429 以外のエラーは即座に throw する", async () => {
    const err = { status: 500 };
    const createMessage = vi.fn().mockRejectedValue(err);
    await expect(createMessageWithRetry(makeClient(createMessage), {} as never, 3)).rejects.toBe(err);
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it("最後の試行で 429 が発生した場合は throw する（リトライしない）", async () => {
    const err = { status: 429, headers: { get: () => null } };
    const createMessage = vi.fn().mockRejectedValue(err);
    await expect(createMessageWithRetry(makeClient(createMessage), {} as never, 1)).rejects.toBe(err);
  });
});

describe("runAgentLoop", () => {
  beforeEach(() => {
    vi.mocked(findingsModule).runLog = makeRunLog() as never;
  });

  it("tool_use が無い応答で completed になる", async () => {
    const agentLog = makeAgentLog();
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "done" }],
      stop_reason: "end_turn",
      usage: {},
    });
    await runAgentLoop(agentLog, "sys", [], makeClient(createMessage), "m", vi.fn());
    expect(agentLog.status).toBe("completed");
    expect(agentLog.completedAt).not.toBeNull();
  });

  it("tool_use がある場合は executeToolFn を呼んでループを継続する", async () => {
    const agentLog = makeAgentLog();
    const executeToolFn = vi.fn().mockResolvedValue("tool result");
    const createMessage = vi.fn()
      .mockResolvedValueOnce({
        content: [{ type: "tool_use", id: "t1", name: "click", input: { x: 1 } }],
        stop_reason: "tool_use",
        usage: {},
      })
      .mockResolvedValueOnce({ content: [], stop_reason: "end_turn", usage: {} });

    await runAgentLoop(agentLog, "sys", [], makeClient(createMessage), "m", executeToolFn);
    expect(executeToolFn).toHaveBeenCalledWith("click", { x: 1 });
    expect(agentLog.status).toBe("completed");
  });

  it("10 イテレーションに達すると iteration_limit になる", async () => {
    const agentLog = makeAgentLog();
    const executeToolFn = vi.fn().mockResolvedValue("result");
    const createMessage = vi.fn().mockResolvedValue({
      content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
      stop_reason: "tool_use",
      usage: {},
    });

    await runAgentLoop(agentLog, "sys", [], makeClient(createMessage), "m", executeToolFn);
    expect(agentLog.status).toBe("iteration_limit");
    expect(agentLog.iterations).toBe(10);
    expect(vi.mocked(findingsModule).runLog!.summary.iterationLimitReached).toBe(1);
  });

  it("例外発生時は error 状態になり runLog.summary.errors が増える", async () => {
    const agentLog = makeAgentLog();
    const createMessage = vi.fn().mockRejectedValue(new Error("network down"));
    await runAgentLoop(agentLog, "sys", [], makeClient(createMessage), "m", vi.fn());
    expect(agentLog.status).toBe("error");
    expect(agentLog.error).toContain("network down");
    expect(vi.mocked(findingsModule).runLog!.summary.errors).toBe(1);
    expect(agentLog.completedAt).not.toBeNull();
  });

  it("正常完了時は runLog.summary.completed が増える", async () => {
    const agentLog = makeAgentLog();
    const createMessage = vi.fn().mockResolvedValue({ content: [], stop_reason: "end_turn", usage: {} });
    await runAgentLoop(agentLog, "sys", [], makeClient(createMessage), "m", vi.fn());
    expect(vi.mocked(findingsModule).runLog!.summary.completed).toBe(1);
  });
});
