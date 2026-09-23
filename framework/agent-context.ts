/**
 * agent-context.ts
 * ブラウザ系レーン（browser / threshold / regression / verify）共通の
 * Playwright コンテキストのライフサイクル。
 *
 * newContext → guardrails → tracing.start → newPage → 本体 → session 保存
 * → tracing.stop + scrub → close までを 1 箇所にまとめ、レーンごとの差分
 * （環境プロファイル、セッション保存の有無、トレースの有無）だけを引数で受ける。
 */

import * as fs from "fs";
import * as path from "path";
import type { Browser, BrowserContext, BrowserContextOptions, Page } from "playwright";
import { applyBrowserGuardrails, type ShoalMode } from "./guardrails";
import { saveAgentSession } from "./session-store";
import { traceAgentZipPath } from "./trace-chunk";
import { scrubTraceZipSafely } from "./trace-scrub";
import * as log from "./log";

export interface AgentContextOptions {
  browser: Browser;
  agentId: string;
  agentName: string;
  contextOptions: BrowserContextOptions;
  mode: ShoalMode;
  runId: string;
  /** Playwright トレースを記録するか（SHOAL_TRACE） */
  trace: boolean;
  /** 次の run で再訪ユーザーになれるよう storageState を保存するか */
  saveSession: boolean;
  /** page 生成直後に一度だけ走るフック（ネットワークスロットリングなど） */
  onPage?: (page: Page) => Promise<void>;
}

/**
 * viewport とログイン済み storageState だけを載せた context オプション。
 * ペルソナの環境プロファイルはこの上に buildContextOptions で重ねる。
 */
export function baseContextOptions(
  viewport: BrowserContextOptions["viewport"],
  storageStatePath?: string,
): BrowserContextOptions {
  const options: BrowserContextOptions = { viewport };
  if (storageStatePath) options.storageState = storageStatePath;
  return options;
}

export async function withAgentContext<T>(
  options: AgentContextOptions,
  run: (page: Page, context: BrowserContext) => Promise<T>,
): Promise<T> {
  const { browser, agentId, agentName, mode, runId, trace, saveSession, onPage } = options;
  const context = await browser.newContext(options.contextOptions);
  await applyBrowserGuardrails(context, mode);
  if (trace) {
    try {
      await context.tracing.start({ screenshots: true, snapshots: true });
    } catch (e) {
      log.warn(`[trace] failed to start for ${agentName}:`, e);
    }
  }
  const page = await context.newPage();
  if (onPage) await onPage(page);
  try {
    return await run(page, context);
  } finally {
    // close 前に呼ぶ必要がある
    if (saveSession) await saveAgentSession(context, agentId);
    if (trace) {
      const tracePath = traceAgentZipPath(runId, agentId);
      try {
        fs.mkdirSync(path.dirname(tracePath), { recursive: true });
        await context.tracing.stop({ path: tracePath });
        await scrubTraceZipSafely(tracePath, `agent trace ${agentName}`);
      } catch (e) {
        log.warn(`[trace] failed to save for ${agentName}:`, e);
      }
    }
    await context.close();
  }
}
