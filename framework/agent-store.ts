import * as fs from "fs";
import * as path from "path";

/** 1 run 分のエージェント個人の体験記録 */
export interface AgentMemory {
  runId: string;
  timestamp: string;
  frustrations: string[]; // 未達成シナリオの理由・報告した finding
  achievements: string[]; // 達成したシナリオ
}

export interface Agent {
  id: string;
  name: string;
  role: string;
  persona: string;
  createdAt: string;
  memories?: AgentMemory[]; // 直近 MAX_MEMORIES run 分のみ保持
}

const STORE_PATH = path.join(process.cwd(), "agents.json");

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

export function addAgent(input: { name: string; role: string; persona: string }): Agent {
  const agents = loadAgents();
  const agent: Agent = {
    id: `agent_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    name: input.name,
    role: input.role,
    persona: input.persona,
    createdAt: new Date().toISOString(),
  };
  agents.push(agent);
  saveAgents(agents);
  return agent;
}

export function retireAgent(id: string): boolean {
  const agents = loadAgents();
  const filtered = agents.filter((a) => a.id !== id);
  if (filtered.length === agents.length) return false;
  saveAgents(filtered);
  return true;
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
