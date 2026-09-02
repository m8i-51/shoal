/**
 * browser-tools.ts — the tool layer a browser agent drives the page through.
 *
 * Extracted from run.ts so the switch that actually touches the target app is
 * testable in isolation: everything it needs arrives in `BrowserToolContext`
 * (page, timings, trackers, screenshot fn, app-tool executor), rather than
 * being read from module-level state in the runner.
 *
 * Two invariants live here:
 * - every result derived from the target app goes through `wrapUntrusted`, so
 *   the agent can tell page content from its own instructions (see untrusted.ts)
 * - password values never reach the log or the LLM in the clear (see redact.ts)
 */
import type { Page } from "playwright";
import type { ShoalMode } from "./guardrails";
import { guardSafeBrowserClick } from "./guardrails";
import { clickDescribedElement, clickToolHasTarget } from "./click-target";
import { selectDescribedOption } from "./select-target";
import { hashContent } from "./page-cache";
import { runA11yAudit, formatAuditForAgent } from "./a11y-audit";
import { saveFindingTraceChunk, traceAgentZipPath } from "./trace-chunk";
import { resolveIssueId, type IssueIdentifier } from "./issue-id";
import { saveFinding, getSwarmSignals, runLog } from "./findings";
import { redactFillResultText, redactToolInput, isPasswordLabel, REDACTED_SECRET } from "./redact";
import { wrapUntrusted } from "./untrusted";
import {
  getRecentConsoleLogs,
  getRecentNetworkErrors,
  readPageText,
  readAccessibilityTree,
  saveSnapshotBeforeAction,
  getDiffFromSnapshot,
  type ObservationState,
} from "./observation";
import type { Scenario, ScenarioOutcome } from "./scenario-designer";
import type { ClosedIssue } from "./trackers/types";
import type { Finding, RegressionCheck } from "./types";
import type { RunTimings } from "./run-config";

export const VALID_CATEGORIES = ["ux", "feature-request", "bug", "goal-gap"];

/** Tools whose result is worth sending back with a fresh screenshot. */
export const TOOLS_THAT_SEND_SCREENSHOT = new Set(["navigate", "post_feedback", "view_screen"]);

export interface BrowserAction {
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
  screenshotPath: string | null;
  durationMs: number;
}

export interface BrowserAgentLog {
  agentName: string;
  persona: string;
  startedAt: string;
  completedAt: string | null;
  status: "completed" | "error" | "iteration_limit";
  iterations: number;
  actions: BrowserAction[];
  visitedPaths: string[];
  feedbacksSaved: { title: string; category: string; findingId: string }[];
  regressionChecks: RegressionCheck[];
  error: string | null;
}

export interface Screenshot {
  base64: string;
  filePath: string;
}

/** Only the tracker calls this layer makes — narrower than the full tracker set. */
export interface BrowserToolTrackers {
  createIssue: (title: string, body: string, labels: string[]) => Promise<string | null>;
  commentOnIssue: (issueId: IssueIdentifier, body: string) => Promise<unknown>;
}

export interface BrowserToolContext {
  page: Page;
  agentId: string;
  agentLog: BrowserAgentLog;
  observation: ObservationState;
  scenarioOutcomes: ScenarioOutcome[];
  /** Page-content hashes from previous runs, keyed by path. */
  cachedHashes: Record<string, string>;
  /** Hashes observed in this run; written back by the caller. */
  pageHashUpdates: Record<string, string>;
  scenario?: Scenario;
  closedIssues: ClosedIssue[];
  baseUrl: string;
  mode: ShoalMode;
  traceEnabled: boolean;
  runId: string;
  timings: RunTimings;
  takeScreenshot: (page: Page, label: string) => Promise<Screenshot>;
  /** Target-config API tool executor, used for any tool this switch does not own. */
  executeAppTool: (toolName: string, input: Record<string, unknown>, agentId: string) => Promise<unknown>;
  trackers: BrowserToolTrackers;
}

export interface BrowserToolResult {
  text: string;
  screenshot: Screenshot | null;
  sendToClaude: boolean;
}

export async function executeBrowserTool(
  toolName: string,
  input: Record<string, unknown>,
  ctx: BrowserToolContext,
): Promise<BrowserToolResult> {
  const { page, agentId, agentLog, observation, timings } = ctx;
  const startedAt = Date.now();
  let resultText: string;
  let screenshot: Screenshot | null = null;
  let isError = false;

  try {
    switch (toolName) {
      case "view_screen": {
        screenshot = await ctx.takeScreenshot(page, "view_screen");
        resultText = "Current screen.";
        break;
      }
      case "navigate": {
        const { path: navPath } = input as { path: string };
        await saveSnapshotBeforeAction(page, observation);
        await page.goto(`${ctx.baseUrl}${navPath}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(timings.afterNavigateMs);
        screenshot = await ctx.takeScreenshot(page, `navigate_${navPath.replace(/\//g, "_")}`);
        agentLog.visitedPaths.push(navPath);
        // ページコンテンツハッシュで差分検出
        try {
          const content = await page.innerText("body", { timeout: 2000 });
          const h = hashContent(content);
          const unchanged = ctx.cachedHashes[navPath] && ctx.cachedHashes[navPath] === h;
          ctx.pageHashUpdates[navPath] = h;
          resultText = unchanged
            ? `Navigated to ${navPath} (page content unchanged since last run — consider exploring a different area)`
            : `Navigated to ${navPath}`;
        } catch {
          resultText = `Navigated to ${navPath}`;
        }
        break;
      }
      case "click": {
        const { description, ref } = input as { description?: string; ref?: string };
        if (!clickToolHasTarget({ description, ref })) {
          resultText = "click: missing description or ref";
          break;
        }
        const guard = await guardSafeBrowserClick(page, description ?? "", ctx.mode, ref);
        if (!guard.allowed) {
          console.log(`  [guardrails] blocked click: ${description ?? ref}`);
          screenshot = await ctx.takeScreenshot(page, `blocked_click_${String(description ?? ref).slice(0, 20)}`);
          resultText = guard.message;
          break;
        }
        await saveSnapshotBeforeAction(page, observation);
        await clickDescribedElement(page, { description, ref });
        await page.waitForTimeout(timings.afterClickMs);
        screenshot = await ctx.takeScreenshot(page, `click_${String(description ?? ref).slice(0, 20)}`);
        resultText = `Clicked: ${description ?? ref}`;
        break;
      }
      case "fill": {
        const { label, value } = input as { label: string; value: string };
        await saveSnapshotBeforeAction(page, observation);
        const byContainer = page
          .locator("div")
          .filter({ has: page.locator("label", { hasText: label }) })
          .locator("input, textarea")
          .first();
        const byPlaceholder = page.getByPlaceholder(label, { exact: false });
        const byAriaLabel = page.getByLabel(label, { exact: false });
        let filled = false;
        let passwordField = isPasswordLabel(label);
        for (const el of [byContainer, byPlaceholder, byAriaLabel]) {
          try {
            await el.fill(value, { timeout: 5000 });
            filled = true;
            const typeAttr = await el.getAttribute("type").catch(() => null);
            if (typeAttr === "password") passwordField = true;
            break;
          } catch { /* try next */ }
        }
        if (!filled) throw new Error(`No input field matching: ${label}`);
        await page.waitForTimeout(timings.afterInputMs);
        screenshot = await ctx.takeScreenshot(page, `fill_${label.slice(0, 20)}`);
        resultText = redactFillResultText(label, value, passwordField);
        if (passwordField) input.value = REDACTED_SECRET;
        break;
      }
      case "select": {
        const { label, value } = input as { label: string; value: string };
        await saveSnapshotBeforeAction(page, observation);
        await selectDescribedOption(page, { label, value });
        await page.waitForTimeout(timings.afterInputMs);
        screenshot = await ctx.takeScreenshot(page, `select_${label.slice(0, 20)}`);
        resultText = `Selected "${value}" in "${label}"`;
        break;
      }
      case "diff_since_last_action": {
        resultText = wrapUntrusted("page diff", await getDiffFromSnapshot(page, observation));
        break;
      }
      case "read_page_text": {
        resultText = wrapUntrusted("page text", await readPageText(page));
        break;
      }
      case "read_accessibility_tree": {
        resultText = wrapUntrusted("accessibility tree", await readAccessibilityTree(page));
        break;
      }
      case "read_console_logs": {
        const logs = getRecentConsoleLogs(observation);
        resultText = logs.length > 0
          ? wrapUntrusted("console logs", JSON.stringify(logs))
          : "(no console logs)";
        break;
      }
      case "read_network_errors": {
        const errors = getRecentNetworkErrors(observation);
        resultText = errors.length > 0
          ? wrapUntrusted("network errors", JSON.stringify(errors))
          : "(no network errors)";
        break;
      }
      case "post_outcome": {
        const { achieved, reason } = input as { achieved: boolean; reason: string };
        if (ctx.scenario) {
          const outcome: ScenarioOutcome = {
            scenarioId: ctx.scenario.id,
            scenarioTitle: ctx.scenario.title,
            agentId,
            agentName: agentLog.agentName,
            achieved: Boolean(achieved),
            reason: String(reason),
            iterations: agentLog.iterations,
          };
          ctx.scenarioOutcomes.push(outcome);
          console.log(`  ${achieved ? "✓" : "✗"} [outcome] "${ctx.scenario.title}": ${achieved ? "achieved" : "NOT achieved"} — ${reason}`);
        }
        resultText = "Outcome recorded.";
        break;
      }
      case "run_a11y_audit": {
        const audit = await runA11yAudit(page);
        // Audit output quotes element markup from the page — untrusted content.
        resultText = wrapUntrusted("a11y audit", formatAuditForAgent(audit));
        console.log(`  [a11y] ${audit.summary}`);
        break;
      }
      case "check_swarm_signals": {
        let currentPath = agentLog.visitedPaths.at(-1) ?? "/";
        try {
          currentPath = new URL(page.url()).pathname || currentPath;
        } catch { /* keep last visited path */ }
        const signals = getSwarmSignals(agentId, 8, currentPath);
        // Signals quote other agents' findings, which quote the app — untrusted.
        resultText = signals.length > 0
          ? `${wrapUntrusted("swarm signals", JSON.stringify({ signals, currentPath }))}\nThese reports are from your current area when possible — try to reproduce them from your own perspective.`
          : `(no reports from other agents in ${currentPath} yet — keep exploring)`;
        break;
      }
      case "post_feedback": {
        const { title, body, category } = input as { title: string; body: string; category: string };
        const safeCategory = VALID_CATEGORIES.includes(String(category)) ? String(category) : "ux";
        screenshot = await ctx.takeScreenshot(page, `feedback_${String(title).slice(0, 20)}`);
        const findingId = `${agentId}_${Date.now()}`;
        let findingTracePath: string | undefined;
        if (ctx.traceEnabled) {
          const chunkPath = await saveFindingTraceChunk(page.context(), ctx.runId, findingId);
          findingTracePath = chunkPath ?? traceAgentZipPath(ctx.runId, agentId);
        }
        const finding: Finding = {
          id: findingId,
          runId: ctx.runId,
          agentId,
          agentName: agentLog.agentName,
          role: agentLog.persona,
          title: String(title),
          body: String(body),
          category: safeCategory,
          timestamp: new Date().toISOString(),
          screenshotPath: screenshot.filePath,
          ...(findingTracePath ? { tracePath: findingTracePath } : {}),
        };
        saveFinding(finding);
        agentLog.feedbacksSaved.push({ title: String(title), category: safeCategory, findingId: finding.id });
        console.log(`  → [findings] saved: "${title}" (${safeCategory})`);
        resultText = `Feedback recorded: "${title}" (will become an Issue after triage)`;
        break;
      }
      case "report_regression": {
        const { original_issue_number, original_issue_title, title, body } = input as {
          original_issue_number: string; original_issue_title: string; title: string; body: string;
        };
        const issueId = resolveIssueId(original_issue_number, ctx.closedIssues);
        const url = await ctx.trackers.createIssue(
          `[regression] ${title}`,
          `**Regression:** ${issueId} "${original_issue_title}" has reappeared.\n\n${body}\n\n---\n*This issue was auto-generated by an AI regression agent*`,
          ["regression", "feedback-agent"],
        );
        await ctx.trackers.commentOnIssue(
          issueId,
          `⚠️ **Regression detected** by AI agent on ${new Date().toISOString().slice(0, 10)}\n\n${body}${url ? `\n\nNew issue: ${url}` : ""}`,
        );
        agentLog.regressionChecks.push({
          issueNumber: issueId,
          issueTitle: String(original_issue_title),
          status: "regressed",
          note: String(body),
          regressionUrl: url,
        });
        runLog.summary.regressionChecked++;
        runLog.summary.regressionFailed++;
        resultText = JSON.stringify({ reported: true, url });
        break;
      }
      case "mark_verified": {
        const { original_issue_number, original_issue_title, note } = input as {
          original_issue_number: string; original_issue_title: string; note: string;
        };
        const issueId = resolveIssueId(original_issue_number, ctx.closedIssues);
        await ctx.trackers.commentOnIssue(
          issueId,
          `✅ **Verified as fixed** by AI agent on ${new Date().toISOString().slice(0, 10)}\n\n${note}`,
        );
        agentLog.regressionChecks.push({
          issueNumber: issueId,
          issueTitle: String(original_issue_title),
          status: "fixed",
          note: String(note),
          regressionUrl: null,
        });
        runLog.summary.regressionChecked++;
        console.log(`  ✓ verified: ${issueId} "${original_issue_title}"`);
        resultText = JSON.stringify({ verified: true });
        break;
      }
      default: {
        const apiResult = await ctx.executeAppTool(toolName, input, agentId);
        resultText = wrapUntrusted(`api:${toolName}`, JSON.stringify(apiResult));
        break;
      }
    }
  } catch (e) {
    isError = true;
    resultText = `error: ${String(e)}`;
    try {
      screenshot = await ctx.takeScreenshot(page, `error_${toolName}`);
    } catch { /* ignore */ }
  }

  agentLog.actions.push({
    timestamp: new Date().toISOString(),
    tool: toolName,
    input: redactToolInput(toolName, input),
    screenshotPath: screenshot?.filePath ?? null,
    durationMs: Date.now() - startedAt,
  });

  const sendToClaude = isError || TOOLS_THAT_SEND_SCREENSHOT.has(toolName);
  return { text: resultText, screenshot, sendToClaude };
}
