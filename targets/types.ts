import type { Tool } from "../framework/llm-client";

export interface Credentials {
  email: string;
  password: string;
}

export interface TargetConfig {
  appTools: Tool[];
  execute(toolName: string, input: Record<string, unknown>, agentId: string): Promise<unknown>;
  /** Optional: absolute path to the project repository on the local filesystem.
   *  If set, product-discovery will scan for README/docs/openapi files here.
   *  If not set but GITHUB_REPO is set, it will fetch the README from GitHub instead. */
  projectPath?: string;
  /** Optional: seed credentials for the Account Manager agent.
   *  If set, shoal will log in, discover roles, create test accounts per role,
   *  and run all browser agents in authenticated sessions. */
  credentials?: Credentials;
}
