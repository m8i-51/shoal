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
