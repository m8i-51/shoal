/**
 * llm-client.ts
 * LLM プロバイダ抽象化レイヤー
 *
 * 環境変数:
 *   LLM_PROVIDER=anthropic (デフォルト) | openai
 *   LLM_BASE_URL=http://localhost:11434/v1  ← Ollama/LM Studio の場合
 *   LLM_MODEL=llama3.2  ← ローカルモデル名（未指定時はデフォルトモデルを使用）
 *   LLM_API_KEY=ollama   ← ローカルLLMはダミーキーでよい
 */

import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ---- 型定義（Anthropic 互換） ----

export type MessageParam = Anthropic.MessageParam;
export type Tool = Anthropic.Tool;
export type Message = Anthropic.Message;
export type ContentBlock = Anthropic.ContentBlock;
export type ToolUseBlock = Anthropic.ToolUseBlock;
export type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  system: string;
  tools: Tool[];
  messages: MessageParam[];
}

// ---- Anthropic クライアント ----

class AnthropicClient {
  private client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async createMessage(params: CreateMessageParams): Promise<Message> {
    return this.client.messages.create(params) as Promise<Message>;
  }
}

// ---- OpenAI 互換クライアント ----

function toOpenAITools(tools: Tool[]): OpenAI.ChatCompletionTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema as Record<string, unknown>,
    },
  }));
}

function toOpenAIMessages(
  system: string,
  messages: MessageParam[]
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [
    { role: "system", content: system },
  ];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        // tool_result ブロックを OpenAI の tool メッセージに変換
        const toolResults = msg.content.filter(
          (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result"
        );
        const textBlocks = msg.content.filter(
          (b): b is Anthropic.TextBlockParam => b.type === "text"
        );

        for (const tr of toolResults) {
          const content =
            typeof tr.content === "string"
              ? tr.content
              : Array.isArray(tr.content)
              ? tr.content
                  .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
                  .map((b) => b.text)
                  .join("\n")
              : "";
          result.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content,
          });
        }
        if (textBlocks.length > 0) {
          result.push({
            role: "user",
            content: textBlocks.map((b) => b.text).join("\n"),
          });
        }
      }
    } else if (msg.role === "assistant") {
      if (typeof msg.content === "string") {
        result.push({ role: "assistant", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const textBlocks = msg.content.filter(
          (b): b is Anthropic.TextBlockParam => b.type === "text"
        );
        const toolUses = msg.content.filter(
          (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
        );

        result.push({
          role: "assistant",
          content: textBlocks.map((b) => b.text).join("\n") || null,
          tool_calls:
            toolUses.length > 0
              ? toolUses.map((tu) => ({
                  id: tu.id,
                  type: "function" as const,
                  function: {
                    name: tu.name,
                    arguments: JSON.stringify(tu.input),
                  },
                }))
              : undefined,
        });
      }
    }
  }

  return result;
}

function fromOpenAIResponse(response: OpenAI.ChatCompletion): Message {
  const choice = response.choices[0];
  const content: ContentBlock[] = [];

  if (choice.message.content) {
    content.push({ type: "text", text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments);
      } catch { /* ignore parse error */ }

      content.push({
        type: "tool_use",
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  const stopReason = choice.finish_reason === "tool_calls" ? "tool_use" : "end_turn";

  return {
    id: response.id,
    type: "message",
    role: "assistant",
    content,
    model: response.model,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: response.usage?.prompt_tokens ?? 0,
      output_tokens: response.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Message;
}

class OpenAICompatClient {
  private client: OpenAI;
  private defaultModel: string;

  constructor(apiKey: string, baseURL?: string, defaultModel?: string) {
    this.client = new OpenAI({ apiKey, baseURL });
    this.defaultModel = defaultModel ?? "gpt-4o-mini";
  }

  async createMessage(params: CreateMessageParams): Promise<Message> {
    const response = await this.client.chat.completions.create({
      model: params.model || this.defaultModel,
      max_tokens: params.max_tokens,
      tools: toOpenAITools(params.tools),
      tool_choice: "auto",
      messages: toOpenAIMessages(params.system, params.messages),
    });
    return fromOpenAIResponse(response);
  }
}

// ---- ファクトリ ----

export type LLMClient = AnthropicClient | OpenAICompatClient;

export function createLLMClient(): { client: LLMClient; defaultModel: string } {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  const baseURL = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL ?? "claude-haiku-4-5-20251001";

  if (provider === "openai" || baseURL) {
    const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "ollama";
    const effectiveBaseURL = baseURL ?? "https://api.openai.com/v1";
    console.log(`[LLM] プロバイダ: OpenAI 互換 (${effectiveBaseURL}), モデル: ${model}`);
    return {
      client: new OpenAICompatClient(apiKey, effectiveBaseURL, model),
      defaultModel: model,
    };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  console.log(`[LLM] プロバイダ: Anthropic, モデル: ${model}`);
  return {
    client: new AnthropicClient(apiKey),
    defaultModel: model,
  };
}
