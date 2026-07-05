/**
 * shoal MCP server — 発見→修正→検証のループをコーディングエージェントに開放する。
 *
 * `shoal mcp` で stdio transport として起動する。Claude Code などの
 * コーディングエージェントはこのサーバー経由で run を開始し、findings を読み、
 * 修正後に再度 run を回して regression agent の検証結果と Experience Score の
 * 変化を確認できる。
 *
 * 例（.mcp.json）:
 *   { "mcpServers": { "shoal": { "command": "shoal", "args": ["mcp"] } } }
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { spawnRun, activeSessions } from "./runner.js";
import { listRuns } from "./runs.js";
import { computeExperienceScore } from "../framework/experience-score.js";
import { isFinding, type Finding } from "../framework/types.js";

// ================================================================
// Handlers — MCP 配線から分離した単体テスト可能な関数群
// ================================================================

export function handleStartRun(input: {
  baseUrl?: string;
  maxBrowsers?: number;
  maxExplorers?: number;
  mode?: string;
}): { runId: string; note: string } {
  if (input.mode !== undefined && !["read-only", "safe", "full"].includes(input.mode)) {
    throw new Error("mode must be one of: read-only, safe, full");
  }
  const runId = spawnRun(input);
  return {
    runId,
    note: "Run started in the background. Poll get_run_status until status is completed, then inspect list_findings and get_experience_score.",
  };
}

export function handleGetRunStatus(runId: string): {
  runId: string;
  status: "running" | "completed" | "not_found";
  exitCode: number | null;
  findingsCount: number;
  regressionChecked: number;
  regressionFailed: number;
  lastLogLines: string[];
} {
  const session = activeSessions.get(runId);
  const summary = listRuns().find((r) => r.runId === runId);

  if (!session && !summary) {
    return { runId, status: "not_found", exitCode: null, findingsCount: 0, regressionChecked: 0, regressionFailed: 0, lastLogLines: [] };
  }

  const running = session ? !session.done : summary!.status === "running";
  return {
    runId,
    status: running ? "running" : "completed",
    exitCode: session?.exitCode ?? null,
    findingsCount: summary?.findingCount ?? 0,
    regressionChecked: summary?.regressionChecked ?? 0,
    regressionFailed: summary?.regressionFailed ?? 0,
    lastLogLines: session ? session.lines.slice(-15) : [],
  };
}

export function handleListFindings(filter: {
  runId?: string;
  category?: string;
  search?: string;
  limit?: number;
} = {}): Finding[] {
  const base = path.resolve(process.cwd(), "findings");
  if (!fs.existsSync(base)) return [];

  const runDirs = filter.runId
    ? [filter.runId].filter((d) => /^run_\d+$/.test(d))
    : fs.readdirSync(base).filter((d) => /^run_\d+$/.test(d));

  const all: Finding[] = [];
  for (const runDir of runDirs) {
    const dir = path.join(base, runDir);
    if (!fs.existsSync(dir)) continue;
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith(".json") || file === "triage_result.json") continue;
        try {
          const f: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
          if (!isFinding(f)) continue;
          all.push(f);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }

  const q = filter.search?.toLowerCase();
  return all
    .filter((f) => !filter.category || f.category === filter.category)
    .filter((f) => !q || f.title.toLowerCase().includes(q) || f.body.toLowerCase().includes(q))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, filter.limit ?? 50);
}

export function handleGetExperienceScore(): unknown {
  const score = computeExperienceScore();
  return score ?? { message: "No experience data yet — complete a run with scenarios first." };
}

// ================================================================
// MCP wiring
// ================================================================

export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "shoal", version: "0.1.0" });

  const asText = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const asError = (e: unknown) => ({ content: [{ type: "text" as const, text: `error: ${e instanceof Error ? e.message : String(e)}` }], isError: true });

  server.registerTool(
    "start_run",
    {
      description: "Start a shoal exploration run against a web app. AI agents with distinct personas will explore the app and file findings (bugs, UX issues, feature gaps). Returns a runId to poll with get_run_status. Typical fix loop: fix code → deploy/restart the app → start_run → wait for completion → list_findings + get_experience_score to verify the experience improved.",
      inputSchema: {
        baseUrl: z.string().optional().describe("URL of the app to explore (defaults to BASE_URL from .env)"),
        maxBrowsers: z.number().int().min(0).max(8).optional().describe("Browser agent count (default 2)"),
        maxExplorers: z.number().int().min(0).max(8).optional().describe("API explorer agent count (default from .env)"),
        mode: z.enum(["read-only", "safe", "full"]).optional().describe("Safety mode (default safe)"),
      },
    },
    async (input) => {
      try { return asText(handleStartRun(input)); } catch (e) { return asError(e); }
    },
  );

  server.registerTool(
    "get_run_status",
    {
      description: "Check the status of a shoal run: running/completed, findings count so far, regression check results, and the last log lines.",
      inputSchema: {
        runId: z.string().describe("The runId returned by start_run"),
      },
    },
    async ({ runId }) => {
      try { return asText(handleGetRunStatus(runId)); } catch (e) { return asError(e); }
    },
  );

  server.registerTool(
    "list_findings",
    {
      description: "List findings shoal agents have reported across runs (newest first). Each finding has a category (bug / ux / feature-request / goal-gap), the reporting persona, and a first-person description of what the agent experienced. Use search/category/runId to narrow.",
      inputSchema: {
        runId: z.string().optional().describe("Only findings from this run"),
        category: z.enum(["bug", "ux", "feature-request", "goal-gap"]).optional(),
        search: z.string().optional().describe("Case-insensitive substring match on title/body"),
        limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      },
    },
    async (input) => {
      try { return asText(handleListFindings(input)); } catch (e) { return asError(e); }
    },
  );

  server.registerTool(
    "get_experience_score",
    {
      description: "Get the cross-run Experience Score (0-100): scenario success rate, friction, and regression rate, with the trend across runs and delta vs the previous run. Use it to verify whether a fix actually improved the app's experience.",
      inputSchema: {},
    },
    async () => {
      try { return asText(handleGetExperienceScore()); } catch (e) { return asError(e); }
    },
  );

  return server;
}

if (process.env.NODE_ENV !== "test") {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  server.connect(transport).then(() => {
    console.error("[shoal-mcp] listening on stdio"); // stdout は JSON-RPC 用なので stderr に出す
  }).catch((e) => {
    console.error("[shoal-mcp] failed to start:", e);
    process.exit(1);
  });
}
