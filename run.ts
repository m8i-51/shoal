/**
 * run.ts — Multi-agent runner
 * hr → product discovery → api agents + browser agents + threshold agents → triage
 *
 * Usage:
 *   ANTHROPIC_API_KEY=xxx GITHUB_TOKEN=xxx GITHUB_REPO=owner/repo npx tsx run.ts
 */

import { loadShoalEnv } from "./framework/load-env";
loadShoalEnv({ quiet: process.env.NODE_ENV === "test" });
import Anthropic from "@anthropic-ai/sdk";
import { chromium, type Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import { createLLMClient } from "./framework/llm-client";
import type { Tool } from "./framework/llm-client";
import { runAgentLoop, sleep, rateLimitRetries } from "./framework/agent-loop";
import { runToolSession } from "./framework/tool-session";
import type { ToolResultContent } from "./framework/tool-types";
import { collectedFindings, initRunLog, saveRunLog, saveFinding, getSwarmSignals, runLog } from "./framework/findings";
import { loadAgents, addAgent, retireAgent, recordAgentMemories, formatAgentMemories, buildMemoryInputs, isFixedAgent, agentOrigin, resolveAgentAccountRole, type Agent } from "./framework/agent-store";
import { computeRosterSlots, buildRunRoster, splitRosterForDispatch, partitionActiveAgents } from "./framework/roster";
import { updateCoverage, computeWeightedSummary, getLastRunPaths, getFindingHotspots } from "./framework/coverage";
import {
  loadSiteMap,
  saveSiteMap,
  seedFromSitemap,
  formatSiteMapForPersona,
  formatSiteMapLogLine,
  recordVisit,
  ingestDiscoveredPaths,
  collectSameOriginHrefs,
  normalizePath,
  MAX_DISCOVERED_PER_RUN,
  type SiteMap,
} from "./framework/site-map";
import { computeExperienceScore, formatExperienceLine } from "./framework/experience-score";
import { updateAdoption } from "./framework/adoption";
import { getShoalMode, filterAppTools, applyBrowserGuardrails, guardrailPrompt } from "./framework/guardrails";
import { buildContextOptions, sanitizeEnvironment, describeEnvironment, applyNetworkThrottle, type EnvironmentProfile } from "./framework/environment";
import { agentSessionPath, hasAgentSession, saveAgentSession, sessionContinuityPrompt } from "./framework/session-store";
import { loadPageHashes, updatePageHashes } from "./framework/page-cache";
import { traceAgentZipPath } from "./framework/trace-chunk";
import { registerSecrets, scrubTraceZipSafely } from "./framework/trace-scrub";
import { getRetentionDays, pruneRunArtifacts } from "./framework/retention";
import { loadPersonaPack, formatPackForPrompt, type PersonaPack } from "./framework/persona-pack";
import { buildTrackers, formatIssuesCreatedLine } from "./framework/trackers/index";
import { setupObservation, buildObservationWarning } from "./framework/observation";
import { discoverProduct, loadCachedSpec, resolveLoginPath, type ProductSpec } from "./framework/product-discovery";
import { designOrg } from "./framework/org-designer";
import { designScenarios, findMultiActorScenario, pairAgentsToActors, type Scenario, type ScenarioOutcome } from "./framework/scenario-designer";
import { runTriageAgent, type TriageResult } from "./framework/triage";
import { generateReport } from "./framework/report";
import type { AgentLog, Finding, RegressionCheck } from "./framework/types";
import { resolveIssueId, formatIssueRef } from "./framework/issue-id";
import type { ClosedIssue } from "./framework/trackers/types";
import { loadTarget, applyLoadedTarget } from "./targets";
import { runAccountManager, resolveAccountSetup, persistAccountSessions, planBrowserAuth, authPrompt, describeAuthPlan, resolveLoginUrl, type TestAccount, type BrowserAuthPlan } from "./framework/account-manager";
import { estimateCost, formatCostUSD } from "./framework/cost";
import {
  normalizeThresholdCandidates,
  sortThresholdCandidates,
  assignThresholdCandidates,
  type ThresholdCandidate,
} from "./framework/threshold";
import { formatToolCallLog, redactToolInput } from "./framework/redact";
import {
  executeBrowserTool,
  VALID_CATEGORIES,
  type BrowserAgentLog,
  type BrowserToolContext,
} from "./framework/browser-tools";
import { untrustedContentPrompt, wrapUntrusted } from "./framework/untrusted";
import {
  MARK_VERIFIED_TOOL,
  PERSONA_DESIGNER_TOOLS,
  REPORT_REGRESSION_TOOL,
  browserTools,
  explorerTools,
  regressionTools,
} from "./framework/agent-tools";
import {
  RUN_TIMINGS,
  browserIterations,
  explorerConcurrency,
  resolveViewport,
  thresholdIterations,
  DEFAULT_PERSONA_DESIGNER_ITERATIONS,
} from "./framework/run-config";
import {
  BudgetExceededError,
  budgetStatusLine,
  budgetStopLine,
  initBudget,
  isBudgetExceeded,
  prepareBudget,
} from "./framework/budget";
import { pickAssignment, dispatchableSoloScenarios, reconcileMultiActorOutcomes, type Assignment } from "./framework/assignment";
import { partitionClosedIssues, regressionMaxIterations } from "./framework/regression-issue";

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
      const applied = applyLoadedTarget(targetConfig, mod, name);
      targetConfig = applied.config;
      for (const message of applied.messages) {
        if (message.level === "warn") console.warn(message.text);
        else console.log(message.text);
      }
    } catch (e) {
      console.warn(`[config] failed to load ${name}:`, e);
    }
    break;
  }
}

const SHOAL_MODE = getShoalMode();
const VIEWPORT = resolveViewport();
if (SHOAL_MODE !== "full") console.log(`[guardrails] mode: ${SHOAL_MODE}`);
const APP_TOOLS = filterAppTools(targetConfig.appTools, SHOAL_MODE);

// skip exploration when no API tools are configured (after guardrail filtering)
let MAX_EXPLORERS = APP_TOOLS.length > 0
  ? parseInt(process.env.MAX_EXPLORERS ?? "4", 10)
  : 0;
let MAX_BROWSERS = parseInt(process.env.MAX_BROWSERS ?? "2", 10);
const MAX_THRESHOLDS = parseInt(process.env.MAX_THRESHOLDS ?? "1", 10);

const { client, defaultModel, provider: llmProvider } = createLLMClient();

// Playwright trace — ブラウザエージェントのセッションを丸ごと記録する（SHOAL_TRACE=0 で無効化）
const TRACE_ENABLED = process.env.SHOAL_TRACE !== "0";

// PR Experience Diff などで探索を特定パスに集中させる（カンマ区切り）
const FOCUS_PATHS = (process.env.SHOAL_FOCUS_PATHS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (FOCUS_PATHS.length > 0) console.log(`[focus] exploration focused on: ${FOCUS_PATHS.join(", ")}`);

// verify モード — 単一 finding の修正検証に特化した run（MCP の verify_fix から使う）
// SHOAL_VERIFY_FINDING に finding の JSON（id/title/body/category）を渡す
interface VerifyFinding { id: string; title: string; body: string; category?: string }
function parseVerifyFinding(): VerifyFinding | null {
  const raw = process.env.SHOAL_VERIFY_FINDING;
  if (!raw) return null;
  try {
    const f = JSON.parse(raw) as VerifyFinding;
    if (typeof f.id === "string" && typeof f.title === "string" && typeof f.body === "string") return f;
  } catch { /* fallthrough */ }
  console.error("[verify] SHOAL_VERIFY_FINDING must be JSON with id/title/body");
  process.exit(1);
}
const VERIFY_FINDING = parseVerifyFinding();

function focusPrompt(): string {
  if (FOCUS_PATHS.length === 0) return "";
  return `
[Focus Paths for This Run]
Recent code changes affect these areas — spend most of your session here:
${FOCUS_PATHS.map((p) => `- ${p}`).join("\n")}
Explore these paths first and in depth. Only wander elsewhere once they are exhausted.`;
}

// エージェントへの割り当て。actor はマルチアクターシナリオで同時に動く役割
// (Assignment is defined in framework/assignment.ts)

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

/**
 * Run-wide collaborators every browser tool call needs. The per-agent fields
 * (page, agentLog, observation, …) are spread in at the call site.
 */
function browserToolBaseContext(): Pick<
  BrowserToolContext,
  "baseUrl" | "mode" | "traceEnabled" | "runId" | "timings" | "takeScreenshot" | "executeAppTool" | "trackers"
> {
  return {
    baseUrl: BASE_URL,
    mode: SHOAL_MODE,
    traceEnabled: TRACE_ENABLED,
    runId: runLog.runId,
    timings: RUN_TIMINGS,
    takeScreenshot,
    executeAppTool: (toolName, input, agentId) => targetConfig.execute(toolName, input, agentId),
    trackers,
  };
}

// ================================================================
// API agent tools
// ================================================================



const EXPLORER_TOOLS: Tool[] = explorerTools(APP_TOOLS);

function goalsSection(spec: ProductSpec): string {
  if (!spec.appGoals?.length) return "";
  return `\n[App Goals]\nThese are user/business success conditions (outcomes), not a UI widget checklist. Use category "goal-gap" only when an outcome is blocked. Do not treat missing or mismatched controls (search, filters, sort, badges, etc.) as goal-gap — file those as bug / ux / feature-request instead.\n${spec.appGoals.map((g) => `- ${g}`).join("\n")}\n`;
}
const REGRESSION_TOOLS: Tool[] = regressionTools(APP_TOOLS);

// ブラウザレーンのツール。API レーンが有効なときだけ [API check] ツールを含める
const BROWSER_TOOLS = browserTools(APP_TOOLS, MAX_EXPLORERS > 0);

function makeExecutor(
  agentLog: AgentLog,
  scenarioOutcomes: ScenarioOutcome[],
  scenario?: Scenario,
  closedIssues: ClosedIssue[] = [],
) {
  return async (toolName: string, input: Record<string, unknown>): Promise<string> => {
    const startedAt = Date.now();
    let result: unknown;
    // Set when the result quotes the target app, so it goes back fenced.
    // The trailing hint stays outside the fence — it is our instruction, not data.
    let untrusted: { source: string; hint?: string } | null = null;
    try {
      switch (toolName) {
        case "check_swarm_signals": {
          const currentPath = agentLog.visitedPaths.at(-1);
          const signals = getSwarmSignals(agentLog.agentId, 8, currentPath);
          result = { signals, currentPath: currentPath ?? null };
          untrusted = {
            source: "swarm signals",
            hint: signals.length > 0
              ? "These reports are from your current area when possible — try to reproduce them from your own perspective."
              : "No reports from other agents in your area yet — keep exploring.",
          };
          break;
        }
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
            original_issue_number: string; original_issue_title: string; title: string; body: string;
          };
          const issueId = resolveIssueId(original_issue_number, closedIssues);
          const url = await trackers.createIssue(
            `[regression] ${title}`,
            `**Regression:** ${issueId} "${original_issue_title}" has reappeared.\n\n${body}\n\n---\n*This issue was auto-generated by an AI regression agent*`,
            ["regression", "feedback-agent"]
          );
          await trackers.commentOnIssue(
            issueId,
            `⚠️ **Regression detected** by AI agent on ${new Date().toISOString().slice(0, 10)}\n\n${body}${url ? `\n\nNew issue: ${url}` : ""}`
          );
          const check: RegressionCheck = {
            issueNumber: issueId,
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
            original_issue_number: string; original_issue_title: string; note: string;
          };
          const issueId = resolveIssueId(original_issue_number, closedIssues);
          await trackers.commentOnIssue(
            issueId,
            `✅ **Verified as fixed** by AI agent on ${new Date().toISOString().slice(0, 10)}\n\n${note}`
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
          result = { verified: true };
          break;
        }
        default:
          result = await targetConfig.execute(toolName, input, agentLog.agentId);
          untrusted = { source: `api:${toolName}` };
      }
    } catch (e) {
      result = { error: String(e) };
    }
    agentLog.actions.push({
      timestamp: new Date().toISOString(),
      tool: toolName,
      input: redactToolInput(toolName, input),
      result,
      durationMs: Date.now() - startedAt,
    });
    runLog.summary.totalActions++;
    const serialized = JSON.stringify(result);
    if (!untrusted) return serialized;
    const fenced = wrapUntrusted(untrusted.source, serialized);
    return untrusted.hint ? `${fenced}\n${untrusted.hint}` : fenced;
  };
}

// ================================================================
// API agents (exploration / regression)
// ================================================================

async function runExplorer(
  agent: Agent,
  productSpec: ProductSpec,
  assignment: Assignment = {},
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
You have API tools only — not a real browser. You cannot click UI controls, toggle themes, open notification panels, use a hamburger menu, or complete OAuth in a page.
If the assigned task requires a real UI, call post_outcome with achieved=false and say it needs the browser lane.

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
    : ""}${focusPrompt()}${formatAgentMemories(agent)}${guardrailPrompt(SHOAL_MODE)}
Take 3–5 actions, then finish.

${untrustedContentPrompt()}`;

  await runAgentLoop(agentLog, systemPrompt, EXPLORER_TOOLS, client, defaultModel, makeExecutor(agentLog, scenarioOutcomes, assignment.scenario), llmProvider);
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
    .map((i) => `- Issue ${i.number}: ${i.title}\n  ${i.body.slice(0, 200).replace(/\n/g, " ")}`)
    .join("\n");

  const systemPrompt = `You are "${agent.name}". Act as a QA engineer.

You have API tools only — not a real browser. Do not mark a UI-only bug (theme, OAuth page, hamburger, notification panel, layout) as verified or regressed from API evidence. Skip those.

The following Issues have been closed as fixed. Verify they are actually fixed via API when that is enough.

[Issues to Verify]
${issueList}

[Steps]
1. Read each Issue and perform actions that could reproduce it
2. If the problem reoccurs, report it with report_regression
3. If the problem is gone, record it with mark_verified
4. Finish after checking all items

[Reference: Implemented Features]
${productSpec.features}
${productSpec.uiFeatures ? `\n[UI-Only Features]\nThese features exist in the UI but may not be reflected in API responses.\n${productSpec.uiFeatures}\n` : ""}${productSpec.designContext ? `\n[Design Context]\n${productSpec.designContext}\n` : ""}${goalsSection(productSpec)}${guardrailPrompt(SHOAL_MODE)}

${untrustedContentPrompt()}`;

  await runAgentLoop(
    agentLog,
    systemPrompt,
    REGRESSION_TOOLS,
    client,
    defaultModel,
    makeExecutor(agentLog, [], undefined, closedIssues),
    llmProvider,
    regressionMaxIterations(closedIssues.length),
  );
  const checked = agentLog.regressionChecks.length;
  const failed = agentLog.regressionChecks.filter((c) => c.status === "regressed").length;
  console.log(`[regression] ${agent.name} done (checked: ${checked} / regressed: ${failed})`);
}

// ================================================================
// Persona designer agent
// ================================================================


async function runPersonaDesigner(
  productSpec: ProductSpec,
  orgGuidance: string,
  openIssues: { number: number | string; title: string; labels: string[] }[],
  scenarios: Scenario[],
  testAccounts: TestAccount[] = [],
  lastRunPaths: { visitedPaths: string[]; runId: string } | null = null,
  personaPack: PersonaPack | null = null,
  siteMap: SiteMap | null = null,
  autoSlots = 2,
): Promise<void> {
  console.log("\n[persona-designer] starting...");

  const accountContext = testAccounts.length > 0
    ? `\n[Available Test Accounts (one per role)]\n${testAccounts.map((a) => `- ${a.role}: ${a.email}`).join("\n")}\nWhen recruiting agents, set accountRole to one of these short tokens (user, instructor, admin). Keep role as a narrative description of the person — never put that sentence in accountRole.`
    : "";

  const pathCoverageStep = "3. Call get_path_coverage to review site-map coverage (unvisited / reached / explored rates and gaps) — recruit agents whose role would naturally fill UNVISITED or thinly visited paths\n4. Call get_finding_hotspots to see where problems have clustered across all past runs — recruit agents to under-investigated areas, or specialists to problem hotspots";

  const personaTemplateStep = personaPack
    ? "2. Call get_persona_templates to get project-specific persona archetypes — prefer these over inventing new personas from scratch"
    : "2. (No persona templates configured — invent personas that fit the app context)";

  const systemPrompt = `You are the persona designer for "${productSpec.appName}".
You create and manage test agents that simulate real users of the app.

[Organization Design Guidelines]
${orgGuidance}${accountContext}

[Fixed roster rules]
- Agents with origin "fixed" are team-curated permanent members. NEVER call retire_agent on them.
- Align the number of ACTIVE auto agents (origin "auto" or missing) to exactly ${autoSlots}.
  — If fewer than ${autoSlots} active autos exist, add_agent until you reach ${autoSlots}.
  — If more than ${autoSlots} active autos exist, retire_agent the excess autos only (oldest first).
  — If autoSlots is 0, do not add autos; retire excess autos if any.

[Steps]
1. Call get_coverage to review which lenses and categories are underrepresented in past runs
${personaTemplateStep}
${pathCoverageStep}
5. Call get_open_issues to understand what problems are already known — recruit agents likely to find DIFFERENT issues in unexplored areas
6. Call get_scenarios to see the user test scenarios generated for this run — about 70% of agents will be assigned a scenario, so recruit personas whose background fits those scenarios
7. Call get_agents to check the current agent roster (archived agents are omitted; origin is included)
8. Adjust AUTO agents only so that active autos == ${autoSlots}${testAccounts.length > 0 ? "\n   — set accountRole on each new agent to a short token matching an available test account (user, instructor, admin). Keep role as a narrative description of the person" : ""}
   — give 1–2 new recruits an "environment" (mobile device, dark mode, non-default locale, slow connection) that naturally fits their persona's life; leave the rest on desktop
9. Do not retire fixed agents. Only retire autos when above the autoSlots target.`;

  try {
    const sessionTools = PERSONA_DESIGNER_TOOLS.map((t) => ({
      name: t.name,
      description: t.description ?? t.name,
      input_schema: t.input_schema as Record<string, unknown>,
      execute: async (input: Record<string, unknown>): Promise<string> => {
        let result: unknown;
        if (t.name === "get_coverage") {
          result = computeWeightedSummary().formatted;
          console.log("  [persona-designer] coverage summary fetched");
        } else if (t.name === "get_persona_templates") {
          if (!personaPack) {
            result = "(no persona templates configured — set SHOAL_PERSONAS env var or add personas.yaml to your project)";
          } else {
            result = formatPackForPrompt(personaPack);
          }
          console.log(`  [persona-designer] persona templates fetched (${personaPack?.personas.length ?? 0})`);
        } else if (t.name === "get_path_coverage") {
          if (siteMap) {
            result = formatSiteMapForPersona(siteMap, {
              recentPaths: lastRunPaths?.visitedPaths ?? [],
            });
          } else if (!lastRunPaths || lastRunPaths.visitedPaths.length === 0) {
            result = "(no path coverage data yet — this is the first run or no paths were recorded)";
          } else {
            result = `Paths visited in last run (${lastRunPaths.runId}):\n${lastRunPaths.visitedPaths.map((p) => `- ${p}`).join("\n")}\n\nRecruit agents whose role naturally takes them to paths NOT in this list.`;
          }
          console.log(`  [persona-designer] path coverage fetched (site-map=${Boolean(siteMap)}, recent=${lastRunPaths?.visitedPaths.length ?? 0})`);
        } else if (t.name === "get_finding_hotspots") {
          const hotspots = getFindingHotspots();
          if (hotspots.length === 0) {
            result = "(no past findings data yet — this appears to be the first run)";
          } else {
            result = hotspots.map((h) =>
              `${h.pathPrefix}: ${h.totalFindings} findings — ${Object.entries(h.categories).map(([c, n]) => `${c}:${n}`).join(", ")}`
            ).join("\n");
          }
          console.log(`  [persona-designer] finding hotspots fetched (${hotspots.length} areas)`);
        } else if (t.name === "get_open_issues") {
          if (openIssues.length === 0) {
            result = "(no open issues from configured tracker(s) yet)";
          } else {
            result = openIssues.map((i) => `- ${formatIssueRef(i.number)}: ${i.title} [${i.labels.join(", ")}]`).join("\n");
          }
          console.log(`  [persona-designer] open issues fetched (${openIssues.length})`);
        } else if (t.name === "get_scenarios") {
          if (scenarios.length === 0) {
            result = "(no scenarios generated — all agents will use free-exploration mode)";
          } else {
            result = scenarios.map((s) =>
              `[${s.id}] ${s.title}\n  Context: ${s.context}\n  Goal: ${s.goal}\n  Constraints: ${s.constraints}`
            ).join("\n\n");
          }
          console.log(`  [persona-designer] scenarios fetched (${scenarios.length})`);
        } else if (t.name === "get_agents") {
          const agents = loadAgents().filter((a) => (a.status ?? "active") !== "archived");
          result = agents.map((a) => ({
            id: a.id,
            name: a.name,
            role: a.role,
            accountRole: a.accountRole,
            createdAt: a.createdAt,
            origin: agentOrigin(a),
            status: a.status ?? "active",
          }));
          console.log(`  [persona-designer] current agents: ${agents.length}`);
        } else if (t.name === "add_agent") {
          const { name, role, persona, environment, accountRole } = input as {
            name?: string;
            role?: string;
            persona?: string;
            environment?: EnvironmentProfile;
            accountRole?: string;
          };
          try {
            const cleanEnv = sanitizeEnvironment(environment);
            const agent = addAgent({
              name: name ?? "",
              role: role ?? "",
              persona: persona ?? "",
              environment: cleanEnv,
              origin: "auto",
              status: "active",
              ...(accountRole?.trim() ? { accountRole: accountRole.trim() } : {}),
            });
            result = agent;
            console.log(`  [persona-designer] created: ${agent.name} (${agent.role})${agent.accountRole ? ` [accountRole: ${agent.accountRole}]` : ""}${cleanEnv ? ` [env: ${Object.entries(cleanEnv).map(([k, v]) => `${k}=${v}`).join(", ")}]` : ""}`);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            result = { error: message };
            console.log(`  [persona-designer] add_agent rejected: ${message}`);
          }
        } else if (t.name === "retire_agent") {
          const { agentId, reason } = input as { agentId: string; reason: string };
          const existing = loadAgents().find((a) => a.id === agentId);
          if (existing && isFixedAgent(existing)) {
            result = { success: false, error: "cannot retire fixed persona" };
            console.log(`  [persona-designer] retire blocked (fixed): ${agentId} — ${reason}`);
          } else {
            const success = retireAgent(agentId);
            result = success
              ? { success: true }
              : { success: false, error: "agent not found or not retiring" };
            console.log(`  [persona-designer] retired: ${agentId} — ${reason} (success=${success})`);
          }
        } else {
          result = { error: "unknown tool" };
        }
        return JSON.stringify(result);
      },
    }));

    await runToolSession({
      provider: llmProvider,
      client,
      model: defaultModel,
      system: systemPrompt,
      userPrompt: "Design and manage user personas for this run.",
      tools: sessionTools,
      maxIterations: DEFAULT_PERSONA_DESIGNER_ITERATIONS,
      maxTokens: 1024,
    });
    console.log("[persona-designer] done");
  } catch (e) {
    console.error("[persona-designer] error:", e);
  }
}

// ================================================================
// Browser agent tools
// ================================================================

function browserLogToAgentLog(
  agent: Agent,
  log: BrowserAgentLog,
  agentType: AgentLog["agentType"] = "browser",
): AgentLog {
  return {
    agentType,
    agentId: agent.id,
    agentName: log.agentName,
    role: agent.role,
    startedAt: log.startedAt,
    completedAt: log.completedAt,
    status: log.status,
    iterations: log.iterations,
    actions: log.actions.map((a) => ({
      timestamp: a.timestamp,
      tool: a.tool,
      input: a.input,
      result: null,
      durationMs: a.durationMs,
    })),
    visitedPaths: log.visitedPaths,
    issuesPosted: log.feedbacksSaved.map((f) => ({
      title: f.title,
      category: f.category,
      url: null,
    })),
    regressionChecks: log.regressionChecks ?? [],
    error: log.error,
  };
}

function applyAgentSummary(agentLog: AgentLog): void {
  runLog.summary.totalActions += agentLog.actions.length;
  if (agentLog.status === "completed") runLog.summary.completed++;
  else if (agentLog.status === "error") runLog.summary.errors++;
  if (agentLog.status === "iteration_limit") runLog.summary.iterationLimitReached++;
}

function recordBrowserAgentRun(agent: Agent, browserLog: BrowserAgentLog): void {
  const agentLog = browserLogToAgentLog(agent, browserLog, "browser");
  runLog.agents.push(agentLog);
  applyAgentSummary(agentLog);
}

function recordThresholdAgentRun(agent: Agent, browserLog: BrowserAgentLog): void {
  const agentLog = browserLogToAgentLog(agent, browserLog, "threshold");
  runLog.agents.push(agentLog);
  applyAgentSummary(agentLog);
}

function recordRegressionAgentRun(agent: Agent, browserLog: BrowserAgentLog): void {
  const agentLog = browserLogToAgentLog(agent, browserLog, "regression");
  runLog.agents.push(agentLog);
  applyAgentSummary(agentLog);
}



type BrowserAgentExtras = {
  extraTools?: Anthropic.Tool[];
  extraPrompt?: string;
  maxIterations?: number;
  closedIssues?: ClosedIssue[];
  logPrefix?: string;
};

async function runBrowserAgent(
  agent: Agent,
  page: Page,
  productSpec: ProductSpec,
  assignment: Assignment = {},
  scenarioOutcomes: ScenarioOutcome[] = [],
  authPlan: BrowserAuthPlan = { handoff: { kind: "guest" }, startPath: "/" },
  siteMap: SiteMap | null = null,
  runId: string = "",
  discoverBudget: { used: number } | null = null,
  extras: BrowserAgentExtras = {},
): Promise<BrowserAgentLog> {
  const logPrefix = extras.logPrefix ?? "browser";
  const assignmentLabel = assignment.scenario
    ? `[scenario: ${assignment.scenario.title.slice(0, 35)}]`
    : assignment.lens
    ? `[lens: ${assignment.lens.slice(0, 30)}...]`
    : "[free exploration]";
  console.log(`\n[${logPrefix}] ${agent.name} start ${assignmentLabel}`);

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
    regressionChecks: [],
    error: null,
  };

  const observation = setupObservation(page);
  const siteMapOrigin = new URL(BASE_URL).origin;
  let lastTrackedPath: string | null = null;
  let consecutiveOnPath = 0;
  const host = new URL(BASE_URL).host;
  const cachedHashes = loadPageHashes(host);
  const pageHashUpdates: Record<string, string> = {};
  const MAX_ITERATIONS = extras.maxIterations ?? browserIterations();

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
5. Finish within ${MAX_ITERATIONS} actions

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

[Using check_swarm_signals]
- Call it once mid-session to see what other agents exploring this app have reported
- If a signal matches the area you are in, try to reproduce it as YOUR persona — a finding confirmed by different personas becomes a stronger issue
- Report reproductions with post_feedback in your own words; do not copy the other agent's report

[Reference: Implemented Features]
${productSpec.features}
${productSpec.designContext ? `\n[Design Context]\n${productSpec.designContext}\n` : ""}${goalsSection(productSpec)}${assignment.actor && assignment.scenario
    ? `\n[Your Task for This Run — Two-User Scenario]\nTitle: ${assignment.scenario.title}\nSituation: ${assignment.scenario.context}\nYou are the "${assignment.actor.role}" actor. Your goal: ${assignment.actor.goal}\n\nRIGHT NOW another agent is using this app as "${assignment.actor.partnerRole}" — your actions and theirs may affect the same data at the same time.\nWhile completing your goal, pay special attention to concurrency and permission issues:\n- data that goes stale and never refreshes after the other user changes it\n- conflicting edits that silently overwrite each other\n- permission or status changes that do not take effect (or take effect inconsistently) mid-session\n- realtime updates, locks, or notifications that never arrive\nReport such issues with post_feedback (usually category "bug").\nWhen done (or if you cannot complete the goal), call post_outcome with achieved=true/false and a brief reason.`
    : assignment.scenario
    ? `\n[Your Task for This Run]\nTitle: ${assignment.scenario.title}\nYou are: ${assignment.scenario.context}\nGoal: ${assignment.scenario.goal}\nConstraints: ${assignment.scenario.constraints}\n\nFocus on completing this task naturally as this user. Report any issues you encounter along the way.\nWhen done (or if you cannot complete the goal), call post_outcome with achieved=true/false and a brief reason.`
    : assignment.lens
    ? `\n[Focus Area for This Run]\n${assignment.lens}\nKeep this perspective in mind and prioritize reporting related issues.`
    : ""}${focusPrompt()}${describeEnvironment(agent.environment)}${sessionContinuityPrompt(hasAgentSession(agent.id))}${formatAgentMemories(agent)}${guardrailPrompt(SHOAL_MODE)}${authPrompt(authPlan.handoff)}${extras.extraPrompt ?? ""}

${untrustedContentPrompt()}`;

  const startUrl = resolveLoginUrl(BASE_URL, authPlan.startPath);
  await page.goto(startUrl, { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(RUN_TIMINGS.agentStartupMs);
  const initialScreenshot = await takeScreenshot(page, "initial");

  const opening = (() => {
    switch (authPlan.handoff.kind) {
      case "credentials":
        return "The login page is open. Sign in with the exact credentials in [Authentication], then use the app. Do not invent other usernames or passwords.";
      case "guest":
        return "The app is open. Start using it. If you see a login form, do not guess usernames or passwords — explore only what is available without an account.";
      case "session":
        return authPlan.handoff.email
          ? "The app is open and you are already logged in. Start using it. Do not log out or enter different credentials."
          : "The app is open. Start using it.";
      default: {
        const _exhaustive: never = authPlan.handoff;
        return `The app is open. Start using it. (${String(_exhaustive)})`;
      }
    }
  })();

  const sessionTools = [...BROWSER_TOOLS, ...(extras.extraTools ?? [])].map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    input_schema: t.input_schema as Record<string, unknown>,
    execute: async (input: Record<string, unknown>): Promise<ToolResultContent> => {
      const { text, screenshot, sendToClaude } = await executeBrowserTool(t.name, input, {
        ...browserToolBaseContext(),
        page,
        agentId: agent.id,
        agentLog,
        observation,
        scenarioOutcomes,
        cachedHashes,
        pageHashUpdates,
        scenario: assignment.scenario,
        closedIssues: extras.closedIssues ?? [],
      });
      console.log(`  → ${formatToolCallLog(t.name, input, 60)}`);

      if (siteMap) {
        try {
          const currentPath = normalizePath(page.url(), siteMapOrigin);
          if (currentPath) {
            const isNewEntry = currentPath !== lastTrackedPath;
            if (isNewEntry) {
              lastTrackedPath = currentPath;
              consecutiveOnPath = 1;
            } else {
              consecutiveOnPath += 1;
            }
            recordVisit(siteMap, currentPath, runId || runLog.runId, {
              isNewEntry,
              consecutiveIterations: consecutiveOnPath,
            });
          }
          if (t.name === "navigate" && discoverBudget) {
            const hrefs = await collectSameOriginHrefs(page, siteMapOrigin);
            const normalized = hrefs
              .map((h) => normalizePath(h, siteMapOrigin))
              .filter((p): p is string => Boolean(p));
            const ingested = ingestDiscoveredPaths(siteMap, normalized, {
              runBudget: MAX_DISCOVERED_PER_RUN,
              usedBudget: discoverBudget.used,
            });
            discoverBudget.used = ingested.usedBudget;
          }
        } catch (e) {
          console.warn(`  [site-map] visit/discover update failed:`, e);
        }
      }

      return sendToClaude && screenshot
        ? [
            { type: "text", text },
            { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot.base64 } },
          ]
        : text;
    },
  }));

  try {
    const result = await runToolSession({
      provider: llmProvider,
      client,
      model: defaultModel,
      system: systemPrompt,
      userPrompt: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: initialScreenshot.base64 } },
        { type: "text", text: opening },
      ],
      tools: sessionTools,
      maxIterations: MAX_ITERATIONS,
      maxTokens: 1024,
      onAfterTools: ({ results, iteration, maxIterations }) => {
        agentLog.iterations = iteration;
        if (iteration >= maxIterations) agentLog.status = "iteration_limit";

        const remaining = maxIterations - iteration;
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

        const last = results[results.length - 1];
        if (!last) return;
        const lastContent = last.content;
        results[results.length - 1] = {
          ...last,
          content:
            typeof lastContent === "string"
              ? `${lastContent}\n\n${budgetHint}`
              : ([...(lastContent as unknown[]), { type: "text" as const, text: budgetHint }] as Anthropic.ToolResultBlockParam["content"]),
        };
      },
    });
    agentLog.iterations = result.iterations;
    if (agentLog.status !== "iteration_limit") agentLog.status = "completed";
    if (result.iterations >= MAX_ITERATIONS) agentLog.status = "iteration_limit";
  } catch (e) {
    agentLog.status = "error";
    agentLog.error = String(e);
    console.error(`[${agent.name}] error:`, e);
  } finally {
    agentLog.completedAt = new Date().toISOString();
    updatePageHashes(host, pageHashUpdates);
  }

  console.log(`[${logPrefix}] ${agent.name} done (feedback: ${agentLog.feedbacksSaved.length})`);
  return agentLog;
}

function formatThresholdCandidatesForPrompt(candidates: ThresholdCandidate[]): string {
  if (candidates.length === 0) return "(none assigned)";
  return candidates
    .map(
      (c, i) =>
        `${i + 1}. [${c.kind}/p${c.priority}] id=${c.id}\n` +
        `   area: ${c.area}\n` +
        `   signal: ${c.signal}\n` +
        `   howToProbe: ${c.howToProbe}`,
    )
    .join("\n");
}

function makeRegressionProber(): Agent {
  return {
    id: `agent_regression_${Date.now()}`,
    name: "Regression QA",
    role: "qa",
    persona:
      "A careful QA engineer who re-tests closed issues in the real UI. Verifies fixes by reproducing the original steps in the browser. Does not mark a UI bug as verified from API responses alone.",
    createdAt: new Date().toISOString(),
    origin: "auto",
    status: "active",
    accountRole: "user",
  };
}

function makeThresholdProbers(count: number): Agent[] {
  const now = new Date().toISOString();
  return Array.from({ length: count }, (_, i) => ({
    id: `agent_threshold_${i + 1}`,
    name: count === 1 ? "Threshold Prober" : `Threshold Prober ${i + 1}`,
    role: "threshold-prober",
    persona:
      "A careful boundary probe who pushes limits the way a power user would — form maxima, plan quotas, permission edges, and moments where the experience falls apart — then reports what actually broke or felt ambiguous. Does not invent findings when the boundary behaves clearly.",
    createdAt: now,
  }));
}

function pickThresholdAuthRole(testAccounts: TestAccount[], fallbackRole: string): string {
  return testAccounts[0]?.role ?? fallbackRole;
}

async function runThresholdAgent(
  agent: Agent,
  page: Page,
  productSpec: ProductSpec,
  candidates: ThresholdCandidate[],
  authPlan: BrowserAuthPlan = { handoff: { kind: "guest" }, startPath: "/" },
): Promise<BrowserAgentLog> {
  console.log(`\n[threshold] ${agent.name} start (${candidates.length} candidate(s))`);

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
    regressionChecks: [],
    error: null,
  };

  const observation = setupObservation(page);
  const host = new URL(BASE_URL).host;
  const cachedHashes = loadPageHashes(host);
  const pageHashUpdates: Record<string, string> = {};
  const MAX_ITERATIONS = thresholdIterations();

  const systemPrompt = `You are "${agent.name}".
Role: ${agent.role}
Persona: ${agent.persona}

You probe boundaries of "${productSpec.appName}" — not free exploration.
Work through your assigned threshold candidates. Prefer evidence over speculation.

[App Overview]
${productSpec.appDescription}

[Assigned Threshold Candidates]
${formatThresholdCandidatesForPrompt(candidates)}

[How to Proceed]
1. Pick the highest-priority remaining candidate
2. Navigate to its area; if needed, use [API check] tools to seed a near-limit state
3. Follow howToProbe in the browser (fill/click/select as a real user would)
4. If the boundary crashes, silently fails, loses data, or shows an unclear/wrong message — report with post_feedback
5. If the boundary behaves clearly and safely, do NOT invent a finding — move to the next candidate
6. If an area does not exist, skip that candidate
7. Finish after probing your list (within ${MAX_ITERATIONS} actions)

When writing the body, match the tone to the category:
- bug: technical ("Submitting 501 chars returned 500 with no validation...", "Expected a 403 at the plan limit but the create succeeded")
- ux: experiential ("I hit the seat limit and had no idea what to do next...", "The error appeared after I left the field and I could not tell which limit I crossed")
- feature-request / goal-gap: only if a missing affordance at the boundary clearly blocks a user outcome

[Using Observation Tools]
- After probing, call diff_since_last_action / read_network_errors / read_console_logs when the UI reaction is unclear
- Use check_swarm_signals once mid-session; if another agent reported something in your area, try to reproduce it as a threshold probe and report in your own words

[Reference: Implemented Features]
${productSpec.features}
${productSpec.designContext ? `\n[Design Context]\n${productSpec.designContext}\n` : ""}${goalsSection(productSpec)}${guardrailPrompt(SHOAL_MODE)}${authPrompt(authPlan.handoff)}

${untrustedContentPrompt()}`;

  const startUrl = resolveLoginUrl(BASE_URL, authPlan.startPath);
  await page.goto(startUrl, { waitUntil: "load", timeout: 15000 });
  await page.waitForTimeout(RUN_TIMINGS.agentStartupMs);
  const initialScreenshot = await takeScreenshot(page, "initial");

  const opening = (() => {
    switch (authPlan.handoff.kind) {
      case "credentials":
        return "The login page is open. Sign in with the exact credentials in [Authentication], then probe your assigned thresholds. Do not invent other usernames or passwords.";
      case "guest":
        return "The app is open. Start probing your assigned thresholds. If you see a login form, do not guess usernames or passwords — probe only what is available without an account.";
      case "session":
        return "The app is open and you are already logged in. Start probing your assigned thresholds.";
      default: {
        const _exhaustive: never = authPlan.handoff;
        return `The app is open. Start probing. (${String(_exhaustive)})`;
      }
    }
  })();

  const sessionTools = BROWSER_TOOLS.map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    input_schema: t.input_schema as Record<string, unknown>,
    execute: async (input: Record<string, unknown>): Promise<ToolResultContent> => {
      const { text, screenshot, sendToClaude } = await executeBrowserTool(t.name, input, {
        ...browserToolBaseContext(),
        page,
        agentId: agent.id,
        agentLog,
        observation,
        scenarioOutcomes: [],
        cachedHashes,
        pageHashUpdates,
        closedIssues: [],
      });
      console.log(`  → ${formatToolCallLog(t.name, input, 60)}`);

      return sendToClaude && screenshot
        ? [
            { type: "text", text },
            { type: "image", source: { type: "base64", media_type: "image/png", data: screenshot.base64 } },
          ]
        : text;
    },
  }));

  try {
    const result = await runToolSession({
      provider: llmProvider,
      client,
      model: defaultModel,
      system: systemPrompt,
      userPrompt: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: initialScreenshot.base64 } },
        { type: "text", text: opening },
      ],
      tools: sessionTools,
      maxIterations: MAX_ITERATIONS,
      maxTokens: 1024,
      onAfterTools: ({ results, iteration, maxIterations }) => {
        agentLog.iterations = iteration;
        if (iteration >= maxIterations) agentLog.status = "iteration_limit";

        const remaining = maxIterations - iteration;
        let budgetHint = `[${remaining} turns remaining]`;
        if (remaining <= 2) {
          budgetHint += " Last turns. Post any remaining threshold findings with post_feedback, then finish.";
        } else if (remaining <= 4) {
          budgetHint += " Start wrapping up remaining candidates.";
        }

        const PROGRESS_TOOLS = new Set(["navigate", "fill", "post_feedback"]);
        const recent = agentLog.actions.slice(-5).map((a) => a.tool);
        if (recent.length >= 5 && !recent.some((t) => PROGRESS_TOOLS.has(t))) {
          budgetHint += " You seem stuck. Move to the next threshold candidate or a different area.";
        }

        const observationWarning = buildObservationWarning(observation);
        if (observationWarning) {
          budgetHint += `\n\n${observationWarning}\nUse read_console_logs or read_network_errors for details.`;
        }

        const last = results[results.length - 1];
        if (!last) return;
        const lastContent = last.content;
        results[results.length - 1] = {
          ...last,
          content:
            typeof lastContent === "string"
              ? `${lastContent}\n\n${budgetHint}`
              : ([...(lastContent as unknown[]), { type: "text" as const, text: budgetHint }] as Anthropic.ToolResultBlockParam["content"]),
        };
      },
    });
    agentLog.iterations = result.iterations;
    if (agentLog.status !== "iteration_limit") agentLog.status = "completed";
    if (result.iterations >= MAX_ITERATIONS) agentLog.status = "iteration_limit";
  } catch (e) {
    agentLog.status = "error";
    agentLog.error = String(e);
    console.error(`[${agent.name}] error:`, e);
  } finally {
    agentLog.completedAt = new Date().toISOString();
    updatePageHashes(host, pageHashUpdates);
  }

  console.log(`[threshold] ${agent.name} done (feedback: ${agentLog.feedbacksSaved.length})`);
  return agentLog;
}

// ================================================================
// Main
// ================================================================

// verify モード: 検証専用エージェント 1 体で finding の再現を試み、結果を JSON に書き出す
async function runVerifyMode(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  productSpec: ProductSpec,
  scenarioOutcomes: ScenarioOutcome[],
  finding: VerifyFinding,
): Promise<void> {
  console.log(`\n[verify] verifying fix for: "${finding.title}"`);
  runLog.summary.totalAgents = 1;

  const verifier: Agent = {
    id: "agent_verifier",
    name: "Verifier",
    role: "qa",
    persona: "A meticulous QA engineer who verifies whether previously reported issues are actually fixed. Skeptical by nature — retraces the exact flow that caused the problem before concluding anything.",
    createdAt: new Date().toISOString(),
  };

  const scenario: Scenario = {
    id: "verify",
    title: `Verify fix: ${finding.title}`,
    context: "You are verifying whether a previously reported issue has been fixed in the current build.",
    goal: `Try hard to reproduce this previously reported issue:\n---\nTitle: ${finding.title}\n${finding.body}\n---\nRetrace the same flow that caused it. If the issue NO LONGER occurs after a genuine attempt, the fix is verified — call post_outcome with achieved=true. If it still occurs (even partially), call post_outcome with achieved=false and describe exactly what still happens.`,
    constraints: "Focus only on verifying this one issue. Do not explore unrelated areas.",
  };

  const context = await browser.newContext({ viewport: VIEWPORT });
  await applyBrowserGuardrails(context, SHOAL_MODE);
  const page = await context.newPage();
  try {
    const browserLog = await runBrowserAgent(verifier, page, productSpec, { scenario }, scenarioOutcomes);
    recordBrowserAgentRun(verifier, browserLog);
  } finally {
    await context.close();
  }

  const outcome = scenarioOutcomes[0];
  const result = {
    findingId: finding.id,
    findingTitle: finding.title,
    runId: runLog.runId,
    status: outcome ? (outcome.achieved ? "fixed" : "still_broken") : "inconclusive",
    reason: outcome?.reason ?? "The verifier agent did not report an outcome.",
    verifiedAt: new Date().toISOString(),
  };
  const outPath = path.join(process.cwd(), "logs", `verify_${runLog.runId}.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\n[verify] ${result.status}: ${result.reason}`);
  console.log(`[verify] result saved: ${outPath}`);
}

export async function main() {
  initDirs();
  // logs/screenshots/run_* と logs/traces/run_* の古いディレクトリを削除する
  // （SHOAL_RETENTION_DAYS、デフォルト30日。0で無効化）
  const retentionDays = getRetentionDays();
  const prunedCount = pruneRunArtifacts(process.cwd(), retentionDays);
  if (prunedCount > 0) {
    console.log(`[retention] removed ${prunedCount} run artifact director(ies) older than ${retentionDays} day(s)`);
  }
  // run log を最初期化しておくことで、どの段階でエラーが起きても finally で saveRunLog() が動く
  initRunLog(0, process.env.GITHUB_REPO ?? "");

  // SHOAL_MAX_USD の推定コスト上限。超えた時点で以降の LLM 呼び出しを止める
  initBudget();
  const budgetLine = budgetStatusLine();
  if (budgetLine) console.log(budgetLine);
  // 価格表を先に読み込む（OpenRouter は実行時取得なので、これが無いと上限が無言で効かない）
  const budgetWarning = await prepareBudget(defaultModel, llmProvider);
  if (budgetWarning) console.warn(budgetWarning);

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
      const discoveryContext = await browser.newContext({ viewport: VIEWPORT });
      const discoveryPage = await discoveryContext.newPage();
      productSpec = await discoverProduct(BASE_URL, discoveryPage, client, defaultModel, targetConfig.projectPath);
      await discoveryContext.close();
    }

    // verify モード: 単一 finding の検証だけを行い、通常のパイプラインはスキップ
    if (VERIFY_FINDING) {
      await runVerifyMode(browser, productSpec, scenarioOutcomes, VERIFY_FINDING);
      return;
    }

    // 2. adoption feedback — 過去に起票した issue の close 状況を群れに還元する
    const closedIssues = await trackers.fetchClosedIssues();
    const adoptionSummary = updateAdoption(closedIssues);
    if (adoptionSummary) console.log(`\n[adoption] ${adoptionSummary.split("\n")[1] ?? ""}`);

    // 3. org design (coverage + adoption aware)
    const coverageSummary = computeWeightedSummary();
    console.log(`\n[coverage] ${coverageSummary.formatted.split("\n")[0]}`);
    const designContext = adoptionSummary
      ? `${coverageSummary.formatted}\n\n${adoptionSummary}`
      : coverageSummary.formatted;
    const orgDesign = await designOrg(productSpec, client, defaultModel, designContext);

    // 4. open issues
    const openIssues = await trackers.fetchOpenIssues();

    // 4.5. Account Manager
    // シナリオ設計より先に実行し、利用可能な role をマルチアクターシナリオ生成に渡す。
    // シードは shoal.config の credentials、なければ test-accounts/accounts.json。
    let testAccounts: TestAccount[] = [];
    const accountPlan = resolveAccountSetup(targetConfig.credentials);
    for (const line of accountPlan.logs) console.log(line);
    switch (accountPlan.action) {
      case "run": {
        const accountContext = await browser.newContext({ viewport: VIEWPORT });
        try {
          testAccounts = await runAccountManager(
            BASE_URL,
            accountPlan.seed,
            productSpec,
            accountContext,
            client,
            defaultModel,
            runLog.runId,
            accountPlan.existing,
          );
        } finally {
          await accountContext.close();
        }
        break;
      }
      case "skip": {
        testAccounts = accountPlan.existing;
        break;
      }
      case "persist": {
        const accountContext = await browser.newContext({ viewport: VIEWPORT });
        try {
          testAccounts = await persistAccountSessions(
            BASE_URL,
            resolveLoginPath(productSpec),
            accountContext,
            accountPlan.existing,
          );
        } finally {
          await accountContext.close();
        }
        break;
      }
      default: {
        const _exhaustive: never = accountPlan;
        throw new Error(`unhandled account setup action: ${String(_exhaustive)}`);
      }
    }
    // trace-scrub: 既知の秘匿値（テストアカウントのパスワード）を登録しておき、
    // 以降 tracing.stop() で保存される zip から確実に除去できるようにする
    registerSecrets(testAccounts.map((a) => a.password));
    registerSecrets([targetConfig.credentials?.password]);

    // 4.8. scenario design（role が 2 つ以上あればマルチアクターシナリオも生成される）
    const scenarioContext = FOCUS_PATHS.length > 0
      ? `${designContext}\n\n[Focus Paths]\nRecent code changes affect: ${FOCUS_PATHS.join(", ")} — bias scenarios toward journeys that pass through these areas.`
      : designContext;
    const scenarios = await designScenarios(
      productSpec, openIssues, client, defaultModel, 5, scenarioContext,
      testAccounts.map((a) => a.role),
    );

    // 5. Site map seed (shared across browser agents; saved once at end)
    const siteMapOrigin = new URL(BASE_URL).origin;
    const sharedSiteMap = loadSiteMap(siteMapOrigin);
    const sitemapSeed = await seedFromSitemap(sharedSiteMap);
    for (const w of sitemapSeed.warnings) console.warn(`  [site-map] ${w}`);
    if (sitemapSeed.seeded > 0) console.log(`  [site-map] seeded ${sitemapSeed.seeded} paths from sitemap`);
    console.log(`  ${formatSiteMapLogLine(sharedSiteMap)}`);
    const discoverBudget = { used: 0 };

    // 5.5 HR agent
    // 5.5 HR agent — fixed members first, then align autos to autoSlots
    const preFixed = partitionActiveAgents(loadAgents()).fixed;
    const slots = computeRosterSlots({
      maxBrowsers: MAX_BROWSERS,
      maxExplorers: MAX_EXPLORERS,
      fixedCount: preFixed.length,
    });
    if (slots.maxBrowsers !== MAX_BROWSERS || slots.maxExplorers !== MAX_EXPLORERS) {
      console.log(
        `[roster] bumping caps for fixed members: browsers ${MAX_BROWSERS}→${slots.maxBrowsers}, explorers ${MAX_EXPLORERS}→${slots.maxExplorers} (fixed=${slots.F}, N=${slots.N}, effectiveN=${slots.effectiveN})`,
      );
      MAX_BROWSERS = slots.maxBrowsers;
      MAX_EXPLORERS = slots.maxExplorers;
    } else {
      console.log(
        `[roster] fixed=${slots.F} autoSlots=${slots.autoSlots} (N=${slots.N}, effectiveN=${slots.effectiveN})`,
      );
    }

    const lastRunPaths = getLastRunPaths();
    const personaPack = await loadPersonaPack();
    await runPersonaDesigner(
      productSpec,
      orgDesign.personaGuidance,
      openIssues,
      scenarios,
      testAccounts,
      lastRunPaths,
      personaPack,
      sharedSiteMap,
      slots.autoSlots,
    );

    // 6. Deterministic run roster (surplus autos excluded even if HR over-recruited)
    const { fixed, autos } = partitionActiveAgents(loadAgents());
    const runRoster = buildRunRoster({ fixed, autos, autoSlots: slots.autoSlots });
    if (runRoster.length === 0) {
      console.error("No agents found. Check agents.json or create fixed personas in the dashboard.");
      process.exit(1);
    }

    const { explorers: explorerAgents, browsers: browserAgents } =
      splitRosterForDispatch(runRoster, { maxBrowsers: MAX_BROWSERS, maxExplorers: MAX_EXPLORERS });

    // 6.5. roster サイズを記録（実際に走った agent 数は run 終了時に runLog.agents.length で確定）
    runLog.summary.totalAgents = runRoster.length;
    console.log(
      `\nroster: ${runRoster.length} (fixed ${fixed.length} + auto ${Math.min(autos.length, slots.autoSlots)})`,
    );
    console.log(`explorers: ${explorerAgents.length} (max: ${MAX_EXPLORERS}) / browsers: ${browserAgents.length} (max: ${MAX_BROWSERS})`);

    // agentId → assignment（coverage 計算・レポート生成に使う）
    const agentAssignments = new Map<string, Assignment>();

    // 通常ディスパッチにはマルチアクターを除いた単独シナリオを使う
    const dispatchScenarios = dispatchableSoloScenarios(scenarios);

    // シナリオ/レンズ割り当てのグローバルカウンタ（7:3 比率）
    let dispatchIdx = 0;

    const CONCURRENCY = explorerConcurrency();
    for (let i = 0; i < explorerAgents.length; i += CONCURRENCY) {
      if (isBudgetExceeded()) {
        console.log(`\n${budgetStopLine()}`);
        break;
      }
      const batch = explorerAgents.slice(i, i + CONCURRENCY);
      await Promise.all(batch.map((agent) => {
        const assignment = pickAssignment(dispatchIdx++, dispatchScenarios, "explorer");
        agentAssignments.set(agent.id, assignment);
        return runExplorer(agent, productSpec, assignment, scenarioOutcomes);
      }));
      if (i + CONCURRENCY < explorerAgents.length) {
        console.log("\n[batch done] waiting 5s before next batch...");
        await sleep(RUN_TIMINGS.betweenExplorerBatchesMs);
      }
    }

    if (closedIssues.length === 0) {
      console.log("\n[regression] no closed issues — skipped");
    } else if (MAX_BROWSERS === 0 && MAX_EXPLORERS > 0) {
      const { api } = partitionClosedIssues(closedIssues);
      const skippedUi = closedIssues.length - api.length;
      if (skippedUi > 0) {
        console.log(`\n[regression] skipping ${skippedUi} UI-only issue(s) — API lane cannot verify them`);
      }
      if (api.length > 0) {
        await sleep(RUN_TIMINGS.beforeRegressionMs);
        await runRegressionAgent(makeRegressionProber(), api, productSpec);
      } else {
        console.log("\n[regression] skipped (no API-verifiable closed issues)");
      }
    } else if (MAX_BROWSERS === 0) {
      console.log("\n[regression] skipped (no browser or explorer lane)");
    } else {
      console.log(`\n[regression] will run in the browser lane (${closedIssues.length} closed issue(s))`);
    }

    // 8. browser agents
    const multiScenario = findMultiActorScenario(scenarios);
    console.log(`\nlaunching ${browserAgents.length} browser agents in parallel (max: ${MAX_BROWSERS})`);
    browserAgents.forEach((a) => console.log(`  - ${a.name} (${a.role}) [${agentOrigin(a)}]`));

    // マルチアクターシナリオ: ペルソナ role と actor / テストアカウント role が合う 2 体を同時操作させる
    const pairAssignments = new Map<string, Assignment>();
    if (multiScenario?.actors && browserAgents.length >= 2) {
      const paired = pairAgentsToActors(browserAgents, multiScenario);
      for (const [agentId, actor] of paired) {
        pairAssignments.set(agentId, { scenario: multiScenario, actor });
      }
      const pairLabel = [...paired.entries()].map(([id, actor]) => {
        const agent = browserAgents.find((a) => a.id === id);
        return `${agent?.name ?? id} (${agent?.role}) as ${actor.role}`;
      }).join(" × ");
      console.log(`[multi-actor] "${multiScenario.title}" — ${pairLabel}`);
    }

    await sleep(RUN_TIMINGS.beforeBrowserLaneMs);

    // コスト上限に達していたら、以降のレーンは起動せずスキップする
    const budgetStopped = isBudgetExceeded();
    if (budgetStopped) console.log(`\n${budgetStopLine()}`);

    const thresholdCandidates = sortThresholdCandidates(
      normalizeThresholdCandidates(productSpec.thresholdCandidates),
    );
    let thresholdAgents: Agent[] = [];
    let thresholdSlices: ThresholdCandidate[][] = [];
    if (budgetStopped) {
      console.log("\n[threshold] skipped (spend cap reached)");
    } else if (MAX_THRESHOLDS <= 0) {
      console.log("\n[threshold] skipped (MAX_THRESHOLDS=0)");
    } else if (thresholdCandidates.length === 0) {
      console.log("\n[threshold] skipped (no thresholdCandidates — set REFRESH_SPEC=1 to rediscover)");
    } else {
      const m = Math.min(MAX_THRESHOLDS, thresholdCandidates.length);
      thresholdAgents = makeThresholdProbers(m);
      thresholdSlices = assignThresholdCandidates(thresholdCandidates, m);
      console.log(`\nlaunching ${thresholdAgents.length} threshold agents in parallel with browsers (max: ${MAX_THRESHOLDS})`);
      thresholdAgents.forEach((a, i) =>
        console.log(`  - ${a.name} (${thresholdSlices[i]?.length ?? 0} candidate(s))`),
      );
    }

    type LaneResult =
      | { kind: "browser"; agent: Agent; log: BrowserAgentLog }
      | { kind: "threshold"; agent: Agent; log: BrowserAgentLog }
      | { kind: "regression"; agent: Agent; log: BrowserAgentLog };

    const browserJobs = (budgetStopped ? [] : browserAgents).map(async (agent): Promise<LaneResult> => {
        const assignment = pairAssignments.get(agent.id) ?? pickAssignment(dispatchIdx++, dispatchScenarios, "browser");
        agentAssignments.set(agent.id, assignment);

        const accountRole = assignment.actor?.role ?? resolveAgentAccountRole(agent);
        const authPlan = planBrowserAuth({
          testAccounts,
          accountRole,
          loginPath: resolveLoginPath(productSpec),
          returningSessionPath: hasAgentSession(agent.id) ? agentSessionPath(agent.id) : undefined,
          preferAccountSession: Boolean(assignment.actor),
        });
        console.log(describeAuthPlan(agent.name, authPlan));
        const baseOptions: Parameters<typeof browser.newContext>[0] = {
          viewport: VIEWPORT,
        };
        if (authPlan.storageStatePath) {
          baseOptions.storageState = authPlan.storageStatePath;
          if (!assignment.actor && hasAgentSession(agent.id)) {
            console.log(`[session] ${agent.name} returns with their previous session`);
          }
        }
        // ペルソナの環境プロファイル（デバイス・ロケール・配色）を重ねる
        const contextOptions = buildContextOptions(agent.environment, baseOptions);

        const context = await browser.newContext(contextOptions);
        await applyBrowserGuardrails(context, SHOAL_MODE);
        if (TRACE_ENABLED) {
          try {
            await context.tracing.start({ screenshots: true, snapshots: true });
          } catch (e) {
            console.warn(`[trace] failed to start for ${agent.name}:`, e);
          }
        }
        const page = await context.newPage();
        await applyNetworkThrottle(page, agent.environment?.networkThrottle);
        try {
          const log = await runBrowserAgent(agent, page, productSpec, assignment, scenarioOutcomes, authPlan, sharedSiteMap, runLog.runId, discoverBudget);
          return { kind: "browser", agent, log };
        } finally {
          // 次の run で「再訪ユーザー」になれるようセッションを保存（close 前に呼ぶ）
          await saveAgentSession(context, agent.id);
          if (TRACE_ENABLED) {
            const tracePath = traceAgentZipPath(runLog.runId, agent.id);
            try {
              fs.mkdirSync(path.dirname(tracePath), { recursive: true });
              await context.tracing.stop({ path: tracePath });
              await scrubTraceZipSafely(tracePath, `agent trace ${agent.name}`);
            } catch (e) {
              console.warn(`[trace] failed to save for ${agent.name}:`, e);
            }
          }
          await context.close();
        }
      });

    const thresholdJobs = thresholdAgents.map(async (agent, i): Promise<LaneResult> => {
      const slice = thresholdSlices[i] ?? [];
      const accountRole = pickThresholdAuthRole(testAccounts, agent.role);
      const authPlan = planBrowserAuth({
        testAccounts,
        accountRole,
        loginPath: resolveLoginPath(productSpec),
        returningSessionPath: undefined,
        preferAccountSession: false,
      });
      console.log(describeAuthPlan(agent.name, authPlan));
      const baseOptions: Parameters<typeof browser.newContext>[0] = {
        viewport: VIEWPORT,
      };
      if (authPlan.storageStatePath) {
        baseOptions.storageState = authPlan.storageStatePath;
      }
      const context = await browser.newContext(baseOptions);
      await applyBrowserGuardrails(context, SHOAL_MODE);
      if (TRACE_ENABLED) {
        try {
          await context.tracing.start({ screenshots: true, snapshots: true });
        } catch (e) {
          console.warn(`[trace] failed to start for ${agent.name}:`, e);
        }
      }
      const page = await context.newPage();
      try {
        const log = await runThresholdAgent(agent, page, productSpec, slice, authPlan);
        return { kind: "threshold", agent, log };
      } finally {
        // ephemeral — do not saveAgentSession
        if (TRACE_ENABLED) {
          const tracePath = traceAgentZipPath(runLog.runId, agent.id);
          try {
            fs.mkdirSync(path.dirname(tracePath), { recursive: true });
            await context.tracing.stop({ path: tracePath });
            await scrubTraceZipSafely(tracePath, `agent trace ${agent.name}`);
          } catch (e) {
            console.warn(`[trace] failed to save for ${agent.name}:`, e);
          }
        }
        await context.close();
      }
    });

    const regressionJobs: Promise<LaneResult>[] = [];
    if (!budgetStopped && MAX_BROWSERS > 0 && closedIssues.length > 0) {
      const regressionAgent = makeRegressionProber();
      console.log(`\nlaunching regression in the browser lane (${closedIssues.length} closed issue(s), ${regressionMaxIterations(closedIssues.length)} turns)`);
      regressionJobs.push((async (): Promise<LaneResult> => {
        const accountRole = pickThresholdAuthRole(testAccounts, regressionAgent.accountRole ?? "user");
        const authPlan = planBrowserAuth({
          testAccounts,
          accountRole,
          loginPath: resolveLoginPath(productSpec),
          returningSessionPath: undefined,
          preferAccountSession: false,
        });
        console.log(describeAuthPlan(regressionAgent.name, authPlan));
        const baseOptions: Parameters<typeof browser.newContext>[0] = {
          viewport: VIEWPORT,
        };
        if (authPlan.storageStatePath) {
          baseOptions.storageState = authPlan.storageStatePath;
        }
        const context = await browser.newContext(baseOptions);
        await applyBrowserGuardrails(context, SHOAL_MODE);
        if (TRACE_ENABLED) {
          try {
            await context.tracing.start({ screenshots: true, snapshots: true });
          } catch (e) {
            console.warn(`[trace] failed to start for ${regressionAgent.name}:`, e);
          }
        }
        const page = await context.newPage();
        try {
          const log = await runBrowserAgent(
            regressionAgent,
            page,
            productSpec,
            {},
            scenarioOutcomes,
            authPlan,
            sharedSiteMap,
            runLog.runId,
            discoverBudget,
            {
              extraTools: [REPORT_REGRESSION_TOOL, MARK_VERIFIED_TOOL],
              extraPrompt: `

[Regression Task]
You are a regression tester in the BROWSER lane. Re-open each closed issue in a real browser and confirm the UI still behaves as expected.

Closed issues to check:
${closedIssues.map((i) => `- ${i.number}: ${i.title}\n  ${(i.body ?? "").slice(0, 200).replace(/\n/g, " ")}`).join("\n")}

Rules:
- Use browser tools (snapshot, click, fill, select, navigate). Never mark a UI bug verified or regressed from API calls alone.
- If an issue is clearly API-only (no UI surface), skip it rather than inventing a UI check.
- Call report_regression when a previously-fixed bug is back. Call mark_verified when the UI still looks fixed.
- Cover as many issues as you can. Prefer checking every issue over stopping early.`,
              maxIterations: regressionMaxIterations(closedIssues.length),
              closedIssues,
              logPrefix: "regression",
            },
          );
          return { kind: "regression", agent: regressionAgent, log };
        } finally {
          if (TRACE_ENABLED) {
            const tracePath = traceAgentZipPath(runLog.runId, regressionAgent.id);
            try {
              fs.mkdirSync(path.dirname(tracePath), { recursive: true });
              await context.tracing.stop({ path: tracePath });
              await scrubTraceZipSafely(tracePath, `agent trace ${regressionAgent.name}`);
            } catch (e) {
              console.warn(`[trace] failed to save for ${regressionAgent.name}:`, e);
            }
          }
          await context.close();
        }
      })());
    }

    const laneResults = await Promise.all([...browserJobs, ...thresholdJobs, ...regressionJobs]);
    const allVisitedPaths = laneResults.flatMap((r) => r.log.visitedPaths);
    saveSiteMap(sharedSiteMap);
    console.log(`  ${formatSiteMapLogLine(sharedSiteMap)}`);
    for (const result of laneResults) {
      switch (result.kind) {
        case "browser":
          recordBrowserAgentRun(result.agent, result.log);
          break;
        case "threshold":
          recordThresholdAgentRun(result.agent, result.log);
          break;
        case "regression":
          recordRegressionAgentRun(result.agent, result.log);
          break;
        default: {
          const _exhaustive: never = result;
          throw new Error(`unhandled lane result: ${String(_exhaustive)}`);
        }
      }
    }
    runLog.summary.totalAgents = runLog.agents.length;

    const reconciled = reconcileMultiActorOutcomes(scenarioOutcomes, scenarios);
    scenarioOutcomes.length = 0;
    scenarioOutcomes.push(...reconciled);

    // 9. triage (API + browser + threshold findings)
    await sleep(RUN_TIMINGS.beforeTriageMs);
    console.log(`\n[triage] collected findings: ${collectedFindings.length}`);
    let triageResult: TriageResult = {
      issued: [], skipped: [], unprocessed: [], issuesCreated: 0, edgeRisks: [], issues: [], skips: [],
    };
    if (isBudgetExceeded()) {
      // 起票せずに終える。findings は保存済みで、レポートと triage-only で後から処理できる
      console.log("[triage] skipped (spend cap reached) — findings are saved; run `shoal triage` after raising SHOAL_MAX_USD");
      triageResult.unprocessed = collectedFindings.map((f) => f.title);
    } else {
      try {
        triageResult = await runTriageAgent(collectedFindings, client, defaultModel, trackers, agentAssignments, productSpec.productEdge);
        runLog.summary.totalIssuesPosted += triageResult.issuesCreated;
      } catch (e) {
        console.error("[triage] error:", e);
      }
    }

    // 10. record each agent's personal memory (frustrations / achievements)
    const memoryInputs = buildMemoryInputs(
      runLog.agents.map((log) => log.agentId),
      scenarioOutcomes,
      collectedFindings,
    );
    recordAgentMemories(runLog.runId, memoryInputs);

    // 11. update coverage (report が最新スコアを含められるよう先に更新する)
    updateCoverage(runLog.runId, collectedFindings, agentAssignments, allVisitedPaths, {
      scenarioOutcomes,
      regression: {
        checked: runLog.summary.regressionChecked,
        regressed: runLog.summary.regressionFailed,
      },
    });

    // 12. experience score + HTML report
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
  console.log(`  ${formatIssuesCreatedLine(trackers.enabledNames(), runLog.summary.totalIssuesPosted)}`);
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

/**
 * Handles a fatal error from main(): always sets a non-zero exit code so a
 * run that never started (a browser-launch failure, a config error, anything
 * that isn't the expected BudgetExceededError) is reported as a failure —
 * exported so this is testable without launching a real agent swarm.
 */
export function handleFatalRunError(e: unknown): void {
  if (e instanceof BudgetExceededError) {
    console.error(`\n${e.message}`);
    console.error("Raise SHOAL_MAX_USD (or unset it) to continue exploring.");
    process.exitCode = 1;
    return;
  }
  console.error(e);
  process.exitCode = 1;
}

// Guarded so run.ts can be imported (e.g. by a unit test exercising one of its
// exported helpers) without launching a real agent swarm against BASE_URL.
// Unlike server/index.ts and server/mcp.ts, this had no such guard: importing
// this module for any reason — even just to reuse a pure function — used to
// spawn a live Playwright browser and start exploring.
if (process.env.NODE_ENV !== "test") {
  main().catch(handleFatalRunError);
}
