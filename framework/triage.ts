import Anthropic from "@anthropic-ai/sdk";
import * as fs from "fs";
import * as path from "path";
import type { LLMClient } from "./llm-client";
import type { Finding } from "./types";
import { createMessageWithRetry } from "./agent-loop";
import { postGitHubIssue, fetchOpenIssues } from "./github";

const TRIAGE_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_all_findings",
    description: "Get all feedback collected by agents / 全エージェントが収集したフィードバック一覧を取得する",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "create_issue",
    description: "Post feedback as a GitHub Issue; multiple related findings can be merged into one / フィードバックをGitHub Issueとして投稿する。類似フィードバックをまとめて1件にできる",
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
    description: "Skip a finding that duplicates an existing open GitHub Issue / 既存のOpenなGitHub Issueと重複するためスキップする",
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
  githubOptions: { token: string; repo: string }
): Promise<TriageResult> {
  if (findings.length === 0) {
    console.log("\n[triage] no findings, skipping");
    return { issued: [], skipped: [], unprocessed: [], issuesCreated: 0 };
  }

  console.log(`\n[triage] starting (findings: ${findings.length})`);

  const openIssues = await fetchOpenIssues(githubOptions);
  const pendingIds = new Set(findings.map((f) => f.id));
  const issuedIds: string[] = [];
  const skippedIds: string[] = [];
  let issuesCreated = 0;
  let skipped = 0;

  const openIssueList = openIssues.length > 0
    ? `\n\n[Existing open Issues (for deduplication)]\n${openIssues.map((i) => `- #${i.number}: ${i.title}`).join("\n")}`
    : "";

  const systemPrompt = `You are a feedback triage AI.
Organize feedback collected by multiple agents and post it as GitHub Issues.

[Steps]
1. Call get_all_findings to review collected feedback
2. Merge similar/duplicate feedback into a single Issue
3. Skip feedback that duplicates an existing open Issue using skip_finding
4. Post the rest with create_issue (no duplicates, only valuable findings)
5. Finish after processing all items${openIssueList}

[Category Guide]
- bug: incorrect or broken behavior
- ux: usability, interaction, or visual design issue
- feature-request: missing capability users would expect
- goal-gap: the app fails to meet one of its stated goals — use only when a finding directly undermines a specific app goal

[Merging Guidelines]
- Multiple reports about the same screen/feature can be merged into one Issue
- Merge into one Issue even across categories if it's the same underlying problem
- Include multiple perspectives in the body when merging
- Only post clearly valuable findings (skip operation errors or misunderstandings)

[Important Constraints]
- merged_finding_ids must contain at least one ID
- If a finding cannot be linked to any feedback, use skip_finding instead of create_issue`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: "Triage the feedback and create GitHub Issues." },
  ];

  let iterations = 0;
  while (iterations < 15) {
    iterations++;

    const response = await createMessageWithRetry(client, {
      model,
      max_tokens: 2048,
      system: systemPrompt,
      tools: TRIAGE_TOOLS,
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

      if (toolUse.name === "get_all_findings") {
        result = findings.map((f) => ({
          id: f.id,
          agentName: f.agentName,
          role: f.role,
          title: f.title,
          body: f.body,
          category: f.category,
          timestamp: f.timestamp,
          pending: pendingIds.has(f.id),
        }));
        console.log(`  [triage] fetched findings (${findings.length})`);

      } else if (toolUse.name === "create_issue") {
        const { title, body, category, merged_finding_ids } = toolUse.input as {
          title: string;
          body: string;
          category: string;
          merged_finding_ids: string[] | undefined;
        };
        const mergedIds = merged_finding_ids ?? [];
        if (mergedIds.length === 0) {
          result = { error: "merged_finding_ids must contain at least one ID" };
          toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) });
          continue;
        }
        const mergedFindings = findings.filter((f) => mergedIds.includes(f.id));
        const mergedAgents = mergedFindings.map((f) => `${f.agentName} (${f.role})`);
        const screenshots = mergedFindings
          .filter((f) => f.screenshotPath)
          .map((f) => `- ${f.agentName}: ${f.screenshotPath}`);
        const screenshotSection = screenshots.length > 0
          ? `\n\n**Screenshots:**\n${screenshots.join("\n")}`
          : "";
        const fullBody = `**Category:** ${category}\n\n${body}${screenshotSection}\n\n---\n**Reported by:** ${mergedAgents.join(", ")}\n*This Issue was auto-generated by an AI triage agent*`;
        const url = await postGitHubIssue(`[${category}] ${title}`, fullBody, [category, "feedback-agent"], githubOptions);
        mergedIds.forEach((id) => { pendingIds.delete(id); issuedIds.push(id); });
        issuesCreated++;
        result = { created: true, url, mergedCount: mergedIds.length };
        console.log(`  [triage] issue created: "${title}" (merged ${mergedIds.length})`);

      } else if (toolUse.name === "skip_finding") {
        const { finding_id, reason } = toolUse.input as { finding_id: string; reason: string };
        pendingIds.delete(finding_id);
        skippedIds.push(finding_id);
        skipped++;
        result = { skipped: true };
        console.log(`  [triage] skipped: ${finding_id} — ${reason}`);

      } else {
        result = { error: "unknown tool" };
      }

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: JSON.stringify(result) });
    }

    messages.push({ role: "user", content: toolResults });
  }

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
