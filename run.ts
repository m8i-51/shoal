/**
 * run.ts — Multi-agent runner
 * hr → product discovery → api agents + browser agents → triage
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx GITHUB_TOKEN=xxx GITHUB_REPO=owner/repo npx tsx run.ts
 */

import { config as loadEnv } from "dotenv";
loadEnv({ override: true }); // .env を常に優先（継承した環境変数を上書き）
import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { createLLMClient } from "./framework/llm-client";
import type { Tool } from "./framework/llm-client";
import { createMessageWithRetry, runAgentLoop, sleep, rateLimitRetries } from "./framework/agent-loop";
import { collectedFindings, initRunLog, saveRunLog, saveFinding, runLog } from "./framework/findings";
import { loadAgents, addAgent, retireAgent, recordAgentMemories, formatAgentMemories, type Agent, type MemoryInput } from "./framework/agent-store";
import { updateCoverage, computeWeightedSummary, getLastRunPaths, getFindingHotspots } from "./framework/coverage";
import { computeExperienceScore, formatExperienceLine } from "./framework/experience-score";
import { getShoalMode, filterAppTools, applyBrowserGuardrails, guardrailPrompt } from "./framework/guardrails";
import { loadPageHashes, updatePageHashes, hashContent } from "./framework/page-cache";
import { loadPersonaPack, formatPackForPrompt, type PersonaPack } from "./framework/persona-pack";
import { buildTrackers } from "./framework/trackers/index";
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
import { designScenarios, type Scenario, type ScenarioOutcome } from "./framework/scenario-designer";
import { runTriageAgent } from "./framework/triage";
import { generateReport } from "./framework/report";
import type { AgentLog, Finding, RegressionCheck } from "./framework/types";
import { loadTarget } from "./targets";
import { runAccountManager, loadTestAccounts, type TestAccount } from "./framework/account-manager";
import { estimateCost, formatCostUSD } from "./framework/cost";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";
const REFRESH_SPEC = process.env.REFRESH_SPEC === "1";
const trackers = buildTrackers();

const TARGET = process.env.TARGET ?? "none";
let targetConfig = loadTarget(TARGET);

// Load shoal.config.ts / .js / .mjs from the working directory if present
for (const name of ["shoal.config.ts", "shoal.config.js", "shoal.config.mjs"]) {
  const cfgPath = path.join(process.cwd(), name);
  if (fs.existsSync(cfgPath)) {
    try {
      const mod = await import(cfgPath);
      const t = mod.target ?? mod.default?.target;
      if (t?.appTools && typeof t?.execute === "function") {
        targetConfig = t;
        console.log(`[config] loaded: ${name}`);
      } else {
        console.warn(`[config] ${name} found but does not export a valid target`);
      }
    } catch (e) {
      console.warn(`[config] failed to load ${name}:`, e);
    }
    break;
  }
}

const SHOAL_MODE = getShoalMode();
if (SHOAL_MODE !== "full") console.log(`[guardrails] mode: ${SHOAL_MODE}`);
const APP_TOOLS = filterAppTools(targetConfig.appTools, SHOAL_MODE);

// skip exploration when no API tools are configured (after guardrail filtering)
const MAX_EXPLORERS = APP_TOOLS.length > 0
  ? parseInt(process.env.MAX_EXPLORERS ?? "4", 10)
  : 0;
const MAX_BROWSERS = parseInt(process.env.MAX_BROWSERS ?? "2", 10);

const { client, defaultModel, provider: llmProvider } = createLLMClient();

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

const VALID_CATEGORIES = ["ux", "feature-request", "bug", "goal-gap"];

const POST_FEEDBACK_TOOL: Tool = {
  name: "post_feedback",
  description: "Record a finding about the app — usability issues, feature requests, or bug-like behavior. / アプリへのフィードバックを記録する",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string" },
      body: {
        type: "string",
        description: `Describe the finding. Tone varies by category:
- bug: technical — state what happened, what was expected, and steps to reproduce.
- ux: experiential — write from the user's perspective ("I tried to...", "It was hard to find...", "I got confused when...").
- feature-request: aspirational — describe what you wished you could do ("It would have been helpful if...", "I wanted to...").
- goal-gap: goal-oriented — explain which goal was blocked and why ("I was trying to achieve X, but couldn't because...").`,
      },
      category: { type: "string", enum: ["ux", "feature-request", "bug", "goal-gap"] },
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

const POST_OUTCOME_TOOL: Tool = {
  name: "post_outcome",
  description: "Record whether you achieved your scenario goal. Call this at the end of your run if you were given a [Your Task for This Run] section. / [Your Task for This Run] セクションがある場合のみ、run の最後にゴール達成可否を記録する",
  input_schema: {
    type: "object",
    properties: {
      achieved: {
        type: "boolean",
        description: "true if you successfully completed the goal, false if you could not",
      },
      reason: {
        type: "string",
        description: "Brief explanation (1-2 sentences) of why the goal was or was not achieved",
      },
    },
    required: ["achieved", "reason"],
  },
};

const EXPLORER_TOOLS: Tool[] = [...APP_TOOLS, POST_FEEDBACK_TOOL, POST_OUTCOME_TOOL];

function goalsSection(spec: ProductSpec): string {
  if (!spec.appGoals?.length) return "";
  return `\n[App Goals]\nThis app is designed to achieve the following goals. If you find anything that prevents these goals from being met, use category "goal-gap" when posting feedback.\n${spec.appGoals.map((g) => `- ${g}`).join("\n")}\n`;
}
const REGRESSION_TOOLS: Tool[] = [...APP_TOOLS, REPORT_REGRESSION_TOOL, MARK_VERIFIED_TOOL];

function makeExecutor(agentLog: AgentLog, scenarioOutcomes: ScenarioOutcome[], scenario?: Scenario) {
  return async (toolName: string, input: Record<string, unknown>): Promise<string> => {
    const startedAt = Date.now();
    let result: unknown;
    try {
      switch (toolName) {
        case "post_outcome": {
          const { achieved, reason } = input as { achieved: boolean; reason: string };
          if (scenario) {
            const outcome: ScenarioOutcome = {
              scenarioId: scenario.id,
              scenarioTitle: scenario.title,
              agentId: agentLog.agentId,
              agentName: agentLog.agentName,
              achieved: Boolean(achieved),
              reason: String(reason),
              iterations: agentLog.iterations,
            };
            scenarioOutcomes.push(outcome);
            console.log(`  ${achieved ? "✓" : "✗"} [outcome] "${scenario.title}": ${achieved ? "achieved" : "NOT achieved"} — ${reason}`);
          }
          result = { recorded: true };
          break;
        }
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
          const url = await trackers.createIssue(
            `[regression] ${title}`,
            `**Regression:** #${original_issue_number} "${original_issue_title}" has reappeared.\n\n${body}\n\n---\n*This issue was auto-generated by an AI regression agent*`,
            ["regression", "feedback-agent"]
          );
          await trackers.commentOnIssue(
            original_issue_number,
            `⚠️ **Regression detected** by AI agent on ${new Date().toISOString().slice(0, 10)}\n\n${body}${url ? `\n\nNew issue: ${url}` : ""}`
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
          await trackers.commentOnIssue(
            original_issue_number,
            `✅ **Verified as fixed** by AI agent on ${new Date().toISOString().slice(0, 10)}\n\n${note}`
          );
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
  agent: Agent,
  productSpec: ProductSpec,
  assignment: { scenario?: Scenario; lens?: string } = {},
  scenarioOutcomes: ScenarioOutcome[] = [],
) {
  const assignmentLabel = assignment.scenario
    ? `[scenario: ${assignment.scenario.title.slice(0, 35)}]`
    : assignment.lens
    ? `[lens: ${assignment.lens.slice(0, 30)}...]`
    : "[free exploration]";
  console.log(`\n[explorer] ${agent.name} start ${assignmentLabel}`);
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
    visitedPaths: [],
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

When writing the body, match the tone to the category:
- bug: technical ("The endpoint returned 500 when...", "Expected X but got Y")
- ux: experiential ("I tried to find the button but...", "It was unclear what would happen if...")
- feature-request: aspirational ("It would have been useful if...", "I wished I could...")
- goal-gap: goal-oriented ("I was trying to X, but couldn't because...")

[Implemented Features]
${productSpec.features}
${productSpec.uiFeatures ? `\n[UI-Only Features]\nThese features exist in the UI but may not be reflected in API responses. Keep them in mind when interpreting API results.\n${productSpec.uiFeatures}\n` : ""}${productSpec.designContext ? `\n[Design Context]\n${productSpec.designContext}\n` : ""}${goalsSection(productSpec)}${assignment.scenario
    ? `\n[Your Task for This Run]\nTitle: ${assignment.scenario.title}\nYou are: ${assignment.scenario.context}\nGoal: ${assignment.scenario.goal}\nConstraints: ${assignment.scenario.constraints}\n\nFocus on completing this task naturally. Report any issues you encounter along the way.\nWhen done (or if you cannot complete the goal), call post_outcome with achieved=true/false and a brief reason.\n`
    : assignment.lens
    ? `\n[Focus Area for This Run]\n${assignment.lens}\nKeep this perspective in mind and prioritize reporting related issues.\n`
    : ""}${formatAgentMemories(agent)}${guardrailPrompt(SHOAL_MODE)}
Take 3–5 actions, then finish.`;

  await runAgentLoop(agentLog, systemPrompt, EXPLORER_TOOLS, client, defaultModel, makeExecutor(agentLog, scenarioOutcomes, assignment.scenario));
  console.log(`[explorer] ${agent.name} done`);
}

async function runRegressionAgent(
  agent: { id: string; name: string; persona: string; role: string },
  closedIssues: { number: number | string; title: string; body: string; labels: string[] }[],
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
    visitedPaths: [],
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
${productSpec.features}
${productSpec.uiFeatures ? `\n[UI-Only Features]\nThese features exist in the UI but may not be reflected in API responses.\n${productSpec.uiFeatures}\n` : ""}${productSpec.designContext ? `\n[Design Context]\n${productSpec.designContext}\n` : ""}${goalsSection(productSpec)}${guardrailPrompt(SHOAL_MODE)}`;

  await runAgentLoop(agentLog, systemPrompt, REGRESSION_TOOLS, client, defaultModel, makeExecutor(agentLog, []));
  const checked = agentLog.regressionChecks.length;
  const failed = agentLog.regressionChecks.filter((c) => c.status === "regressed").length;
  console.log(`[regression] ${agent.name} done (checked: ${checked} / regressed: ${failed})`);
}

// ================================================================
// Persona designer agent
// ================================================================

const PERSONA_DESIGNER_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_agents",
    description: "Get the current list of registered agents. / 現在登録されているエージェント一覧を取得する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_coverage",
    description: "Get a weighted summary of what has been explored across past runs. Use this to identify underrepresented lenses and perspectives before deciding whom to hire. / 過去のrunで何がどれだけ探索されたかの重み付きサマリーを取得する。採用方針の決定前に確認すること",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_path_coverage",
    description: "Get the list of URL paths visited in the previous run. Use this to identify unexplored areas of the app and recruit agents likely to visit NEW paths. / 前回のrunで訪れたURLパス一覧を取得する。未探索エリアを特定し、新しいパスを訪れる可能性の高いペルソナを採用するために使う",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_finding_hotspots",
    description: "Get URL areas where findings have clustered across all past runs. Use this to understand which parts of the app have been thoroughly investigated vs. overlooked — recruit agents to explore under-investigated areas, or specialists to deep-dive problem hotspots. / 過去のrun全体でfindingsが集中しているURLエリアを取得する。十分に調査済みのエリアと見落とされているエリアを把握し、未探索エリアへの新エージェント採用や問題多発エリアへのスペシャリスト派遣に活かす",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_persona_templates",
    description: "Get the persona template pack defined for this project. Prefer these archetypes when adding agents — adapt names/details to fit the app context but keep the role intact. / このプロジェクト用に定義されたペルソナテンプレート一覧を取得する。エージェントを追加する際はまずこのテンプレートから選ぶこと",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_open_issues",
    description: "Get the titles and labels of currently open GitHub Issues (known problems). Use this to understand what is already known and recruit agents who are likely to explore DIFFERENT areas. / 現在オープンなGitHub Issueのタイトルとラベルを取得する。既知の問題を把握し、未探索領域を掘れるペルソナを採用するために使う",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_scenarios",
    description: "Get the user test scenarios generated for this run. About 70% of agents will be assigned one of these scenarios — recruit personas whose background and role naturally fit the scenario contexts. / 今回のrunで生成されたユーザーシナリオ一覧を取得する。エージェントの約70%にシナリオが割り当てられるため、シナリオの文脈に自然にフィットするペルソナを採用すること",
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

async function runPersonaDesigner(
  productSpec: ProductSpec,
  orgGuidance: string,
  openIssues: { number: number | string; title: string; labels: string[] }[],
  scenarios: Scenario[],
  testAccounts: TestAccount[] = [],
  lastRunPaths: { visitedPaths: string[]; runId: string } | null = null,
  personaPack: PersonaPack | null = null,
): Promise<void> {
  console.log("\n[persona-designer] starting...");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "Design and manage user personas for this run." },
  ];

  const accountContext = testAccounts.length > 0
    ? `\n[Available Test Accounts (one per role)]\n${testAccounts.map((a) => `- ${a.role}: ${a.email}`).join("\n")}\nWhen recruiting agents, match each persona's role to one of these accounts so they can operate with appropriate permissions.`
    : "";

  const pathCoverageStep = lastRunPaths
    ? "3. Call get_path_coverage to see which URL paths were visited last run — recruit agents whose role would naturally take them to DIFFERENT or unexplored paths\n4. Call get_finding_hotspots to see where problems have clustered across all past runs — recruit agents to under-investigated areas, or specialists to problem hotspots"
    : "3. (No previous run data yet — skip get_path_coverage)\n4. Call get_finding_hotspots to see if any areas have already accumulated findings";

  const personaTemplateStep = personaPack
    ? "2. Call get_persona_templates to get project-specific persona archetypes — prefer these over inventing new personas from scratch"
    : "2. (No persona templates configured — invent personas that fit the app context)";

  const systemPrompt = `You are the persona designer for "${productSpec.appName}".
You create and manage test agents that simulate real users of the app.

[Organization Design Guidelines]
${orgGuidance}${accountContext}

[Steps]
1. Call get_coverage to review which lenses and categories are underrepresented in past runs
${personaTemplateStep}
${pathCoverageStep}
5. Call get_open_issues to understand what problems are already known — recruit agents likely to find DIFFERENT issues in unexplored areas
6. Call get_scenarios to see the user test scenarios generated for this run — about 70% of agents will be assigned a scenario, so recruit personas whose background fits those scenarios
7. Call get_agents to check the current agent roster
8. Add 2–3 agents with add_agent — balance between scenario-fit personas (step 6), underrepresented lenses (step 1), unexplored paths (step 3), finding hotspots (step 4), and unexplored areas (step 5)${testAccounts.length > 0 ? "\n   — assign each agent a role that matches one of the available test accounts" : ""}
9. If there are agents with old createdAt dates (oldest 1–2), retire them with retire_agent`;

  try {
    let iterations = 0;
    while (iterations < 8) {
      iterations++;
      const response = await createMessageWithRetry(client, {
        model: defaultModel,
        max_tokens: 1024,
        system: systemPrompt,
        tools: PERSONA_DESIGNER_TOOLS,
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
        if (toolUse.name === "get_coverage") {
          result = computeWeightedSummary().formatted;
          console.log("  [persona-designer] coverage summary fetched");
        } else if (toolUse.name === "get_persona_templates") {
          if (!personaPack) {
            result = "(no persona templates configured — set SHOAL_PERSONAS env var or add personas.yaml to your project)";
          } else {
            result = formatPackForPrompt(personaPack);
          }
          console.log(`  [persona-designer] persona templates fetched (${personaPack?.personas.length ?? 0})`);
        } else if (toolUse.name === "get_path_coverage") {
          if (!lastRunPaths || lastRunPaths.visitedPaths.length === 0) {
            result = "(no path coverage data yet — this is the first run or no paths were recorded)";
          } else {
            result = `Paths visited in last run (${lastRunPaths.runId}):\n${lastRunPaths.visitedPaths.map((p) => `- ${p}`).join("\n")}\n\nRecruit agents whose role naturally takes them to paths NOT in this list.`;
          }
          console.log(`  [persona-designer] path coverage fetched (${lastRunPaths?.visitedPaths.length ?? 0} paths)`);
        } else if (toolUse.name === "get_finding_hotspots") {
          const hotspots = getFindingHotspots();
          if (hotspots.length === 0) {
            result = "(no past findings data yet — this appears to be the first run)";
          } else {
            result = hotspots.map((h) =>
              `${h.pathPrefix}: ${h.totalFindings} findings — ${Object.entries(h.categories).map(([c, n]) => `${c}:${n}`).join(", ")}`
            ).join("\n");
          }
          console.log(`  [persona-designer] finding hotspots fetched (${hotspots.length} areas)`);
        } else if (toolUse.name === "get_open_issues") {
          if (openIssues.length === 0) {
            result = "(no open issues — either GitHub is not configured or there are no known issues yet)";
          } else {
            result = openIssues.map((i) => `- #${i.number}: ${i.title} [${i.labels.join(", ")}]`).join("\n");
          }
          console.log(`  [persona-designer] open issues fetched (${openIssues.length})`);
        } else if (toolUse.name === "get_scenarios") {
          if (scenarios.length === 0) {
            result = "(no scenarios generated — all agents will use free-exploration mode)";
          } else {
            result = scenarios.map((s) =>
              `[${s.id}] ${s.title}\n  Context: ${s.context}\n  Goal: ${s.goal}\n  Constraints: ${s.constraints}`
            ).join("\n\n");
          }
          console.log(`  [persona-designer] scenarios fetched (${scenarios.length})`);
        } else if (toolUse.name === "get_agents") {
          const agents = loadAgents();
          result = agents.map((a) => ({ id: a.id, name: a.name, role: a.role, createdAt: a.createdAt }));
          console.log(`  [persona-designer] current agents: ${agents.length}`);
        } else if (toolUse.name === "add_agent") {
          const { name, role, persona } = toolUse.input as { name: string; role: string; persona: string };
          result = addAgent({ name, role, persona });
          console.log(`  [persona-designer] created: ${name} (${role})`);
        } else if (toolUse.name === "retire_agent") {
          const { agentId, reason } = toolUse.input as { agentId: string; reason: string };
          result = { success: retireAgent(agentId) };
          console.log(`  [persona-designer] retired: ${agentId} — ${reason}`);
        } else {
          result = { error: "unknown tool" };
        }
        toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: toolResults });
    }
    console.log("[persona-designer] done");
  } catch (e) {
    console.error("[persona-designer] error:", e);
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
  visitedPaths: string[];
  feedbacksSaved: { title: string; category: string; findingId: string }[];
  error: string | null;
}

const TOOLS_THAT_SEND_SCREENSHOT = new Set(["navigate", "post_feedback", "view_screen"]);

const BROWSER_TOOLS: Anthropic.Tool[] = [
  ...(MAX_EXPLORERS > 0 ? APP_TOOLS.map((t) => ({ ...t, description: `[API check] ${t.description}` })) : []),
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
        category: { type: "string", enum: ["ux", "feature-request", "bug", "goal-gap"] },
      },
      required: ["title", "body", "category"],
    },
  },
  {
    name: "post_outcome",
    description: "Record whether you achieved your scenario goal. Call this at the end of your run if you were given a [Your Task for This Run] section. / [Your Task for This Run] セクションがある場合のみ、run の最後にゴール達成可否を記録する",
    input_schema: {
      type: "object",
      properties: {
        achieved: { type: "boolean", description: "true if you successfully completed the goal, false if you could not" },
        reason: { type: "string", description: "Brief explanation (1-2 sentences)" },
      },
      required: ["achieved", "reason"],
    },
  },
];

async function executeBrowserTool(
  toolName: string,
  input: Record<string, unknown>,
  page: Page,
  agentLog: BrowserAgentLog,
  observation: ObservationState,
  agentId: string,
  scenarioOutcomes: ScenarioOutcome[],
  cachedHashes: Record<string, string>,
  pageHashUpdates: Record<string, string>,
  scenario?: Scenario,
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
        await page.waitForTimeout(3000);
        screenshot = await takeScreenshot(page, `navigate_${navPath.replace(/\//g, "_")}`);
        agentLog.visitedPaths.push(navPath);
        // ページコンテンツハッシュで差分検出
        try {
          const content = await page.innerText("body", { timeout: 2000 });
          const h = hashContent(content);
          const unchanged = cachedHashes[navPath] && cachedHashes[navPath] === h;
          pageHashUpdates[navPath] = h;
          resultText = unchanged
            ? `Navigated to ${navPath} (page content unchanged since last run — consider exploring a different area)`
            : `Navigated to ${navPath}`;
        } catch {
          resultText = `Navigated to ${navPath}`;
        }
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
      case "post_outcome": {
        const { achieved, reason } = input as { achieved: boolean; reason: string };
        if (scenario) {
          const outcome: ScenarioOutcome = {
            scenarioId: scenario.id,
            scenarioTitle: scenario.title,
            agentId,
            agentName: agentLog.agentName,
            achieved: Boolean(achieved),
            reason: String(reason),
            iterations: agentLog.iterations,
          };
          scenarioOutcomes.push(outcome);
          console.log(`  ${achieved ? "✓" : "✗"} [outcome] "${scenario.title}": ${achieved ? "achieved" : "NOT achieved"} — ${reason}`);
        }
        resultText = "Outcome recorded.";
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
  agent: Agent,
  page: Page,
  productSpec: ProductSpec,
  assignment: { scenario?: Scenario; lens?: string } = {},
  scenarioOutcomes: ScenarioOutcome[] = [],
): Promise<BrowserAgentLog> {
  const assignmentLabel = assignment.scenario
    ? `[scenario: ${assignment.scenario.title.slice(0, 35)}]`
    : assignment.lens
    ? `[lens: ${assignment.lens.slice(0, 30)}...]`
    : "[free exploration]";
  console.log(`\n[browser] ${agent.name} start ${assignmentLabel}`);

  const agentLog: BrowserAgentLog = {
    agentName: agent.name,
    persona: agent.persona,
    startedAt: new Date().toISOString(),
    completedAt: null,
    status: "completed",
    iterations: 0,
    actions: [],
    visitedPaths: [],
    feedbacksSaved: [],
    error: null,
  };

  const observation = setupObservation(page);
  const host = new URL(BASE_URL).host;
  const cachedHashes = loadPageHashes(host);
  const pageHashUpdates: Record<string, string> = {};

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

When writing the body, match the tone to the category:
- bug: technical ("The endpoint returned 500 when...", "Expected X but got Y")
- ux: experiential ("I tried to find the button but...", "It was unclear what would happen if...")
- feature-request: aspirational ("It would have been useful if...", "I wished I could...")
- goal-gap: goal-oriented ("I was trying to X, but couldn't because...")

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
${productSpec.designContext ? `\n[Design Context]\n${productSpec.designContext}\n` : ""}${goalsSection(productSpec)}${assignment.scenario
    ? `\n[Your Task for This Run]\nTitle: ${assignment.scenario.title}\nYou are: ${assignment.scenario.context}\nGoal: ${assignment.scenario.goal}\nConstraints: ${assignment.scenario.constraints}\n\nFocus on completing this task naturally as this user. Report any issues you encounter along the way.\nWhen done (or if you cannot complete the goal), call post_outcome with achieved=true/false and a brief reason.`
    : assignment.lens
    ? `\n[Focus Area for This Run]\n${assignment.lens}\nKeep this perspective in mind and prioritize reporting related issues.`
    : ""}${formatAgentMemories(agent)}${guardrailPrompt(SHOAL_MODE)}`;

  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForTimeout(5000);
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
          agent.id,
          scenarioOutcomes,
          cachedHashes,
          pageHashUpdates,
          assignment.scenario,
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
    updatePageHashes(host, pageHashUpdates);
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

// 7:3 ratio: indices where (idx % 10) < 7 get a scenario, rest get a lens
function pickAssignment(idx: number, scenarios: Scenario[]): { scenario?: Scenario; lens?: string } {
  if (scenarios.length > 0 && idx % 10 < 7) {
    return { scenario: scenarios[idx % scenarios.length] };
  }
  return { lens: UNIVERSAL_LENSES[idx % UNIVERSAL_LENSES.length] };
}

async function main() {
  initDirs();
  // run log を最初期化しておくことで、どの段階でエラーが起きても finally で saveRunLog() が動く
  initRunLog(0, process.env.GITHUB_REPO ?? "");

  // 1. product discovery (cache or live)
  const browser = await chromium.launch({ headless: true });
  let productSpec: ProductSpec;
  const scenarioOutcomes: ScenarioOutcome[] = [];
  try {
    const cached = loadCachedSpec(BASE_URL);
    if (cached && !REFRESH_SPEC) {
      const ageDays = cached.discoveredAt
        ? Math.floor((Date.now() - new Date(cached.discoveredAt).getTime()) / 86_400_000)
        : null;
      const ageStr = ageDays != null ? `${ageDays} day${ageDays !== 1 ? "s" : ""} old` : "unknown date";
      const staleHint = ageDays != null && ageDays >= 7 ? " — set REFRESH_SPEC=1 to re-run discovery" : "";
      console.log(`\n[product-discovery] using cache (${ageStr}, confidence: ${cached.confidence})${staleHint}`);
      productSpec = cached;
    } else {
      const discoveryContext = await browser.newContext({ viewport: { width: 1024, height: 640 } });
      const discoveryPage = await discoveryContext.newPage();
      productSpec = await discoverProduct(BASE_URL, discoveryPage, client, defaultModel, targetConfig.projectPath);
      await discoveryContext.close();
    }

    // 2. org design (coverage-aware)
    const coverageSummary = computeWeightedSummary();
    console.log(`\n[coverage] ${coverageSummary.formatted.split("\n")[0]}`);
    const orgDesign = await designOrg(productSpec, client, defaultModel, coverageSummary.formatted);

    // 3. open issues + scenario design (both feed into HR)
    const openIssues = await trackers.fetchOpenIssues();
    const scenarios = await designScenarios(productSpec, openIssues, client, defaultModel, 5, coverageSummary.formatted);

    // 3.5. Account Manager（credentials が設定されている場合のみ）
    let testAccounts: TestAccount[] = [];
    if (targetConfig.credentials) {
      const accountContext = await browser.newContext({ viewport: { width: 1024, height: 640 } });
      try {
        testAccounts = await runAccountManager(
          BASE_URL,
          targetConfig.credentials,
          productSpec,
          accountContext,
          client,
          defaultModel,
          runLog.runId,
        );
      } finally {
        await accountContext.close();
      }
    }

    // 4. HR agent
    const lastRunPaths = getLastRunPaths();
    const personaPack = await loadPersonaPack();
    await runPersonaDesigner(productSpec, orgDesign.personaGuidance, openIssues, scenarios, testAccounts, lastRunPaths, personaPack);

    // 5. load agents + closed issues
    const allAgents = loadAgents();
    if (allAgents.length === 0) {
      console.error("No agents found. Check agents.json.");
      process.exit(1);
    }
    const closedIssues = await trackers.fetchClosedIssues();

    // 5. エージェント数が確定したので totalAgents を更新
    runLog.summary.totalAgents = allAgents.length;

    // 6. API agents (exploration + regression)
    const allExplorers = allAgents.slice(0, -1);
    const explorerAgents = pickAgents(allExplorers, Math.min(MAX_EXPLORERS, allExplorers.length));
    const regressionAgent = allAgents[allAgents.length - 1];
    console.log(`\nexplorers: ${explorerAgents.length} (max: ${MAX_EXPLORERS}) / regression: 1`);

    // agentId → assignment（coverage 計算・レポート生成に使う）
    const agentAssignments = new Map<string, { scenario?: Scenario; lens?: string }>();

    // シナリオ/レンズ割り当てのグローバルカウンタ（7:3 比率）
    let dispatchIdx = 0;

    const CONCURRENCY = 2;
    for (let i = 0; i < explorerAgents.length; i += CONCURRENCY) {
      const batch = explorerAgents.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((agent) => {
        const assignment = pickAssignment(dispatchIdx++, scenarios);
        agentAssignments.set(agent.id, assignment);
        return runExplorer(agent, productSpec, assignment, scenarioOutcomes);
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
      const assignment = pickAssignment(dispatchIdx++, scenarios);
      agentAssignments.set(regressionAgent.id, assignment);
      await runExplorer(regressionAgent, productSpec, assignment, scenarioOutcomes);
    }

    // 7. browser agents
    const browserAgents = pickAgents(allAgents, Math.min(MAX_BROWSERS, allAgents.length));
    console.log(`\nlaunching ${browserAgents.length} browser agents in parallel (max: ${MAX_BROWSERS})`);
    browserAgents.forEach((a) => console.log(`  - ${a.name} (${a.role})`));

    await sleep(2000);
    const browserLogs = await Promise.all(
      browserAgents.map(async (agent) => {
        const assignment = pickAssignment(dispatchIdx++, scenarios);
        agentAssignments.set(agent.id, assignment);

        // ロールが一致する storageState があれば使う
        const matchedAccount = testAccounts.find((a) => a.role === agent.role && a.storageStatePath);
        const contextOptions: Parameters<typeof browser.newContext>[0] = {
          viewport: { width: 1024, height: 640 },
        };
        if (matchedAccount?.storageStatePath) {
          contextOptions.storageState = matchedAccount.storageStatePath;
        }

        const context = await browser.newContext(contextOptions);
        await applyBrowserGuardrails(context, SHOAL_MODE);
        const page = await context.newPage();
        try {
          return await runBrowserAgent(agent, page, productSpec, assignment, scenarioOutcomes);
        } finally {
          await context.close();
        }
      })
    );
    const allVisitedPaths = browserLogs.flatMap((log) => log.visitedPaths);

    // 8. triage (API + browser findings)
    await sleep(2000);
    console.log(`\n[triage] collected findings: ${collectedFindings.length}`);
    let triageResult = { issued: [] as string[], skipped: [] as string[], unprocessed: [] as string[], issuesCreated: 0 };
    try {
      triageResult = await runTriageAgent(collectedFindings, client, defaultModel, trackers);
      runLog.summary.totalIssuesPosted += triageResult.issuesCreated;
    } catch (e) {
      console.error("[triage] error:", e);
    }

    // 9. record each agent's personal memory (frustrations / achievements)
    const memoryInputs = new Map<string, MemoryInput>();
    for (const log of runLog.agents) {
      const input: MemoryInput = { frustrations: [], achievements: [] };
      for (const o of scenarioOutcomes) {
        if (o.agentId !== log.agentId) continue;
        if (o.achieved) input.achievements.push(`Completed "${o.scenarioTitle}"`);
        else input.frustrations.push(`Could not complete "${o.scenarioTitle}" — ${o.reason}`);
      }
      for (const f of collectedFindings) {
        if (f.agentId !== log.agentId) continue;
        input.frustrations.push(`Reported [${f.category}] "${f.title}"`);
      }
      memoryInputs.set(log.agentId, input);
    }
    recordAgentMemories(runLog.runId, memoryInputs);

    // 10. update coverage (report が最新スコアを含められるよう先に更新する)
    updateCoverage(runLog.runId, collectedFindings, agentAssignments, allVisitedPaths, {
      scenarioOutcomes,
      regression: {
        checked: runLog.summary.regressionChecked,
        regressed: runLog.summary.regressionFailed,
      },
    });

    // 11. experience score + HTML report
    const experience = computeExperienceScore();
    if (experience) console.log(`\n[experience] ${formatExperienceLine(experience)}`);
    const reportPath = generateReport(runLog, collectedFindings, triageResult, productSpec, scenarios, agentAssignments, scenarioOutcomes, experience);
    console.log(`\n[report] ${reportPath}`);

  } finally {
    await browser.close();
    // エラー終了時も必ずログを保存する
    runLog.completedAt = new Date().toISOString();
    runLog.summary.rateLimitRetries = rateLimitRetries;
    runLog.summary.cost.estimatedUSD = await estimateCost(
      defaultModel, llmProvider,
      runLog.summary.cost.inputTokens,
      runLog.summary.cost.outputTokens,
    );
    saveRunLog();
  }

  console.log("\nAll agents done.");
  console.log(`  findings collected: ${collectedFindings.length}`);
  console.log(`  tokens: ${runLog.summary.cost.inputTokens} in / ${runLog.summary.cost.outputTokens} out — estimated cost: ${formatCostUSD(runLog.summary.cost.estimatedUSD)}`);
  console.log(`  GitHub issues created: ${runLog.summary.totalIssuesPosted}`);
  console.log(`  regression checks: ${runLog.summary.regressionChecked} (regressed: ${runLog.summary.regressionFailed})`);
  console.log(`  screenshots: ${screenshotDir}`);

  if (scenarioOutcomes.length > 0) {
    const failed = scenarioOutcomes.filter((o) => !o.achieved);
    console.log(`  scenarios: ${scenarioOutcomes.length - failed.length}/${scenarioOutcomes.length} achieved`);
    if (failed.length > 0) {
      console.log(`  ⚠ failed scenarios:`);
      failed.forEach((o) => console.log(`    ✗ ${o.scenarioTitle} — ${o.reason}`));
      process.exitCode = 1;
    }
  }
}

main().catch(console.error);
