import * as fs from "fs";
import { createRequire } from "module";
import type { Page } from "playwright";

/**
 * a11y audit — axe-core を現在のページに注入して WCAG 監査を実行する。
 *
 * アクセシビリティ finding を「エージェントの印象」から「実測の証拠付き」に
 * 格上げするための部品。ブラウザエージェントの run_a11y_audit ツールから使う。
 */

export interface A11yViolation {
  id: string;          // ルール ID（例: "color-contrast"）
  impact: string;      // critical / serious / moderate / minor
  description: string; // 人間向けの説明
  helpUrl: string;
  nodes: string[];     // 影響を受ける要素のセレクタ（最大 5 件）
}

export interface A11yAuditResult {
  url: string;
  violations: A11yViolation[];
  summary: string;
}

let axeSource: string | null = null;

function getAxeSource(): string {
  if (axeSource === null) {
    const require = createRequire(import.meta.url);
    axeSource = fs.readFileSync(require.resolve("axe-core/axe.min.js"), "utf-8");
  }
  return axeSource;
}

const IMPACT_ORDER: Record<string, number> = { critical: 0, serious: 1, moderate: 2, minor: 3 };

interface RawAxeResult {
  violations: {
    id: string;
    impact?: string | null;
    help: string;
    helpUrl: string;
    nodes: { target: unknown[] }[];
  }[];
}

export async function runA11yAudit(page: Page): Promise<A11yAuditResult> {
  await page.addScriptTag({ content: getAxeSource() });

  const raw = await page.evaluate(async () => {
    // @ts-expect-error axe は上で注入済み
    return (await axe.run(document, { resultTypes: ["violations"] })) as unknown;
  }) as RawAxeResult;

  const violations: A11yViolation[] = raw.violations
    .map((v) => ({
      id: v.id,
      impact: v.impact ?? "minor",
      description: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 5).map((n) => n.target.map(String).join(" ")),
    }))
    .sort((a, b) => (IMPACT_ORDER[a.impact] ?? 9) - (IMPACT_ORDER[b.impact] ?? 9));

  const byImpact: Record<string, number> = {};
  for (const v of violations) byImpact[v.impact] = (byImpact[v.impact] ?? 0) + 1;

  const summary = violations.length === 0
    ? "No WCAG violations detected by axe-core on this page."
    : `${violations.length} WCAG violation type(s) on this page (${Object.entries(byImpact).map(([k, n]) => `${k}: ${n}`).join(", ")}).`;

  return { url: page.url(), violations, summary };
}

/** ツール結果として LLM に返すテキスト（長すぎる結果は上位に絞る） */
export function formatAuditForAgent(result: A11yAuditResult, maxViolations = 8): string {
  if (result.violations.length === 0) return result.summary;
  const shown = result.violations.slice(0, maxViolations);
  const lines = [
    result.summary,
    "Cite specific rules and elements as evidence when you report findings:",
    ...shown.map((v) => `- [${v.impact}] ${v.id}: ${v.description} (elements: ${v.nodes.join(", ") || "n/a"})`),
  ];
  if (result.violations.length > maxViolations) {
    lines.push(`…and ${result.violations.length - maxViolations} more violation type(s).`);
  }
  return lines.join("\n");
}
