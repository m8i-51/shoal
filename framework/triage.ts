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

const TRIAGE_TOOLS: Anthropic.Tool[] = [
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

export interface TriageResult {
  issued: string[];
  skipped: string[];
  unprocessed: string[];
  issuesCreated: number;
}

export async function runTriageAgent(
  findings: Finding[],
  client: LLMClient,
  model: string,
  tracker: IssueTracker,
  // adoption 集計用: agentId → 担当 lens / scenario（省略時はリンク記録なし）
  agentAssignments?: Map<string, { scenario?: { title: string }; lens?: string }>,
): Promise<TriageResult> {
  if (findings.length === 0) {
    console.log("\n[triage] no findings, skipping");
    return { issued: [], skipped: [], unprocessed: [], issuesCreated: 0 };
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
    return {
      issued: [],
      skipped: reReports.filter((r) => r.commented).map((r) => r.findingId),
      unprocessed: [],
      issuesCreated: 0,
    };
  }

  const pendingIds = new Set(triageFindings.map((f) => f.id));
  const issuedIds: string[] = [];
  const skippedIds: string[] = reReports.filter((r) => r.commented).map((r) => r.findingId);
  let issuesCreated = 0;
  let skipped = skippedIds.length;

  const openIssueList = openIssues.length > 0
    ? `\n\n[Existing open issues (for deduplication)]\n${openIssues.map((i) => `- ${i.number}: ${i.title}`).join("\n")}`
    : "";

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
- If a finding cannot be linked to any feedback, use skip_finding instead of create_issue`;

  const sessionTools = TRIAGE_TOOLS.map((t) => ({
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
        const { title, body, category, merged_finding_ids } = input as {
          title?: string;
          body?: string;
          category?: string;
          merged_finding_ids?: string[];
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
        const fullBody = `**Category:** ${category}\n\n${body}${screenshotSection}\n\n---\n**Reported by:** ${mergedAgents.join(", ")}\n*This Issue was auto-generated by an AI triage agent*`;
        const cleanTitle = title.replace(/^\[[^\]]+\]\s*/i, "");
        const url = await tracker.createIssue(`[${category}] ${cleanTitle}`, fullBody, [category, "feedback-agent"]);
        if (url === null && !tracker.isEmpty) {
          return JSON.stringify({ created: false, error: "tracker returned null — check logs" });
        }
        mergedIds.forEach((id) => { pendingIds.delete(id); issuedIds.push(id); });
        issuesCreated++;
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
        return JSON.stringify({ created: true, url, mergedCount: mergedIds.length });
      }

      if (t.name === "skip_finding") {
        const { finding_id, reason } = input as { finding_id?: string; reason?: string };
        if (!finding_id) {
          return JSON.stringify({ error: "skip_finding: missing finding_id" });
        }
        pendingIds.delete(finding_id);
        skippedIds.push(finding_id);
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

  if (findings.length > 0) {
    const runId = findings[0].runId;
    const findingsDir = path.join(process.cwd(), "findings", runId);
    fs.writeFileSync(
      path.join(findingsDir, "triage_result.json"),
      JSON.stringify({
        runId,
        completedAt: new Date().toISOString(),
        issued: issuedIds,
        skipped: skippedIds,
        unprocessed: Array.from(pendingIds),
      }, null, 2),
      "utf-8"
    );
  }

  console.log(`[triage] done (issues created: ${issuesCreated} / skipped: ${skipped})`);
  return { issued: issuedIds, skipped: skippedIds, unprocessed: Array.from(pendingIds), issuesCreated };
}
