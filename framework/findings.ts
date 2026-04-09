import * as fs from "fs";
import * as path from "path";
import type { Finding, RunLog } from "./types";

export const collectedFindings: Finding[] = [];
export let runLog: RunLog;

export function saveFinding(finding: Finding): void {
  collectedFindings.push(finding);
  const findingsDir = path.join(process.cwd(), "findings", finding.runId);
  if (!fs.existsSync(findingsDir)) {
    fs.mkdirSync(findingsDir, { recursive: true });
  }
  fs.writeFileSync(
    path.join(findingsDir, `${finding.id}.json`),
    JSON.stringify(finding, null, 2),
    "utf-8"
  );
}

export function initRunLog(agentCount: number, repo: string): void {
  runLog = {
    runId: `run_${Date.now()}`,
    startedAt: new Date().toISOString(),
    completedAt: null,
    repo,
    agents: [],
    summary: {
      totalAgents: agentCount,
      completed: 0,
      errors: 0,
      iterationLimitReached: 0,
      totalActions: 0,
      totalIssuesPosted: 0,
      regressionChecked: 0,
      regressionFailed: 0,
      rateLimitRetries: 0,
    },
  };
}

export function saveRunLog(): void {
  const logsDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = path.join(logsDir, `${ts}_${runLog.runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(runLog, null, 2), "utf-8");
  console.log(`\n[log] saved: ${filePath}`);
}
