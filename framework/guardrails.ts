import type { BrowserContext, Page } from "playwright";
import type { Tool } from "./llm-client";
import { resolveClickLocator } from "./click-target";

/**
 * Guardrails — 探索エージェントの書き込み操作を制御する安全装置。
 *
 * SHOAL_MODE:
 * - "read-only": 一切の書き込みを禁止。ブラウザは mutation メソッド
 *   (POST/PUT/PATCH/DELETE) をネットワーク層でブロックし、
 *   destructive 指定された API ツールを除外する
 * - "safe" (デフォルト): テストデータの作成・編集は許可するが、
 *   不可逆な操作（削除・支払い・実在の宛先への送信など）を
 *   プロンプト + ネットワーク/クリック層で抑止し、destructive 指定された API ツールを除外する
 * - "full": 制限なし（従来の挙動）
 */

export type ShoalMode = "read-only" | "safe" | "full";

export const SHOAL_MODES: ShoalMode[] = ["read-only", "safe", "full"];

export function getShoalMode(env: NodeJS.ProcessEnv = process.env): ShoalMode {
  const raw = (env.SHOAL_MODE ?? "safe").trim().toLowerCase();
  if ((SHOAL_MODES as string[]).includes(raw)) return raw as ShoalMode;
  console.warn(`[guardrails] unknown SHOAL_MODE "${raw}" — falling back to "safe"`);
  return "safe";
}

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function shouldBlockRequest(method: string, mode: ShoalMode): boolean {
  const upper = method.toUpperCase();
  if (mode === "read-only") return MUTATION_METHODS.has(upper);
  if (mode === "safe") return upper === "DELETE";
  return false;
}

/** read-only / safe モードのとき、ブラウザコンテキストの危険リクエストをブロックする */
export async function applyBrowserGuardrails(context: BrowserContext, mode: ShoalMode): Promise<void> {
  if (mode === "full") return;
  await context.route("**/*", (route) => {
    const method = route.request().method();
    if (shouldBlockRequest(method, mode)) {
      console.log(`  [guardrails] blocked ${method} ${route.request().url().slice(0, 120)}`);
      return route.abort("accessdenied");
    }
    return route.continue();
  });
}

const DESTRUCTIVE_CLICK_PATTERNS = [
  /\bdelete\b/i,
  /\bremove\b/i,
  /\bpay\s*now\b/i,
  /\bconfirm\s+(payment|purchase|order)\b/i,
  /\bcomplete\s+(payment|purchase|order)\b/i,
  /\bplace\s+order\b/i,
  /\bsend\s+(invitation|invite|email|message)\b/i,
  /\bcancel\s+subscription\b/i,
  /\brevoke\b/i,
  /\bpermanently\b/i,
  /\btransfer\s+funds\b/i,
];

export function isDestructiveBrowserAction(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) return false;
  return DESTRUCTIVE_CLICK_PATTERNS.some((pattern) => pattern.test(normalized));
}

async function resolveClickTargetText(page: Page, description: string, ref?: string): Promise<string> {
  const target = await resolveClickLocator(page, { description, ref });
  if (!target) return "";
  try {
    const parts = [
      await target.innerText({ timeout: 500 }).catch(() => ""),
      await target.getAttribute("aria-label").catch(() => ""),
      await target.getAttribute("title").catch(() => ""),
    ].filter(Boolean);
    return parts.join(" ");
  } catch {
    return "";
  }
}

export interface SafeClickGuardResult {
  allowed: boolean;
  message: string;
}

/** safe モードで不可逆なクリックをブロックする */
export async function guardSafeBrowserClick(
  page: Page,
  description: string,
  mode: ShoalMode,
  ref?: string,
): Promise<SafeClickGuardResult> {
  if (mode !== "safe") return { allowed: true, message: "" };

  const targetText = await resolveClickTargetText(page, description, ref);
  const combined = [description, targetText].filter(Boolean).join(" ");
  if (!isDestructiveBrowserAction(combined)) {
    return { allowed: true, message: "" };
  }

  return {
    allowed: false,
    message:
      `[Safety Mode: SAFE] Blocked click on "${description}" — this looks like an irreversible action ` +
      `(delete / pay / send). Observe the UI up to this point, record your findings with post_feedback, ` +
      `and move on without completing the action.`,
  };
}

/** ターゲット設定の appTools に付けられる destructive フラグ付きツール */
export type AppTool = Tool & { destructive?: boolean };

/**
 * モードに応じてツールを絞り込み、LLM API に渡せる形（destructive フラグ除去）にする。
 * - full: 全ツール
 * - safe / read-only: destructive: true のツールを除外
 */
export function filterAppTools(tools: AppTool[], mode: ShoalMode): Tool[] {
  const allowed = mode === "full" ? tools : tools.filter((t) => !t.destructive);
  const excluded = tools.length - allowed.length;
  if (excluded > 0) {
    console.log(`[guardrails] mode=${mode}: ${excluded} destructive tool(s) excluded`);
  }
  return allowed.map(({ destructive: _destructive, ...tool }) => tool as Tool);
}

/** エージェントのシステムプロンプトに追加するガードレール指示 */
export function guardrailPrompt(mode: ShoalMode): string {
  switch (mode) {
    case "read-only":
      return `
[Safety Mode: READ-ONLY]
You must not create, modify, or delete any data. Do not submit forms.
Mutation requests (POST/PUT/PATCH/DELETE) are blocked at the network layer —
if an action fails because of this, that is expected: do NOT report it as a bug.
Instead, note what the flow looked like up to that point and move on to observing another area.`;
    case "safe":
      return `
[Safety Mode: SAFE]
Creating and editing obvious test data is fine, but avoid irreversible or outward-facing actions:
- deleting existing records
- payments, purchases, or subscription changes
- sending emails / messages / invitations that could reach real people
- changing account credentials or permissions
When a flow leads to such an action, stop right before the final confirmation,
record what you observed up to that point, and move on.
Irreversible clicks and DELETE requests are blocked programmatically in this mode.`;
    case "full":
      return "";
  }
}
