import * as fs from "fs";
import * as path from "path";
import type { RunLog, Finding } from "../framework/types";

export interface RunSummary {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  status: "completed" | "running";
  agentCount: number;
  completedAgents: number;
  errorAgents: number;
  findingCount: number;
  findingsByCategory: Record<string, number>;
  hasReport: boolean;
  isLive?: boolean;
  estimatedCostUSD: number | null;
  regressionChecked: number;
  regressionFailed: number;
}

function countFindings(runId: string): { total: number; byCategory: Record<string, number> } {
  const dir = path.join(process.cwd(), "findings", runId);
  if (!fs.existsSync(dir)) return { total: 0, byCategory: {} };
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith(".json") || file === "triage_result.json") continue;
    try {
      const f: Finding = JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8"));
      if (typeof f.category !== "string") continue;
      byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
      total++;
    } catch {
      // skip malformed
    }
  }
  return { total, byCategory };
}

export function listRuns(): RunSummary[] {
  const logsDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) return [];

  const summaries: RunSummary[] = [];
  const seenRunIds = new Set<string>();

  for (const file of fs.readdirSync(logsDir)) {
    // 実行中の pending ファイル（running_*.json）
    if (file.startsWith("running_") && file.endsWith(".json")) {
      try {
        const raw = fs.readFileSync(path.join(logsDir, file), "utf-8");
        const { runId, startedAt } = JSON.parse(raw);
        if (!seenRunIds.has(runId)) {
          seenRunIds.add(runId);
          summaries.push({
            runId,
            startedAt,
            completedAt: null,
            status: "running",
            agentCount: 0,
            completedAgents: 0,
            errorAgents: 0,
            findingCount: 0,
            findingsByCategory: {},
            hasReport: false,
            isLive: true,
            estimatedCostUSD: null,
            regressionChecked: 0,
            regressionFailed: 0,
          });
        }
      } catch { /* skip */ }
      continue;
    }

    // 通常のランログ（YYYY-MM-DDTHH-MM-SS_run_*.json）
    if (!file.endsWith(".json") || file.startsWith("report_")) continue;
    try {
      const raw = fs.readFileSync(path.join(logsDir, file), "utf-8");
      const log: RunLog = JSON.parse(raw);
      if (seenRunIds.has(log.runId)) continue;
      seenRunIds.add(log.runId);
      const { total, byCategory } = countFindings(log.runId);
      const reportPath = path.join(logsDir, `report_${log.runId}.html`);
      summaries.push({
        runId: log.runId,
        startedAt: log.startedAt,
        completedAt: log.completedAt,
        status: log.completedAt ? "completed" : "running",
        agentCount: log.agents.length,
        completedAgents: log.agents.filter((a) => a.status === "completed").length,
        errorAgents: log.agents.filter((a) => a.status === "error").length,
        findingCount: total,
        findingsByCategory: byCategory,
        hasReport: fs.existsSync(reportPath),
        estimatedCostUSD: log.summary?.cost?.estimatedUSD ?? null,
        regressionChecked: log.summary?.regressionChecked ?? 0,
        regressionFailed: log.summary?.regressionFailed ?? 0,
      });
    } catch { /* skip */ }
  }

  return summaries.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export function getReportPath(runId: string): string | null {
  if (!/^run_\d+$/.test(runId)) return null;
  const p = path.join(process.cwd(), "logs", `report_${runId}.html`);
  return fs.existsSync(p) ? p : null;
}
