import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Browser, BrowserContext, Page } from "playwright";

vi.mock("fs", () => ({ mkdirSync: vi.fn() }));
vi.mock("../guardrails", () => ({ applyBrowserGuardrails: vi.fn() }));
vi.mock("../session-store", () => ({ saveAgentSession: vi.fn() }));
vi.mock("../trace-scrub", () => ({ scrubTraceZipSafely: vi.fn() }));
vi.mock("../trace-chunk", () => ({ traceAgentZipPath: (runId: string, agentId: string) => `logs/traces/${runId}/${agentId}.zip` }));
vi.mock("../log", () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }));

import { applyBrowserGuardrails } from "../guardrails";
import { saveAgentSession } from "../session-store";
import { scrubTraceZipSafely } from "../trace-scrub";
import { baseContextOptions, withAgentContext, type AgentContextOptions } from "../agent-context";

function makeBrowser() {
  const page = { url: () => "about:blank" } as unknown as Page;
  const tracing = { start: vi.fn(), stop: vi.fn() };
  const context = {
    tracing,
    newPage: vi.fn().mockResolvedValue(page),
    close: vi.fn(),
  } as unknown as BrowserContext & { tracing: typeof tracing };
  const newContext = vi.fn().mockResolvedValue(context);
  return { browser: { newContext } as unknown as Browser, context, page, tracing, newContext };
}

function options(over: Partial<AgentContextOptions> & Pick<AgentContextOptions, "browser">): AgentContextOptions {
  return {
    agentId: "agent_1",
    agentName: "Aki",
    contextOptions: { viewport: { width: 800, height: 600 } },
    mode: "safe",
    runId: "run_1",
    trace: false,
    saveSession: false,
    ...over,
  };
}

beforeEach(() => {
  vi.mocked(applyBrowserGuardrails).mockReset();
  vi.mocked(saveAgentSession).mockReset();
  vi.mocked(scrubTraceZipSafely).mockReset();
});

describe("baseContextOptions", () => {
  it("storageState は指定されたときだけ載る", () => {
    expect(baseContextOptions({ width: 800, height: 600 })).toEqual({ viewport: { width: 800, height: 600 } });
    expect(baseContextOptions({ width: 800, height: 600 }, "cache/sessions/a.json").storageState)
      .toBe("cache/sessions/a.json");
  });
});

describe("withAgentContext", () => {
  it("guardrails を適用し、page を渡して結果を返し、context を閉じる", async () => {
    const { browser, context, page, newContext } = makeBrowser();
    const onPage = vi.fn();

    const result = await withAgentContext(options({ browser, onPage }), async (p, c) => {
      expect(p).toBe(page);
      expect(c).toBe(context);
      return "done";
    });

    expect(result).toBe("done");
    expect(newContext).toHaveBeenCalledWith({ viewport: { width: 800, height: 600 } });
    expect(applyBrowserGuardrails).toHaveBeenCalledWith(context, "safe");
    expect(onPage).toHaveBeenCalledWith(page);
    expect(context.close).toHaveBeenCalled();
  });

  it("trace=false ならトレースを開始も保存もしない", async () => {
    const { browser, tracing } = makeBrowser();
    await withAgentContext(options({ browser }), async () => undefined);
    expect(tracing.start).not.toHaveBeenCalled();
    expect(tracing.stop).not.toHaveBeenCalled();
    expect(scrubTraceZipSafely).not.toHaveBeenCalled();
  });

  it("trace=true なら agent ごとの zip に保存して秘匿値を除去する", async () => {
    const { browser, tracing } = makeBrowser();
    await withAgentContext(options({ browser, trace: true }), async () => undefined);
    expect(tracing.start).toHaveBeenCalledWith({ screenshots: true, snapshots: true });
    expect(tracing.stop).toHaveBeenCalledWith({ path: "logs/traces/run_1/agent_1.zip" });
    expect(scrubTraceZipSafely).toHaveBeenCalledWith("logs/traces/run_1/agent_1.zip", "agent trace Aki");
  });

  it("saveSession=true のときだけ close の前にセッションを保存する", async () => {
    const withSave = makeBrowser();
    await withAgentContext(options({ browser: withSave.browser, saveSession: true }), async () => undefined);
    expect(saveAgentSession).toHaveBeenCalledWith(withSave.context, "agent_1");

    vi.mocked(saveAgentSession).mockReset();
    const withoutSave = makeBrowser();
    await withAgentContext(options({ browser: withoutSave.browser }), async () => undefined);
    expect(saveAgentSession).not.toHaveBeenCalled();
  });

  it("本体が投げてもトレース保存と close は実行される", async () => {
    const { browser, context, tracing } = makeBrowser();
    await expect(
      withAgentContext(options({ browser, trace: true, saveSession: true }), async () => {
        throw new Error("agent exploded");
      }),
    ).rejects.toThrow("agent exploded");
    expect(saveAgentSession).toHaveBeenCalled();
    expect(tracing.stop).toHaveBeenCalled();
    expect(context.close).toHaveBeenCalled();
  });

  it("初期化（onPage）が失敗しても context は閉じ、セッションは保存しない", async () => {
    const { browser, context, tracing } = makeBrowser();
    await expect(
      withAgentContext(
        options({
          browser,
          trace: true,
          saveSession: true,
          onPage: async () => {
            throw new Error("cdp init failed");
          },
        }),
        async () => undefined,
      ),
    ).rejects.toThrow("cdp init failed");
    expect(context.close).toHaveBeenCalled();
    expect(saveAgentSession).not.toHaveBeenCalled();
    expect(tracing.stop).toHaveBeenCalled();
  });

  it("guardrails 適用が失敗しても context は閉じる", async () => {
    const { browser, context, tracing } = makeBrowser();
    vi.mocked(applyBrowserGuardrails).mockRejectedValueOnce(new Error("guardrail failed"));
    await expect(
      withAgentContext(options({ browser, trace: true, saveSession: true }), async () => undefined),
    ).rejects.toThrow("guardrail failed");
    expect(context.close).toHaveBeenCalled();
    expect(tracing.start).not.toHaveBeenCalled();
    expect(tracing.stop).not.toHaveBeenCalled();
    expect(saveAgentSession).not.toHaveBeenCalled();
  });

  it("tracing.start が失敗しても本体は走る", async () => {
    const { browser, tracing } = makeBrowser();
    tracing.start.mockRejectedValueOnce(new Error("no trace"));
    const result = await withAgentContext(options({ browser, trace: true }), async () => "ok");
    expect(result).toBe("ok");
  });
});
