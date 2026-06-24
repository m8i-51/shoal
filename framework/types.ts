export interface ToolAction {
  timestamp: string;
  tool: string;
  input: Record<string, unknown>;
  result: unknown;
  durationMs: number;
}

export interface IssuePosted {
  title: string;
  category: string;
  url: string | null;
}

export interface Finding {
  id: string;
  runId: string;
  agentId: string;
  agentName: string;
  role: string;
  title: string;
  body: string;
  category: string;
  timestamp: string;
  screenshotPath?: string;
}

/**
 * findings/run_<id>/ ディレクトリには各 finding の JSON と並んで
 * triage_result.json（集計ファイル、Finding ではない）が置かれる。
 * 読み込んだ JSON が実際に Finding かどうかをここで一括判定する。
 */
export function isFinding(v: unknown): v is Finding {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.id === "string" && typeof o.category === "string" && typeof o.timestamp === "string";
}

export interface RegressionCheck {
  issueNumber: number;
  issueTitle: string;
  status: "fixed" | "regressed";
  note: string;
  regressionUrl: string | null;
}

export interface AgentLog {
  agentType: "explorer" | "regression";
  agentId: string;
  agentName: string;
  role: string;
  startedAt: string;
  completedAt: string | null;
  status: "completed" | "error" | "iteration_limit";
  iterations: number;
  actions: ToolAction[];
  visitedPaths: string[];
  issuesPosted: IssuePosted[];
  regressionChecks: RegressionCheck[];
  error: string | null;
}

export interface RunLog {
  runId: string;
  startedAt: string;
  completedAt: string | null;
  repo: string;
  agents: AgentLog[];
  summary: {
    totalAgents: number;
    completed: number;
    errors: number;
    iterationLimitReached: number;
    totalActions: number;
    totalIssuesPosted: number;
    regressionChecked: number;
    regressionFailed: number;
    rateLimitRetries: number;
    cost: {
      inputTokens: number;
      outputTokens: number;
      estimatedUSD: number | null;
    };
  };
}

export interface ClosedIssue {
  number: number;
  title: string;
  body: string;
  labels: string[];
}
