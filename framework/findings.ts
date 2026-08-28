import * as fs from "fs";
import * as path from "path";
import type { Finding, RunLog } from "./types";
import { redactRunLog } from "./redact";

export const collectedFindings: Finding[] = [];
export let runLog: RunLog;

/** finding テキストから URL パス（先頭セグメント）を推定する */
export function extractFindingPath(finding: Pick<Finding, "title" | "body">): string {
  const text = `${finding.title} ${finding.body}`;
  const m = text.match(/(\/[a-zA-Z0-9_][a-zA-Z0-9_/-]*)/);
  if (!m) return "/";
  const segments = m[1].split("/").filter(Boolean);
  return segments.length > 0 ? `/${segments[0]}` : "/";
}

function normalizePath(raw: string): string {
  const trimmed = raw.trim() || "/";
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || "/";
}

/** エージェントの現在地と finding の推定パスが同じエリアか */
export function pathsShareArea(agentPath: string, findingPath: string): boolean {
  const agent = normalizePath(agentPath);
  const finding = normalizePath(findingPath);
  if (agent === "/" || finding === "/") return true;
  if (agent === finding) return true;
  if (agent.startsWith(`${finding}/`) || finding.startsWith(`${agent}/`)) return true;
  const agentRoot = agent.split("/").filter(Boolean)[0];
  const findingRoot = finding.split("/").filter(Boolean)[0];
  return Boolean(agentRoot && findingRoot && agentRoot === findingRoot);
}

/**
 * Swarm signals（スティグマジー）— 同じ run の他エージェントが残した発見を返す。
 * currentPath が渡されたときは同エリアの finding を優先する。
 */
export function getSwarmSignals(
  excludeAgentId: string,
  limit = 8,
  currentPath?: string,
): {
  agentName: string;
  category: string;
  title: string;
  excerpt: string;
  path: string;
}[] {
  let pool = collectedFindings.filter((f) => f.agentId !== excludeAgentId);
  if (currentPath) {
    const inArea = pool.filter((f) => pathsShareArea(currentPath, extractFindingPath(f)));
    if (inArea.length > 0) pool = inArea;
  }
  return pool
    .slice(-limit)
    .map((f) => ({
      agentName: f.agentName,
      category: f.category,
      title: f.title,
      excerpt: f.body.length > 200 ? `${f.body.slice(0, 200)}…` : f.body,
      path: extractFindingPath(f),
    }));
}

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
    runId: process.env.SHOAL_RUN_ID ?? `run_${Date.now()}`,
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
      cost: { inputTokens: 0, outputTokens: 0, estimatedUSD: null },
    },
  };
}

export function saveRunLog(): void {
  if (!runLog) return; // initRunLog が呼ばれる前にエラーが起きた場合はスキップ
  const logsDir = path.join(process.cwd(), "logs");
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filePath = path.join(logsDir, `${ts}_${runLog.runId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(redactRunLog(runLog), null, 2), "utf-8");
  console.log(`\n[log] saved: ${filePath}`);
}
