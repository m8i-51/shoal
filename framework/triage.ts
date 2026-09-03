import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import type { LLMClient } from "./llm-client";
import type { Finding } from "./types";
import { runToolSession } from "./tool-session";
import type { IssueTracker } from "./trackers/index";
import { recordIssueLink } from "./adoption";
import { commentReturningUserReReports } from "./triage-rereport";
import { formatIssueRef } from "./issue-id";
import {
  EDGE_RISK_LABEL,
  canCarryEdgeRisk,
  formatEdgeRiskSection,
  formatProductEdgeForPrompt,
  normalizeEdgeRisk,
  type ProductEdge,
} from "./product-edge";

/**
 * Wraps `@word` in backticks so an LLM-written issue body can't ping a real
 * GitHub user or team by accident (or by an app it read prompting it to).
 * Skips anything already inside backticks, and anything preceded by a word
 * character — `user@example.com` stays intact rather than becoming
 * `user`@example`.com`.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/(^|[^\w`])@([\w-]+)/g, (_match, prefix: string, name: string) => `${prefix}\`@${name}\``);
}

function buildTriageTools(hasProductEdge: boolean): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: "get_all_findings",
      description: "Get all feedback collected by agents / 全エージェントが収集したフィードバック一覧を取得する",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "create_issue",
      description: "Post feedback as an issue ticket; multiple related findings can be merged into one / フィードバックをissueチケットとして投稿する。類似フィードバックをまとめて1件にできる",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Issue title (concise)" },
          body: { type: "string", description: "Issue body with details from multiple perspectives" },
          category: { type: "string", enum: ["ux", "feature-request", "bug", "goal-gap"] },
          merged_finding_ids: {
            type: "array",
            items: { type: "string" },
            description: "IDs of the findings merged into this Issue",
          },
        },
        required: ["title", "body", "category", "merged_finding_ids"],
      },
    },
    {
      name: "skip_finding",
      description: "Skip a finding that duplicates an existing open issue / 既存のOpenなissueと重複するためスキップする",
      input_schema: {
        type: "object",
        properties: {
          finding_id: { type: "string", description: "ID of the finding to skip" },
          reason: { type: "string", description: "Reason for skipping" },
        },
        required: ["finding_id", "reason"],
      },
    },
  ];

  if (hasProductEdge) {
    const createIssue = tools.find((t) => t.name === "create_issue");
    const schema = createIssue?.input_schema as { properties?: Record<string, unknown> } | undefined;
    if (schema?.properties) {
      schema.properties.edge_risk = {
        type: "object",
        description:
          "Set ONLY when acting on this issue as reported would blunt a declared product edge or reverse a deliberate trade-off. The issue is still filed either way — this marks it for a human decision. Never set it on bug findings.",
        properties: {
          edge: { type: "string", description: "The declared sharp edge or trade-off at stake (quote it)" },
          why: { type: "string", description: "Why the obvious fix would blunt that edge, and what would be lost" },
        },
        required: ["edge", "why"],
      };
    }
  }

  return tools;
}

/**
 * One issue as triage actually filed it.
 *
 * The ID lists above say *what happened to a finding*; this says *what the team
 * received*. Without it the dashboard can only show raw findings, so the merge
 * triage performed — several reports collapsed into one ticket — and the
 * edge-risk call it made are invisible to the humans who have to act on them.
 */
export interface TriagedIssue {
  /** Title as filed on the tracker, including the `[category]` prefix. */
  title: string;
  category: string;
  /** Tracker URL, or null when no tracker is configured (report-only runs). */
  url: string | null;
  /** Findings merged into this one issue. */
  mergedFindingIds: string[];
  /** Set when acting on this issue as reported would blunt a declared edge. */
  edgeRisk: { edge: string; why: string } | null;
  createdAt: string;
}

/** A finding triage deliberately did not file, and why. */
export interface TriagedSkip {
  findingId: string;
  reason: string;
}

export interface TriageResult {
  issued: string[];
  skipped: string[];
  unprocessed: string[];
  issuesCreated: number;
  /** Finding IDs filed on issues whose fix would blunt a declared product edge. */
  edgeRisks: string[];
  /** Issues as filed, in creation order. */
  issues: TriagedIssue[];
  /** Skip decisions with their reasons, in decision order. */
  skips: TriagedSkip[];
}

/**
 * A re-report is a skip with a cause worth keeping: the finding was not dropped,
 * it was posted as a comment on the issue it re-reports.
 */
function reReportSkip(report: { findingId: string; issueNumber: number | string; issueTitle: string }): TriagedSkip {
  return {
    findingId: report.findingId,
    reason: `re-reported as a comment on ${formatIssueRef(report.issueNumber)}: ${report.issueTitle}`,
  };
}

/** The empty result, so every early return agrees on the shape. */
function emptyTriageResult(overrides: Partial<TriageResult> = {}): TriageResult {
  return {
    issued: [],
    skipped: [],
    unprocessed: [],
    issuesCreated: 0,
    edgeRisks: [],
    issues: [],
    skips: [],
    ...overrides,
  };
}

export async function runTriageAgent(
  findings: Finding[],
  client: LLMClient,
  model: string,
  tracker: IssueTracker,
  // adoption 集計用: agentId → 担当 lens / scenario（省略時はリンク記録なし）
  agentAssignments?: Map<string, { scenario?: { title: string }; lens?: string }>,
  // 宣言済みの product edge（未宣言なら edge_risk ツールごと出さない）
  productEdge?: ProductEdge,
): Promise<TriageResult> {
  if (findings.length === 0) {
    console.log("\n[triage] no findings, skipping");
    return emptyTriageResult();
  }

  console.log(`\n[triage] starting (findings: ${findings.length})`);

  const openIssues = await tracker.fetchOpenIssues();
  const { results: reReports, remaining: triageFindings } = await commentReturningUserReReports(
    findings,
    openIssues,
    tracker,
  );
  for (const report of reReports) {
    if (report.commented) {
      console.log(`  [triage] re-report comment on ${formatIssueRef(report.issueNumber)}: ${report.issueTitle}`);
    }
  }

  if (triageFindings.length === 0) {
    console.log("[triage] all findings handled via re-report comments");
    const reReportSkips = reReports.filter((r) => r.commented).map(reReportSkip);
    return emptyTriageResult({
      skipped: reReportSkips.map((s) => s.findingId),
      skips: reReportSkips,
    });
  }

  const pendingIds = new Set(triageFindings.map((f) => f.id));
  const issuedIds: string[] = [];
  const skips: TriagedSkip[] = reReports.filter((r) => r.commented).map(reReportSkip);
  const skippedIds: string[] = skips.map((s) => s.findingId);
  const edgeRiskIds: string[] = [];
  const issues: TriagedIssue[] = [];
  let issuesCreated = 0;
  let skipped = skippedIds.length;

  const openIssueList = openIssues.length > 0
    ? `\n\n[Existing open issues (for deduplication)]\n${openIssues.map((i) => `- ${i.number}: ${i.title}`).join("\n")}`
    : "";

  const edgePrompt = formatProductEdgeForPrompt(productEdge);
  const edgeSection = edgePrompt ? `\n\n${edgePrompt}` : "";

  const systemPrompt = `You are a feedback triage AI.
Organize feedback collected by multiple agents and post it as issue tickets.

[Steps]
1. Call get_all_findings to review collected feedback
2. Merge similar/duplicate feedback into a single issue
3. Skip feedback that duplicates an existing open issue using skip_finding
4. Post the rest with create_issue (no duplicates, only valuable findings)
5. Returning-user re-reports that mention an issue is still broken may already have been posted as comments on matching open issues — focus on new findings
6. Finish after processing all items${openIssueList}

[Category Guide]
- bug: incorrect or broken behavior
- ux: usability, interaction, or visual design issue
- feature-request: missing capability users would expect
- goal-gap: the app fails to meet one of its stated goals — use only when a finding directly undermines a specific app goal

[Merging Guidelines]
- Multiple reports about the same screen/feature can be merged into one issue
- Merge into one issue even across categories if it's the same underlying problem
- Include multiple perspectives in the body when merging
- Only post clearly valuable findings (skip operation errors or misunderstandings)

[Important Constraints]
- merged_finding_ids must contain at least one ID
- If a finding cannot be linked to any feedback, use skip_finding instead of create_issue${edgeSection}`;

  const sessionTools = buildTriageTools(Boolean(edgePrompt)).map((t) => ({
    name: t.name,
    description: t.description ?? t.name,
    input_schema: t.input_schema as Record<string, unknown>,
    execute: async (input: Record<string, unknown>): Promise<string> => {
      if (t.name === "get_all_findings") {
        const result = triageFindings.map((f) => ({
          id: f.id,
          agentName: f.agentName,
          role: f.role,
          title: f.title,
          body: f.body,
          category: f.category,
          timestamp: f.timestamp,
          pending: pendingIds.has(f.id),
        }));
        console.log(`  [triage] fetched findings (${triageFindings.length})`);
        return JSON.stringify(result);
      }

      if (t.name === "create_issue") {
        const { title, body, category, merged_finding_ids, edge_risk } = input as {
          title?: string;
          body?: string;
          category?: string;
          merged_finding_ids?: string[];
          edge_risk?: unknown;
        };
        if (!title || !body || !category) {
          return JSON.stringify({ error: "create_issue: missing required fields" });
        }
        const mergedIds = merged_finding_ids ?? [];
        if (mergedIds.length === 0) {
          return JSON.stringify({ error: "merged_finding_ids must contain at least one ID" });
        }
        const mergedFindings = triageFindings.filter((f) => mergedIds.includes(f.id));
        const mergedAgents = mergedFindings.map((f) => `${f.agentName} (${f.role})`);
        const screenshots = mergedFindings
          .filter((f) => f.screenshotPath)
          .map((f) => `- ${f.agentName}: ${f.screenshotPath}`);
        const screenshotSection = screenshots.length > 0
          ? `\n\n**Screenshots:**\n${screenshots.join("\n")}`
          : "";
        // edge が宣言されているときだけ、かつ defect カテゴリ以外にのみ印を付ける
        const edgeRisk = edgePrompt && canCarryEdgeRisk(category) ? normalizeEdgeRisk(edge_risk) : null;
        if (edge_risk && !edgeRisk) {
          const reason = !edgePrompt
            ? "no product edge declared"
            : !canCarryEdgeRisk(category)
              ? `a ${category} is a defect, not a positioning call`
              : "edge / why missing";
          console.log(`  [triage] edge_risk ignored — ${reason}`);
        }
        const edgeRiskSection = edgeRisk ? formatEdgeRiskSection(edgeRisk) : "";
        const fullBody = `**Category:** ${category}\n\n${neutralizeMentions(body)}${screenshotSection}${edgeRiskSection}\n\n---\n**Reported by:** ${mergedAgents.join(", ")}\n*This Issue was auto-generated by an AI triage agent*`;
        const cleanTitle = title.replace(/^\[[^\]]+\]\s*/i, "");
        const labels = edgeRisk ? [category, "feedback-agent", EDGE_RISK_LABEL] : [category, "feedback-agent"];
        const url = await tracker.createIssue(`[${category}] ${cleanTitle}`, fullBody, labels);
        if (url === null && !tracker.isEmpty) {
          return JSON.stringify({ created: false, error: "tracker returned null — check logs" });
        }
        mergedIds.forEach((id) => { pendingIds.delete(id); issuedIds.push(id); });
        issuesCreated++;
        issues.push({
          title: `[${category}] ${cleanTitle}`,
          category,
          url,
          mergedFindingIds: mergedIds,
          edgeRisk,
          createdAt: new Date().toISOString(),
        });
        if (edgeRisk) {
          edgeRiskIds.push(...mergedIds);
          console.log(`  [triage] edge risk flagged: ${edgeRisk.edge}`);
        }
        if (url && agentAssignments) {
          const lenses = new Set<string>();
          const scenarios = new Set<string>();
          for (const f of mergedFindings) {
            const assignment = agentAssignments.get(f.agentId);
            if (assignment?.lens) lenses.add(assignment.lens.split(":")[0].trim());
            if (assignment?.scenario) scenarios.add(assignment.scenario.title);
          }
          recordIssueLink({
            url,
            title: `[${category}] ${cleanTitle}`,
            category,
            lenses: [...lenses],
            scenarios: [...scenarios],
            runId: mergedFindings[0]?.runId ?? "",
            createdAt: new Date().toISOString(),
          });
        }
        console.log(`  [triage] issue created: "[${category}] ${cleanTitle}" (merged ${mergedIds.length})`);
        return JSON.stringify({ created: true, url, mergedCount: mergedIds.length, edgeRisk: Boolean(edgeRisk) });
      }

      if (t.name === "skip_finding") {
        const { finding_id, reason } = input as { finding_id?: string; reason?: string };
        if (!finding_id) {
          return JSON.stringify({ error: "skip_finding: missing finding_id" });
        }
        pendingIds.delete(finding_id);
        skippedIds.push(finding_id);
        skips.push({ findingId: finding_id, reason: reason ?? "no reason given" });
        skipped++;
        console.log(`  [triage] skipped: ${finding_id} — ${reason}`);
        return JSON.stringify({ skipped: true });
      }

      return JSON.stringify({ error: "unknown tool" });
    },
  }));

  await runToolSession({
    provider: process.env.LLM_PROVIDER ?? "anthropic",
    client,
    model,
    system: systemPrompt,
    userPrompt: `Triage the feedback and create issue tickets via ${tracker.name}.`,
    tools: sessionTools,
    maxIterations: 15,
    maxTokens: 2048,
  });

  const result = emptyTriageResult({
    issued: issuedIds,
    skipped: skippedIds,
    unprocessed: Array.from(pendingIds),
    issuesCreated,
    edgeRisks: edgeRiskIds,
    issues,
    skips,
  });

  if (findings.length > 0) {
    const runId = findings[0].runId;
    const findingsDir = path.join(process.cwd(), "findings", runId);
    fs.writeFileSync(
      path.join(findingsDir, "triage_result.json"),
      JSON.stringify({ runId, completedAt: new Date().toISOString(), ...result }, null, 2),
      "utf-8"
    );
  }

  const edgeRiskNote = edgeRiskIds.length > 0 ? ` / edge-risk: ${edgeRiskIds.length}` : "";
  console.log(`[triage] done (issues created: ${issuesCreated} / skipped: ${skipped}${edgeRiskNote})`);
  return result;
}
