import * as fs from "fs";
import * as path from "path";
import type { BrowserContext } from "playwright";

/**
 * Session store — 「翌日また来るユーザー」を再現する。
 *
 * ブラウザエージェントの storageState（cookie / localStorage）を
 * cache/sessions/<agentId>.json に保存し、次の run で同じエージェントに復元する。
 * ログイン状態・下書き・通知既読などアプリ内状態のライフサイクルを、
 * 初回訪問ではなく「再訪ユーザー」として実体験できるようになる。
 * cookie を含むためディレクトリは gitignore 対象。
 */

const SESSIONS_DIR = path.join(process.cwd(), "cache", "sessions");

export function agentSessionPath(agentId: string): string {
  return path.join(SESSIONS_DIR, `${agentId}.json`);
}

export function hasAgentSession(agentId: string): boolean {
  try {
    return fs.existsSync(agentSessionPath(agentId));
  } catch {
    return false;
  }
}

/** run 終了時に呼ぶ — 失敗しても run は止めない */
export async function saveAgentSession(context: BrowserContext, agentId: string): Promise<void> {
  try {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    await context.storageState({ path: agentSessionPath(agentId) });
  } catch (e) {
    console.warn(`[session] failed to save session for ${agentId}:`, e);
  }
}

/** セッションが復元されたエージェントのシステムプロンプトに注入する */
export function sessionContinuityPrompt(restored: boolean): string {
  if (!restored) return "";
  return `
[Session Continuity]
You are browsing with the SAME browser profile as your last visit — cookies and local storage are preserved, so you may still be logged in and any data you created before may still exist.
Behave like a returning user: check whether things you left behind (drafts, items, settings, notifications) survived and still make sense. Report anything that was silently lost, reset, or now looks stale as a finding.`;
}
