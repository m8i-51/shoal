import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("fs");

import * as fs from "fs";
import { loadAgents, addAgent, retireAgent, recordAgentMemories, formatAgentMemories, type Agent, type AgentMemory } from "../agent-store";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: "agent_1",
    name: "Alice",
    role: "tester",
    persona: "curious QA",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(fs.existsSync).mockReturnValue(false);
  vi.mocked(fs.readFileSync).mockReturnValue("[]" as unknown as ReturnType<typeof fs.readFileSync>);
  vi.mocked(fs.writeFileSync).mockReset().mockReturnValue(undefined);
});

describe("loadAgents", () => {
  it("ファイルが存在しない場合は空配列を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(loadAgents()).toEqual([]);
  });

  it("ファイルが存在する場合はパースして返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([makeAgent()]) as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadAgents()).toEqual([makeAgent()]);
  });

  it("壊れた JSON の場合は空配列を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue("not json" as unknown as ReturnType<typeof fs.readFileSync>);
    expect(loadAgents()).toEqual([]);
  });
});

describe("addAgent", () => {
  it("新しい agent を作成して保存する", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const agent = addAgent({ name: "Bob", role: "explorer", persona: "thorough" });
    expect(agent.name).toBe("Bob");
    expect(agent.role).toBe("explorer");
    expect(agent.persona).toBe("thorough");
    expect(agent.id).toMatch(/^agent_\d+_[a-z0-9]+$/);
    expect(fs.writeFileSync).toHaveBeenCalled();
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    const saved = JSON.parse(content as string) as Agent[];
    expect(saved).toHaveLength(1);
    expect(saved[0].name).toBe("Bob");
  });

  it("既存の agent リストに追加する（既存分は保持される）", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([makeAgent({ id: "agent_existing" })]) as unknown as ReturnType<typeof fs.readFileSync>);
    addAgent({ name: "New", role: "r", persona: "p" });
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    const saved = JSON.parse(content as string) as Agent[];
    expect(saved).toHaveLength(2);
    expect(saved[0].id).toBe("agent_existing");
  });

  it("2回呼ぶと異なる id が生成される", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const a = addAgent({ name: "A", role: "r", persona: "p" });
    const b = addAgent({ name: "B", role: "r", persona: "p" });
    expect(a.id).not.toBe(b.id);
  });
});

describe("retireAgent", () => {
  it("存在する id を削除して true を返す", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(
      JSON.stringify([makeAgent({ id: "agent_1" }), makeAgent({ id: "agent_2" })]) as unknown as ReturnType<typeof fs.readFileSync>
    );
    const result = retireAgent("agent_1");
    expect(result).toBe(true);
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    const saved = JSON.parse(content as string) as Agent[];
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe("agent_2");
  });

  it("存在しない id の場合は false を返し書き込みもしない", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify([makeAgent({ id: "agent_1" })]) as unknown as ReturnType<typeof fs.readFileSync>);
    const result = retireAgent("agent_nonexistent");
    expect(result).toBe(false);
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });
});

describe("recordAgentMemories", () => {
  function setupAgents(agents: Agent[]) {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(agents) as unknown as ReturnType<typeof fs.readFileSync>);
  }

  function readSaved(): Agent[] {
    const [, content] = vi.mocked(fs.writeFileSync).mock.calls[0];
    return JSON.parse(content as string) as Agent[];
  }

  it("体験のあるエージェントに memory を追記する", () => {
    setupAgents([makeAgent({ id: "agent_1" }), makeAgent({ id: "agent_2" })]);
    recordAgentMemories("run_10", new Map([
      ["agent_1", { frustrations: ["Could not find export"], achievements: ['Completed "Submit request"'] }],
    ]));
    const saved = readSaved();
    expect(saved[0].memories).toHaveLength(1);
    expect(saved[0].memories![0].runId).toBe("run_10");
    expect(saved[0].memories![0].frustrations).toEqual(["Could not find export"]);
    expect(saved[1].memories).toBeUndefined();
  });

  it("空の体験しかない場合は書き込まない", () => {
    setupAgents([makeAgent({ id: "agent_1" })]);
    recordAgentMemories("run_10", new Map([
      ["agent_1", { frustrations: [], achievements: [] }],
    ]));
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("直近 3 run 分だけ保持する", () => {
    const oldMemories: AgentMemory[] = ["run_1", "run_2", "run_3"].map((runId) => ({
      runId, timestamp: "2026-01-01T00:00:00.000Z", frustrations: ["old"], achievements: [],
    }));
    setupAgents([makeAgent({ id: "agent_1", memories: oldMemories })]);
    recordAgentMemories("run_4", new Map([
      ["agent_1", { frustrations: ["new"], achievements: [] }],
    ]));
    const saved = readSaved();
    expect(saved[0].memories!.map((m) => m.runId)).toEqual(["run_2", "run_3", "run_4"]);
  });

  it("1 run あたりの項目数を 5 件に制限する", () => {
    setupAgents([makeAgent({ id: "agent_1" })]);
    recordAgentMemories("run_1", new Map([
      ["agent_1", { frustrations: ["a", "b", "c", "d", "e", "f", "g"], achievements: [] }],
    ]));
    const saved = readSaved();
    expect(saved[0].memories![0].frustrations).toHaveLength(5);
  });
});

describe("formatAgentMemories", () => {
  it("memory がないエージェントは空文字を返す", () => {
    expect(formatAgentMemories(makeAgent())).toBe("");
    expect(formatAgentMemories(makeAgent({ memories: [] }))).toBe("");
  });

  it("frustrations と achievements を経過日数付きで整形する", () => {
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const agent = makeAgent({
      memories: [{
        runId: "run_1",
        timestamp: twoDaysAgo,
        frustrations: ['Could not complete "Checkout" — button missing'],
        achievements: ['Completed "Sign up"'],
      }],
    });
    const text = formatAgentMemories(agent);
    expect(text).toContain("[Your Memory from Previous Visits]");
    expect(text).toContain('(2 days ago) Could not complete "Checkout" — button missing');
    expect(text).toContain('(2 days ago) ✓ Completed "Sign up"');
    expect(text).toContain("RETURNING user");
  });

  it("当日の memory は earlier today と表示する", () => {
    const agent = makeAgent({
      memories: [{ runId: "run_1", timestamp: new Date().toISOString(), frustrations: ["x"], achievements: [] }],
    });
    expect(formatAgentMemories(agent)).toContain("(earlier today) x");
  });
});
