/**
 * Shared tool session types used by Messages API loops and Claude CLI / Agent SDK.
 */
import type Anthropic from "@anthropic-ai/sdk";

export type ToolResultContent = string | Anthropic.ToolResultBlockParam["content"];

export interface SessionTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<ToolResultContent>;
}

export type UserPrompt =
  | string
  | Anthropic.ContentBlockParam[]
  | Anthropic.MessageParam["content"];

export interface ToolSessionParams {
  provider: string;
  model: string;
  system: string;
  userPrompt: UserPrompt;
  tools: SessionTool[];
  maxIterations: number;
  maxTokens?: number;
  /** Called after a batch of tool executions (Messages path) or after each MCP tool (CLI path). */
  onAfterTools?: (ctx: {
    toolUses: { name: string; input: Record<string, unknown>; id: string }[];
    results: Anthropic.ToolResultBlockParam[];
    iteration: number;
    maxIterations: number;
  }) => void | Promise<void>;
  /** Return true to stop the session early (e.g. after output_spec / done). */
  shouldStop?: (ctx: {
    toolUses: { name: string; input: Record<string, unknown>; id: string }[];
    iteration: number;
  }) => boolean;
  /** Optional LLM client for Messages-compatible providers. */
  client?: { createMessage: (params: import("./llm-client").CreateMessageParams) => Promise<Anthropic.Message> };
}

export interface ToolSessionResult {
  text: string;
  toolCaptures: Record<string, unknown>;
  iterations: number;
}
