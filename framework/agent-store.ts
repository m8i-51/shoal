import * as fs from "fs";
import * as path from "path";
import type { EnvironmentProfile } from "./environment";

/** 1 run 分のエージェント個人の体験記録 */
export interface AgentMemory {
  runId: string;
  timestamp: string;
  frustrations: string[]; // 未達成シナリオの理由・報告した finding
  achievements: string[]; // 達成したシナリオ
}

export type AgentOrigin = "fixed" | "auto";
export type AgentStatus = "active" | "archived";

export interface Agent {
  id: string;
  name: string;
  role: string;
  persona: string;
  createdAt: string;
  memories?: AgentMemory[]; // 直近 MAX_MEMORIES run 分のみ保持
  environment?: EnvironmentProfile; // ブラウザエージェントとして走るときの環境
  /** Dashboard-created members are "fixed"; HR recruits are "auto". Missing → auto. */
  origin?: AgentOrigin;
  /** Archived fixed personas stay on disk but skip runs. Missing → active. */
  status?: AgentStatus;
  /** Short seed used to generate a fixed persona. */
  seed?: string;
  /** Evaluation lenses (stored/edited; not wired into dispatch in v1). */
  lenses?: string[];
  /** Short test-account role (user / instructor / admin). Distinct from narrative `role`. */
  accountRole?: string;
}

const STORE_PATH = path.join(process.cwd(), "agents.json");

export function agentOrigin(agent: Agent): AgentOrigin {
  return agent.origin === "fixed" ? "fixed" : "auto";
}

export function agentStatus(agent: Agent): AgentStatus {
  return agent.status === "archived" ? "archived" : "active";
}

export function isActiveAgent(agent: Agent): boolean {
  return agentStatus(agent) === "active";
}

export function isFixedAgent(agent: Agent): boolean {
  return agentOrigin(agent) === "fixed";
}

export function loadAgents(): Agent[] {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as Agent[];
  } catch {
    return [];
  }
}

function saveAgents(agents: Agent[]): void {
  fs.writeFileSync(STORE_PATH, JSON.stringify(agents, null, 2), "utf-8");
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

export interface AddAgentInput {
  name: string;
  role: string;
  persona: string;
  environment?: EnvironmentProfile;
  origin?: AgentOrigin;
  status?: AgentStatus;
  seed?: string;
  lenses?: string[];
  accountRole?: string;
}

export function addAgent(input: AddAgentInput): Agent {
  const name = requireNonEmptyString(input.name, "name");
  const role = requireNonEmptyString(input.role, "role");
  const persona = requireNonEmptyString(input.persona, "persona");
  const origin: AgentOrigin = input.origin === "fixed" ? "fixed" : "auto";
  const status: AgentStatus = input.status === "archived" ? "archived" : "active";
  const agents = loadAgents();
  const agent: Agent = {
    id: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    role,
    persona,
    createdAt: new Date().toISOString(),
    origin,
    status,
    ...(input.environment ? { environment: input.environment } : {}),
    ...(input.seed !== undefined ? { seed: requireNonEmptyString(input.seed, "seed") } : {}),
    ...(input.lenses !== undefined
      ? { lenses: input.lenses.map((l) => String(l).trim()).filter(Boolean) }
      : {}),
    ...(input.accountRole !== undefined && input.accountRole.trim() !== ""
      ? { accountRole: requireNonEmptyString(input.accountRole, "accountRole") }
      : {}),
  };
  agents.push(agent);
  saveAgents(agents);
  return agent;
}

/** Hard-delete an auto agent. Fixed personas cannot be retired this way (returns false). */
export function retireAgent(id: string): boolean {
  const agents = loadAgents();
  const target = agents.find((a) => a.id === id);
  if (!target) return false;
  if (isFixedAgent(target)) return false;
  const filtered = agents.filter((a) => a.id !== id);
  saveAgents(filtered);
  return true;
}

export function listActiveAgents(): Agent[] {
  return loadAgents().filter(isActiveAgent);
}

export function listFixedPersonas(opts: { includeArchived?: boolean } = {}): Agent[] {
  return loadAgents().filter((a) => {
    if (!isFixedAgent(a)) return false;
    if (opts.includeArchived) return true;
    return isActiveAgent(a);
  });
}

export function archiveAgent(id: string): Agent | null {
  const agents = loadAgents();
  const agent = agents.find((a) => a.id === id);
  if (!agent || !isFixedAgent(agent)) return null;
  if (agentStatus(agent) === "archived") return agent;
  agent.status = "archived";
  saveAgents(agents);
  return agent;
}

export function restoreAgent(id: string): Agent | null {
  const agents = loadAgents();
  const agent = agents.find((a) => a.id === id);
  if (!agent || !isFixedAgent(agent)) return null;
  agent.status = "active";
  saveAgents(agents);
  return agent;
}

export interface UpdateAgentInput {
  name?: string;
  role?: string;
  persona?: string;
  lenses?: string[];
  accountRole?: string | null;
}

/** Update fields on an active fixed persona. Returns null if not found / not editable. */
export function updateAgent(id: string, patch: UpdateAgentInput): Agent | null {
  const agents = loadAgents();
  const agent = agents.find((a) => a.id === id);
  if (!agent || !isFixedAgent(agent) || !isActiveAgent(agent)) return null;

  if (patch.name !== undefined) agent.name = requireNonEmptyString(patch.name, "name");
  if (patch.role !== undefined) agent.role = requireNonEmptyString(patch.role, "role");
  if (patch.persona !== undefined) agent.persona = requireNonEmptyString(patch.persona, "persona");
  if (patch.lenses !== undefined) {
    agent.lenses = patch.lenses.map((l) => requireNonEmptyString(l, "lenses"));
  }
  if (patch.accountRole !== undefined) {
    if (patch.accountRole === null || patch.accountRole.trim() === "") {
      delete agent.accountRole;
    } else {
      agent.accountRole = requireNonEmptyString(patch.accountRole, "accountRole");
    }
  }

  saveAgents(agents);
  return agent;
}

/** Test-account role used for session matching. Falls back to narrative role. */
export function resolveAgentAccountRole(agent: { role: string; accountRole?: string }): string {
  const tagged = agent.accountRole?.trim();
  return tagged || agent.role;
}

// ================================================================
// Agent memory — 「先週の私」を覚えているエージェント
// ================================================================

const MAX_MEMORIES = 3; // 保持する run 数
const MAX_MEMORY_ITEMS = 5; // 1 run あたりの frustrations / achievements の上限

export interface MemoryInput {
  frustrations: string[];
  achievements: string[];
}

export interface MemoryScenarioOutcome {
  agentId: string;
  scenarioTitle: string;
  achieved: boolean;
  reason: string;
}

export interface MemoryFindingRef {
  agentId: string;
  category: string;
  title: string;
}

/** run 終了時の scenario outcome / finding から agent ごとの memory 入力を組み立てる */
export function buildMemoryInputs(
  agentIds: Iterable<string>,
  scenarioOutcomes: MemoryScenarioOutcome[],
  findings: MemoryFindingRef[],
): Map<string, MemoryInput> {
  const memoryInputs = new Map<string, MemoryInput>();
  for (const agentId of agentIds) {
    const input: MemoryInput = { frustrations: [], achievements: [] };
    for (const o of scenarioOutcomes) {
      if (o.agentId !== agentId) continue;
      if (o.achieved) input.achievements.push(`Completed "${o.scenarioTitle}"`);
      else input.frustrations.push(`Could not complete "${o.scenarioTitle}" — ${o.reason}`);
    }
    for (const f of findings) {
      if (f.agentId !== agentId) continue;
      input.frustrations.push(`Reported [${f.category}] "${f.title}"`);
    }
    memoryInputs.set(agentId, input);
  }
  return memoryInputs;
}

/** run 終了時に各エージェントの体験を記録する。何も体験していないエージェントはスキップ */
export function recordAgentMemories(runId: string, inputs: Map<string, MemoryInput>): void {
  const agents = loadAgents();
  let updated = 0;
  for (const agent of agents) {
    const input = inputs.get(agent.id);
    if (!input || (input.frustrations.length === 0 && input.achievements.length === 0)) continue;
    const memory: AgentMemory = {
      runId,
      timestamp: new Date().toISOString(),
      frustrations: input.frustrations.slice(0, MAX_MEMORY_ITEMS),
      achievements: input.achievements.slice(0, MAX_MEMORY_ITEMS),
    };
    agent.memories = [...(agent.memories ?? []), memory].slice(-MAX_MEMORIES);
    updated++;
  }
  if (updated > 0) {
    saveAgents(agents);
    console.log(`[memory] recorded experiences for ${updated} agent(s)`);
  }
}

function daysAgoLabel(timestamp: string, now = Date.now()): string {
  const days = Math.floor((now - new Date(timestamp).getTime()) / 86_400_000);
  if (days <= 0) return "earlier today";
  if (days === 1) return "yesterday";
  return `${days} days ago`;
}

/** システムプロンプトに注入する「前回までの体験」セクションを生成する */
export function formatAgentMemories(agent: Agent): string {
  const memories = agent.memories ?? [];
  if (memories.length === 0) return "";

  const lines: string[] = [];
  for (const m of memories) {
    const when = daysAgoLabel(m.timestamp);
    for (const f of m.frustrations) lines.push(`- (${when}) ${f}`);
    for (const a of m.achievements) lines.push(`- (${when}) ✓ ${a}`);
  }
  if (lines.length === 0) return "";

  return `
[Your Memory from Previous Visits]
You have used this app before. Notes from your previous visits:
${lines.join("\n")}

You are a RETURNING user. Early in this session, revisit what frustrated you:
- If something you struggled with has improved, say so — post_feedback (category "ux") noting the improvement you noticed as a returning user.
- If it is still broken or missing, report it again with fresh details, mentioning that it has not changed since your last visit.
Then continue exploring new areas as usual.`;
}
