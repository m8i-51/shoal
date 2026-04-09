import * as fs from "fs";
import * as path from "path";

export interface Agent {
  id: string;
  name: string;
  role: string;
  persona: string;
  createdAt: string;
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
