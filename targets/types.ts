import type { Tool } from "../framework/llm-client";

export interface TargetConfig {
  appTools: Tool[];
  execute(toolName: string, input: Record<string, unknown>, agentId: string): Promise<unknown>;
}
