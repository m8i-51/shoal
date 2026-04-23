import type { Tool } from "../framework/llm-client";

export interface TargetConfig {
  appTools: Tool[];
  execute(toolName: string, input: Record<string, unknown>, agentId: string): Promise<unknown>;
  /** Optional: absolute path to the project repository on the local filesystem.
   *  If set, product-discovery will scan for README/docs/openapi files here.
   *  If not set but GITHUB_REPO is set, it will fetch the README from GitHub instead. */
  projectPath?: string;
}
