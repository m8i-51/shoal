/**
 * run.ts — Multi-agent runner
 * hr → product discovery → api agents + browser agents → triage
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx GITHUB_TOKEN=xxx GITHUB_REPO=owner/repo npx tsx run.ts
 */

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { createLLMClient } from "./framework/llm-client";
import type { Tool } from "./framework/llm-client";
import { createMessageWithRetry, runAgentLoop, sleep, rateLimitRetries } from "./framework/agent-loop";
import { collectedFindings, initRunLog, saveRunLog, saveFinding, runLog } from "./framework/findings";
import { loadAgents, addAgent, retireAgent } from "./framework/agent-store";
import { postGitHubIssue, fetchClosedIssues } from "./framework/github";
import {
  setupObservation,
  getRecentConsoleLogs,
  getRecentNetworkErrors,
  buildObservationWarning,
  readPageText,
  readAccessibilityTree,
  saveSnapshotBeforeAction,
  getDiffFromSnapshot,
  type ObservationState,
} from "./framework/observation";
import { discoverProduct, loadCachedSpec, type ProductSpec } from "./framework/product-discovery";
import { designOrg, UNIVERSAL_LENSES } from "./framework/org-designer";
import { runTriageAgent } from "./framework/triage";
import type { AgentLog, Finding, RegressionCheck } from "./framework/types";
import { loadTarget } from "./targets";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? "";
const GITHUB_REPO = process.env.GITHUB_REPO ?? "";
const githubOptions = { token: GITHUB_TOKEN, repo: GITHUB_REPO };

const TARGET = process.env.TARGET ?? "none";
const targetConfig = loadTarget(TARGET);

// skip exploration when no API tools are configured
const MAX_EXPLORERS = targetConfig.appTools.length > 0
  ? parseInt(process.env.MAX_EXPLORERS ?? "4", 10)
  : 0;
const MAX_BROWSERS = parseInt(process.env.MAX_BROWSERS ?? "2", 10);

const { client, defaultModel } = createLLMClient();

// ================================================================
// Screenshots
// ================================================================

let screenshotDir: string;

function initDirs(): string {
  const runId = `run_${Date.now()}`;
  screenshotDir = path.join(process.cwd(), "logs", "screenshots", runId);
  fs.mkdirSync(screenshotDir, { recursive: true });
  return runId;
}

async function takeScreenshot(page: Page, label: string): Promise<{ base64: string; filePath: string }> {
  const fileName = `${Date.now()}_${label.replace(/[^a-zA-Z0-9]/g, "_")}.png`;
  const filePath = path.join(screenshotDir, fileName);
  const buffer = await page.screenshot({ type: "png", fullPage: false });
  fs.writeFileSync(filePath, buffer);
  return { base64: buffer.toString("base64"), filePath };
}

// ================================================================
// API agent tools
// ================================================================

const VALID_CATEGORIES = ["ux", "feature-request", "bug"];

const POST_FEEDBACK_TOOL: Tool = {
  name: "post_feedback",
  description: "Record a finding about the app — usability issues, feature requests, or bug-like behavior. / アプリへのフィードバックを記録する",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: { type: "string" },
      category: { type: "string", enum: ["ux", "feature-request", "bug"] },
    },
    required: ["title", "body", "category"],
  },
};

const REPORT_REGRESSION_TOOL: Tool = {
  name: "report_regression",
  description: "Report a regression when a previously fixed bug has reappeared as a GitHub Issue. / 修正済みバグの再発をGitHub Issueとして報告する",
  input_schema: {
    type: "object",
    properties: {
      original_issue_number: { type: "number" },
      original_issue_title: { type: "string" },
      title: { type: "string" },
      body: { type: "string" },
    },
    required: ["original_issue_number", "original_issue_title", "title", "body"],
  },
};

const MARK_VERIFIED_TOOL: Tool = {
  name: "mark_verified",
  description: "Record that a closed Issue has been verified as still fixed. / 修正済みIssueが問題なく修正されていることを確認した場合に呼ぶ",
  input_schema: {
    type: "object",
    properties: {
      original_issue_number: { type: "number" },
      original_issue_title: { type: "string" },
      note: { type: "string" },
    },
    required: ["original_issue_number", "original_issue_title", "note"],
  },
};

const EXPLORER_TOOLS: Tool[] = [...targetConfig.appTools, POST_FEEDBACK_TOOL];
const REGRESSION_TOOLS: Tool[] = [...targetConfig.appTools, REPORT_REGRESSION_TOOL, MARK_VERIFIED_TOOL];

function makeExecutor(agentLog: AgentLog) {
  return async (toolName: string, input: Record<string, unknown>): Promise<string> => {
    const startedAt = Date.now();
    let result: unknown;
    try {
      switch (toolName) {
        case "post_feedback": {
          const { title, body, category } = input as { title: string; body: string; category: string };
          const safeCategory = VALID_CATEGORIES.includes(String(category)) ? String(category) : "ux";
          const finding: Finding = {
            id: `${agentLog.agentId}_${Date.now()}`,
            runId: runLog.runId,
            agentId: agentLog.agentId,
            agentName: agentLog.agentName,
            role: agentLog.role,
            title: String(title),
            body: String(body),
            category: safeCategory,
            timestamp: new Date().toISOString(),
          };
          saveFinding(finding);
          agentLog.issuesPosted.push({ title: String(title), category: safeCategory, url: null });
          console.log(`  → [findings] saved: "${title}" (${safeCategory})`);
          result = { saved: true, findingId: finding.id };
          break;
        }
        case "report_regression": {
          const { original_issue_number, original_issue_title, title, body } = input as {
            original_issue_number: number; original_issue_title: string; title: string; body: string;
          };
          const url = await postGitHubIssue(
            `[regression] ${title}`,
            `**Regression:** #${original_issue_number} "${original_issue_title}" has reappeared.\n\n${body}\n\n---\n*This Issue was auto-generated by an AI regression agent*`,
            ["regression", "feedback-agent"],
            githubOptions
          );
          const check: RegressionCheck = {
            issueNumber: Number(original_issue_number),
            issueTitle: String(original_issue_title),
            status: "regressed",
            note: String(body),
            regressionUrl: url,
          };
          agentLog.regressionChecks.push(check);
          runLog.summary.regressionChecked++;
          runLog.summary.regressionFailed++;
          result = { reported: true, url };
          break;
        }
        case "mark_verified": {
          const { original_issue_number, original_issue_title, note } = input as {
            original_issue_number: number; original_issue_title: string; note: string;
          };
          agentLog.regressionChecks.push({
            issueNumber: Number(original_issue_number),
            issueTitle: String(original_issue_title),
            status: "fixed",
            note: String(note),
            regressionUrl: null,
          });
          runLog.summary.regressionChecked++;
          console.log(`  ✓ verified: #${original_issue_number} "${original_issue_title}"`);
          result = { verified: true };
          break;
        }
        default:
          result = await targetConfig.execute(toolName, input, agentLog.agentId);
      }
    } catch (e) {
      result = { error: String(e) };
    }
    agentLog.actions.push({
      timestamp: new Date().toISOString(),
      tool: toolName,
      input,
      result,
      durationMs: Date.now() - startedAt,
    });
    runLog.summary.totalActions++;
    return JSON.stringify(result);
  };
}

// ================================================================
// API agents (exploration / regression)
// ================================================================

async function runExplorer(
  agent: { id: string; name: string; persona: string; role: string },
  productSpec: ProductSpec,
  lens?: string
) {
  console.log(`\n[explorer] ${agent.name} start${lens ? ` [lens: ${lens.slice(0, 30)}...]` : ""}`);
  const agentLog: AgentLog = {
    agentType: "explorer",
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "completed",
    iterations: 0,
    actions: [],
    issuesPosted: [],
    regressionChecks: [],
    error: null,
  };
  runLog.agents.push(agentLog);

  const systemPrompt = `You are "${agent.name}".
Role: ${agent.role}
Persona: ${agent.persona}

You are an employee using "${productSpec.appName}".
Use the tools to interact with the app.

${productSpec.appDescription}

If you notice anything inconvenient, a missing feature, or bug-like behavior,
report it with the post_feedback tool.

[Implemented Features]
${productSpec.features}
${lens ? `\n[Focus Area for This Run]\n${lens}\nKeep this perspective in mind and prioritize reporting related issues.\n` : ""}
Take 3–5 actions, then finish.`;

  await runAgentLoop(agentLog, systemPrompt, EXPLORER_TOOLS, client, defaultModel, makeExecutor(agentLog));
  console.log(`[explorer] ${agent.name} done`);
}

async function runRegressionAgent(
  agent: { id: string; name: string; persona: string; role: string },
  closedIssues: { number: number; title: string; body: string; labels: string[] }[],
  productSpec: ProductSpec
) {
  console.log(`\n[regression] ${agent.name} start (${closedIssues.length} issues to check)`);
  const agentLog: AgentLog = {
    agentType: "regression",
    agentId: agent.id,
    agentName: agent.name,
    role: agent.role,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "completed",
    iterations: 0,
    actions: [],
    issuesPosted: [],
    regressionChecks: [],
    error: null,
  };
  runLog.agents.push(agentLog);

  const issueList = closedIssues
    .map((i) => `- Issue #${i.number}: ${i.title}\n  ${i.body.slice(0, 200).replace(/\n/g, " ")}`)
    .join("\n");

  const systemPrompt = `You are "${agent.name}". Act as a QA engineer.

The following Issues have been closed as fixed. Verify they are actually fixed.

[Issues to Verify]
${issueList}

[Steps]
1. Read each Issue and perform actions that could reproduce it
2. If the problem reoccurs, report it with report_regression
3. If the problem is gone, record it with mark_verified
4. Finish after checking all items

[Reference: Implemented Features]
${productSpec.features}`;

  await runAgentLoop(agentLog, systemPrompt, REGRESSION_TOOLS, client, defaultModel, makeExecutor(agentLog));
  const checked = agentLog.regressionChecks.length;
  const failed = agentLog.regressionChecks.filter((c) => c.status === "regressed").length;
  console.log(`[regression] ${agent.name} done (checked: ${checked} / regressed: ${failed})`);
}

// ================================================================
// HR agent
// ================================================================

const HR_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_agents",
    description: "Get the current list of registered agents. / 現在登録されているエージェント一覧を取得する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "add_agent",
    description: "Register a new agent (user persona). / 新しいエージェントを登録する",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        role: { type: "string" },
        persona: { type: "string" },
      },
      required: ["name", "role", "persona"],
    },
  },
  {
    name: "retire_agent",
    description: "Retire an agent (e.g. due to long tenure). / エージェントを退職させる",
    input_schema: {
      type: "object",
      properties: {
        agentId: { type: "string" },
        reason: { type: "string" },
      },
      required: ["agentId", "reason"],
    },
  },
];

async function runHRAgent(productSpec: ProductSpec, orgGuidance: string): Promise<void> {
  console.log("\n[hr] starting...");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "Manage agent hiring and retirement." },
  ];
  const systemPrompt = `You are the test agent manager for "${productSpec.appName}".
You recruit and manage agents that simulate real users of the app.

[Organization Design Guidelines]
${orgGuidance}

[Steps]
1. Call get_agents to check the current agent roster
2. Based on the guidelines, add 2–3 agents with add_agent for underrepresented user types
3. If there are agents with old createdAt dates (oldest 1–2), retire them with retire_agent`;

  try {
    let iterations = 0;
    while (iterations < 8) {
      iterations++;
      const response = await createMessageWithRetry(client, {
        model: defaultModel,
        max_tokens: 1024,
        system: systemPrompt,
        tools: HR_TOOLS,
        messages,
      });
      messages.push({ role: "assistant", content: response.content });
      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );
      if (toolUses.length === 0 || response.stop_reason === "end_turn") break;
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        let result: unknown;
        if (toolUse.name === "get_agents") {
          const agents = loadAgents();
          result = agents.map((a) => ({ id: a.id, name: a.name, role: a.role, createdAt: a.createdAt }));
          console.log(`  [hr] current agents: ${agents.length}`);
        } else if (toolUse.name === "add_agent") {
          const { name, role, persona } = toolUse.input as { name: string; role: string; persona: string };
          result = addAgent({ name, role, persona });
          console.log(`  [hr] hired: ${name} (${role})`);
        } else if (toolUse.name === "retire_agent") {
          const { agentId, reason } = toolUse.input as { agentId: string; reason: string };
          result = { success: retireAgent(agentId) };
          console.log(`  [hr] retired: ${agentId} — ${reason}`);
        } else {
          result = { error: "unknown tool" };
        }
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
    }
    console.log("[hr] done");
  } catch (e) {
    console.error("[hr] error:", e);
  }
}

// ================================================================
// Browser agent tools
// ================================================================

interface BrowserAction {
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
  screenshotPath: string | null;
  durationMs: number;
}

interface BrowserAgentLog {
  agentName: string;
  persona: string;
  startedAt: string;
  completedAt: string | null;
  status: "completed" | "error" | "iteration_limit";
  iterations: number;
  actions: BrowserAction[];
  feedbacksSaved: { title: string; category: string; findingId: string }[];
  error: string | null;
}

const TOOLS_THAT_SEND_SCREENSHOT = new Set(["navigate", "post_feedback", "view_screen"]);

const BROWSER_TOOLS: Anthropic.Tool[] = [
  ...(MAX_EXPLORERS > 0 ? targetConfig.appTools.map((t) => ({ ...t, description: `[API check] ${t.description}` })) : []),
  {
    name: "view_screen",
    description: "Capture the current screen. / 現在の画面を確認する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "navigate",
    description: "Navigate to a path. / 指定したパスに移動する",
    input_schema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "click",
    description: "Click a button, link, or tab on screen. / 画面上の要素をクリックする",
    input_schema: {
      type: "object",
      properties: { description: { type: "string" } },
      required: ["description"],
    },
  },
  {
    name: "fill",
    description: "Type text into an input field. / 入力フィールドにテキストを入力する",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string" },
        value: { type: "string" },
      },
      required: ["label", "value"],
    },
  },
  {
    name: "select",
    description: "Select an option from a dropdown. / ドロップダウンで選択する",
    input_schema: {
      type: "object",
      properties: {
        label: { type: "string" },
        value: { type: "string" },
      },
      required: ["label", "value"],
    },
  },
  {
    name: "diff_since_last_action",
    description: "Check what changed on the page since the last action. / 直前のアクションでページに何が変わったかを確認する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_page_text",
    description: "Get all visible text on the page. / ページ上の表示テキストをすべて取得する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_accessibility_tree",
    description: "Get the page's accessibility tree. / ページのアクセシビリティツリーを取得する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_console_logs",
    description: "Check browser console logs (errors and warnings). / ブラウザのコンソールログを確認する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_network_errors",
    description: "Check failed API requests. / 失敗したAPIリクエストの一覧を確認する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "post_feedback",
    description: "Record an issue or improvement as feedback. Becomes a GitHub Issue after triage. / 問題・改善点をフィードバックとして記録する",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        body: { type: "string" },
        category: { type: "string", enum: ["ux", "feature-request", "bug"] },
      },
      required: ["title", "body", "category"],
    },
  },
];

async function executeBrowserTool(
  toolName: string,
  input: Record<string, unknown>,
  page: Page,
  agentLog: BrowserAgentLog,
  observation: ObservationState,
  agentId: string
): Promise<{ text: string; screenshot: { base64: string; filePath: string } | null; sendToClaude: boolean }> {
  const startedAt = Date.now();
  let resultText = "";
  let screenshot: { base64: string; filePath: string } | null = null;
  let isError = false;

  try {
    switch (toolName) {
      case "view_screen": {
        screenshot = await takeScreenshot(page, "view_screen");
        resultText = "Current screen.";
        break;
      }
      case "navigate": {
        const { path: navPath } = input as { path: string };
        await saveSnapshotBeforeAction(page, observation);
        await page.goto(`${BASE_URL}${navPath}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(500);
        screenshot = await takeScreenshot(page, `navigate_${navPath.replace(/\//g, "_")}`);
        resultText = `Navigated to ${navPath}`;
        break;
      }
      case "click": {
        const { description } = input as { description: string };
        await saveSnapshotBeforeAction(page, observation);
        const escapedDesc = description.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const buttonLocator = page.getByRole("button", { name: new RegExp(escapedDesc, "i") });
        const linkLocator = page.getByRole("link", { name: new RegExp(escapedDesc, "i") });
        const textLocator = page.getByText(description, { exact: false });
        let clicked = false;
        for (const loc of [buttonLocator, linkLocator, textLocator]) {
          try {
            await loc.first().click({ timeout: 5000 });
            clicked = true;
            break;
          } catch { /* try next */ }
        }
        if (!clicked) throw new Error(`No element matching: ${description}`);
        await page.waitForTimeout(500);
        screenshot = await takeScreenshot(page, `click_${description.slice(0, 20)}`);
        resultText = `Clicked: ${description}`;
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
        for (const el of [byContainer, byPlaceholder, byAriaLabel]) {
          try {
            await el.fill(value, { timeout: 5000 });
            filled = true;
            break;
          } catch { /* try next */ }
        }
        if (!filled) throw new Error(`No input field matching: ${label}`);
        await page.waitForTimeout(300);
        screenshot = await takeScreenshot(page, `fill_${label.slice(0, 20)}`);
        resultText = `Filled "${label}" with "${value}"`;
        break;
      }
      case "select": {
        const { label, value } = input as { label: string; value: string };
        await saveSnapshotBeforeAction(page, observation);
        const byAriaLabel = page.getByLabel(label, { exact: false });
        const byContainer = page
          .locator("div")
          .filter({ has: page.locator("label", { hasText: label }) })
          .locator("select")
          .first();
        let selected = false;
        for (const el of [byAriaLabel, byContainer]) {
          try {
            await el.selectOption({ label: value }, { timeout: 5000 });
            selected = true;
            break;
          } catch { /* try next */ }
        }
        if (!selected) throw new Error(`Could not select "${value}" in "${label}"`);
        await page.waitForTimeout(300);
        screenshot = await takeScreenshot(page, `select_${label.slice(0, 20)}`);
        resultText = `Selected "${value}" in "${label}"`;
        break;
      }
      case "diff_since_last_action": {
        resultText = await getDiffFromSnapshot(page, observation);
        break;
      }
      case "read_page_text": {
        resultText = await readPageText(page);
        break;
      }
      case "read_accessibility_tree": {
        resultText = await readAccessibilityTree(page);
        break;
      }
      case "read_console_logs": {
        const logs = getRecentConsoleLogs(observation);
        resultText = logs.length > 0 ? JSON.stringify(logs) : "(no console logs)";
        break;
      }
      case "read_network_errors": {
        const errors = getRecentNetworkErrors(observation);
        resultText = errors.length > 0 ? JSON.stringify(errors) : "(no network errors)";
        break;
      }
      case "post_feedback": {
        const { title, body, category } = input as { title: string; body: string; category: string };
        const safeCategory = VALID_CATEGORIES.includes(String(category)) ? String(category) : "ux";
        screenshot = await takeScreenshot(page, `feedback_${String(title).slice(0, 20)}`);
        const finding: Finding = {
          id: `${agentId}_${Date.now()}`,
          runId: runLog.runId,
          agentId,
          agentName: agentLog.agentName,
          role: agentLog.persona,
          title: String(title),
          body: String(body),
          category: safeCategory,
          timestamp: new Date().toISOString(),
          screenshotPath: screenshot.filePath,
        };
        saveFinding(finding);
        agentLog.feedbacksSaved.push({ title: String(title), category: safeCategory, findingId: finding.id });
        console.log(`  → [findings] saved: "${title}" (${safeCategory})`);
        resultText = `Feedback recorded: "${title}" (will become an Issue after triage)`;
        break;
      }
      default: {
        const apiResult = await targetConfig.execute(toolName, input, agentId);
        resultText = JSON.stringify(apiResult);
        break;
      }
    }
  } catch (e) {
    isError = true;
    resultText = `error: ${String(e)}`;
    try {
      screenshot = await takeScreenshot(page, `error_${toolName}`);
    } catch { /* ignore */ }
  }

  agentLog.actions.push({
    timestamp: new Date().toISOString(),
    tool: toolName,
    input,
    screenshotPath: screenshot?.filePath ?? null,
    durationMs: Date.now() - startedAt,
  });

  const sendToClaude = isError || TOOLS_THAT_SEND_SCREENSHOT.has(toolName);
  return { text: resultText, screenshot, sendToClaude };
}

async function runBrowserAgent(
  agent: { id: string; name: string; persona: string; role: string },
  page: Page,
  productSpec: ProductSpec,
  lens?: string
): Promise<BrowserAgentLog> {
  console.log(`\n[browser] ${agent.name} start${lens ? ` [lens: ${lens.slice(0, 30)}...]` : ""}`);

  const agentLog: BrowserAgentLog = {
    agentName: agent.name,
    persona: agent.persona,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "completed",
    iterations: 0,
    actions: [],
    feedbacksSaved: [],
    error: null,
  };

  const observation = setupObservation(page);

  const systemPrompt = `You are "${agent.name}".
Role: ${agent.role}
Persona: ${agent.persona}

You are a real user of "${productSpec.appName}".
Use the browser tools to navigate the app and carry out everyday tasks.

[App Overview]
${productSpec.appDescription}

[How to Proceed]
1. Navigate to a page with navigate
2. Perform actual tasks on that page
3. If you find any issues, record them with post_feedback (they become Issues after triage)
4. Move to another page and repeat
5. Finish after 8–10 actions

[Using Observation Tools]
- To verify an action was actually applied, call diff_since_last_action
- If data isn't reflected or errors appear, call read_network_errors
- For unexpected behavior, call read_console_logs to check JS errors
- If problems are found, record them with post_feedback

[Using API Check Tools (tools prefixed with [API check])]
- After a browser action, verify the actual saved state via API
- Data visible in the browser but missing in the API (or vice versa) is an inconsistency bug — report with post_feedback

[Using view_screen]
- Call it once right after navigate
- Do not call it repeatedly on the same page

[Reference: Implemented Features]
${productSpec.features}
${lens ? `\n[Focus Area for This Run]\n${lens}\nKeep this perspective in mind and prioritize reporting related issues.` : ""}`;

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(1000);
  const initialScreenshot = await takeScreenshot(page, "initial");

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: initialScreenshot.base64 } },
        { type: "text", text: "The app is open. Start using it." },
      ],
    },
  ];

  try {
    while (agentLog.iterations < 12) {
      agentLog.iterations++;

      const response = await createMessageWithRetry(client, {
        model: defaultModel,
        max_tokens: 1024,
        system: systemPrompt,
        tools: BROWSER_TOOLS,
        messages,
      });

      const assistantContent = response.content;
      messages.push({ role: "assistant", content: assistantContent });

      const toolUses = assistantContent.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
      );

      if (toolUses.length === 0 || response.stop_reason === "end_turn") {
        agentLog.status = "completed";
        break;
      }

      if (agentLog.iterations >= 12) agentLog.status = "iteration_limit";

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUses) {
        console.log(`  → ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 60)})`);

        const { text, screenshot, sendToClaude } = await executeBrowserTool(
          toolUse.name,
          toolUse.input as Record<string, unknown>,
          page,
          agentLog,
          observation,
          agent.id
        );

        const content: Anthropic.ToolResultBlockParam["content"] =
          sendToClaude && screenshot
            ? [
                { type: "text", text },
                { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot.base64 } },
              ]
            : text;

        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content });
      }

      const MAX_ITERATIONS = 12;
      const remaining = MAX_ITERATIONS - agentLog.iterations;
      let budgetHint = `[${remaining} turns remaining]`;
      if (remaining <= 2) {
        budgetHint += " Last turns. Post any remaining findings with post_feedback, then finish.";
      } else if (remaining <= 4) {
        budgetHint += " Start wrapping up.";
      }

      const PROGRESS_TOOLS = new Set(["navigate", "fill", "post_feedback"]);
      const recent = agentLog.actions.slice(-5).map((a) => a.tool);
      if (recent.length >= 5 && !recent.some((t) => PROGRESS_TOOLS.has(t))) {
        budgetHint += " You seem stuck on the same page. Navigate to a different page.";
      }

      const observationWarning = buildObservationWarning(observation);
      if (observationWarning) {
        budgetHint += `\n\n${observationWarning}\nUse read_console_logs or read_network_errors for details.`;
      }

      const last = toolResults[toolResults.length - 1];
      const lastContent = last.content;
      toolResults[toolResults.length - 1] = {
        ...last,
        content:
          typeof lastContent === "string"
            ? `${lastContent}\n\n${budgetHint}`
            : ([...(lastContent as unknown[]), { type: "text" as const, text: budgetHint }] as Anthropic.ToolResultBlockParam["content"]),
      };

      messages.push({ role: "user", content: toolResults });
    }
  } catch (e) {
    agentLog.status = "error";
    agentLog.error = String(e);
    console.error(`[${agent.name}] error:`, e);
  } finally {
    agentLog.completedAt = new Date().toISOString();
  }

  console.log(`[browser] ${agent.name} done (feedback: ${agentLog.feedbacksSaved.length})`);
  return agentLog;
}

// ================================================================
// Main
// ================================================================

function pickAgents<T>(agents: T[], count: number): T[] {
  return [...agents].sort(() => Math.random() - 0.5).slice(0, count);
}

async function main() {
  initDirs();

  // 1. product discovery (cache or live)
  const browser = await chromium.launch({ headless: true });
  let productSpec: ProductSpec;
  try {
    const cached = loadCachedSpec(BASE_URL);
    if (cached) {
      console.log(`\n[product-discovery] using cache (date: ${cached.discoveredAt?.slice(0, 10) ?? "unknown"}, confidence: ${cached.confidence})`);
      productSpec = cached;
    } else {
      const discoveryContext = await browser.newContext({ viewport: { width: 1024, height: 640 } });
      const discoveryPage = await discoveryContext.newPage();
      productSpec = await discoverProduct(BASE_URL, discoveryPage, client, defaultModel);
      await discoveryContext.close();
    }

    // 2. org design
    const orgDesign = await designOrg(productSpec, client, defaultModel);

    // 3. HR agent
    await runHRAgent(productSpec, orgDesign.hrGuidance);

    // 4. load agents + closed issues
    const allAgents = loadAgents();
    if (allAgents.length === 0) {
      console.error("No agents found. Check agents.json.");
      process.exit(1);
    }
    const closedIssues = await fetchClosedIssues(githubOptions);

    // 5. init run log
    initRunLog(allAgents.length, GITHUB_REPO);

    // 6. API agents (exploration + regression)
    const allExplorers = allAgents.slice(0, -1);
    const explorerAgents = pickAgents(allExplorers, Math.min(MAX_EXPLORERS, allExplorers.length));
    const regressionAgent = allAgents[allAgents.length - 1];
    console.log(`\nexplorers: ${explorerAgents.length} (max: ${MAX_EXPLORERS}) / regression: 1`);

    const CONCURRENCY = 2;
    for (let i = 0; i < explorerAgents.length; i += CONCURRENCY) {
      const batch = explorerAgents.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((agent, j) => {
        const lens = UNIVERSAL_LENSES[(i + j) % UNIVERSAL_LENSES.length];
        return runExplorer(agent, productSpec, lens);
      }));
      if (i + CONCURRENCY < explorerAgents.length) {
        console.log("\n[batch done] waiting 5s before next batch...");
        await sleep(5000);
      }
    }

    if (MAX_EXPLORERS === 0) {
      console.log("\n[regression] skipped (MAX_EXPLORERS=0)");
    } else if (closedIssues.length > 0) {
      await sleep(3000);
      await runRegressionAgent(regressionAgent, closedIssues, productSpec);
    } else {
      console.log("\n[regression] no closed issues — running as explorer");
      await runExplorer(regressionAgent, productSpec, UNIVERSAL_LENSES[explorerAgents.length % UNIVERSAL_LENSES.length]);
    }

    // 7. browser agents
    const browserAgents = pickAgents(allAgents, Math.min(MAX_BROWSERS, allAgents.length));
    console.log(`\nlaunching ${browserAgents.length} browser agents in parallel (max: ${MAX_BROWSERS})`);
    browserAgents.forEach((a) => console.log(`  - ${a.name} (${a.role})`));

    await sleep(2000);
    await Promise.all(
      browserAgents.map(async (agent, i) => {
        const lens = UNIVERSAL_LENSES[(explorerAgents.length + i) % UNIVERSAL_LENSES.length];
        const context = await browser.newContext({ viewport: { width: 1024, height: 640 } });
        const page = await context.newPage();
        try {
          return await runBrowserAgent(agent, page, productSpec, lens);
        } finally {
          await context.close();
        }
      })
    );

    // 8. triage (API + browser findings)
    await sleep(2000);
    console.log(`\n[triage] collected findings: ${collectedFindings.length}`);
    try {
      const triageResult = await runTriageAgent(collectedFindings, client, defaultModel, githubOptions);
      runLog.summary.totalIssuesPosted += triageResult.issuesCreated;
    } catch (e) {
      console.error("[triage] error:", e);
    }

  } finally {
    await browser.close();
  }

  // 9. done
  runLog.completedAt = new Date().toISOString();
  runLog.summary.rateLimitRetries = rateLimitRetries;
  saveRunLog();

  console.log("\nAll agents done.");
  console.log(`  findings collected: ${collectedFindings.length}`);
  console.log(`  GitHub issues created: ${runLog.summary.totalIssuesPosted}`);
  console.log(`  regression checks: ${runLog.summary.regressionChecked} (regressed: ${runLog.summary.regressionFailed})`);
  console.log(`  screenshots: ${screenshotDir}`);
}

main().catch(console.error);
