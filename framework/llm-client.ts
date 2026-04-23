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
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

// ---- Codex (ChatGPT subscription OAuth) ----

const CODEX_AUTH_PATH = path.join(os.homedir(), ".codex", "auth.json");
const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token";

interface CodexAuthFile {
  tokens: {
    access_token: string;
    id_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh: string;
}

function parseJwtAccountId(idToken: string): string {
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf-8"));
    return (payload["https://api.openai.com/auth"] as Record<string, string>)?.account_id ?? "";
  } catch {
    return "";
  }
}

async function loadCodexToken(): Promise<{ accessToken: string; accountId: string }> {
  if (!fs.existsSync(CODEX_AUTH_PATH)) {
    throw new Error(`${CODEX_AUTH_PATH} not found. Run: npm run auth:codex`);
  }

  const auth: CodexAuthFile = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, "utf-8"));
  const ageMinutes = (Date.now() - new Date(auth.last_refresh).getTime()) / 60_000;

  if (ageMinutes > 55) {
    const refreshed = await refreshCodexToken(auth.tokens.refresh_token);
    auth.tokens.access_token = refreshed.access_token;
    auth.tokens.id_token = refreshed.id_token;
    if (refreshed.refresh_token) auth.tokens.refresh_token = refreshed.refresh_token;
    auth.last_refresh = new Date().toISOString();
    fs.writeFileSync(CODEX_AUTH_PATH, JSON.stringify(auth, null, 2));
  }

  const accountId = auth.tokens.account_id ?? parseJwtAccountId(auth.tokens.id_token);
  return { accessToken: auth.tokens.access_token, accountId };
}

async function refreshCodexToken(refreshToken: string): Promise<{ access_token: string; id_token: string; refresh_token?: string }> {
  const res = await fetch(CODEX_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
  });
  if (!res.ok) throw new Error(`Codex token refresh failed: ${res.status} ${await res.text()}`);
  return res.json() as Promise<{ access_token: string; id_token: string; refresh_token?: string }>;
}

async function collectCodexSseResponse(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  const eventTypes: string[] = [];
  // Track completed output items manually — response.completed may have output: []
  const outputItems: Record<string, unknown>[] = [];
  let completedResponse: Record<string, unknown> | null = null;

  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
      eventTypes.push(event.type as string);

      // Collect each completed output item (message, function_call, etc.)
      if (event.type === "response.output_item.done") {
        const item = event.item as Record<string, unknown>;
        if (item?.type !== "reasoning") outputItems.push(item);
      }

      if (event.type === "response.completed" || event.type === "response.done") {
        completedResponse = event.response as Record<string, unknown>;
      }
    } catch { /* ignore malformed lines */ }
  }

  if (completedResponse) {
    // Prefer manually collected items over response.output (which can be empty)
    const output = (completedResponse.output as unknown[])?.length
      ? completedResponse.output
      : outputItems;
    return { ...completedResponse, output };
  }

  throw new Error(`No completed response found in Codex SSE stream. Events seen: ${eventTypes.join(", ")}`);
}

// Replace lone surrogates that cause JSON serialization errors
function sanitizeStr(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

function toCodexInput(messages: MessageParam[]): unknown[] {
  const result: unknown[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        result.push({ role: "user", content: msg.content });
      } else if (Array.isArray(msg.content)) {
        const toolResults = msg.content.filter(
          (b): b is Anthropic.ToolResultBlockParam => b.type === "tool_result"
        );
        const textBlocks = msg.content.filter(
          (b): b is Anthropic.TextBlockParam => b.type === "text"
        );
        for (const tr of toolResults) {
          const output =
            typeof tr.content === "string"
              ? tr.content
              : Array.isArray(tr.content)
              ? tr.content.filter((b): b is Anthropic.TextBlockParam => b.type === "text").map(b => b.text).join("\n")
              : "";
          result.push({ type: "function_call_output", call_id: tr.tool_use_id, output: sanitizeStr(output) });
        }
        if (textBlocks.length > 0) {
          result.push({ role: "user", content: textBlocks.map(b => b.text).join("\n") });
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
        if (textBlocks.length > 0) {
          result.push({ role: "assistant", content: textBlocks.map(b => b.text).join("\n") });
        }
        for (const tu of toolUses) {
          result.push({
            type: "function_call",
            call_id: tu.id,
            name: tu.name,
            arguments: JSON.stringify(tu.input),
          });
        }
      }
    }
  }

  return result;
}

function toCodexTools(tools: Tool[]): unknown[] {
  return tools.map(t => ({
    type: "function",
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema,
  }));
}

function fromCodexResponse(response: Record<string, unknown>): Message {
  const output = (response.output as unknown[]) ?? [];
  const content: ContentBlock[] = [];
  let hasToolUse = false;

  for (const item of output) {
    const i = item as Record<string, unknown>;
    if (i.type === "message") {
      for (const block of (i.content as unknown[]) ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type === "output_text") content.push({ type: "text", text: b.text as string });
      }
    } else if (i.type === "function_call") {
      hasToolUse = true;
      let input: Record<string, unknown> = {};
      try { input = JSON.parse(i.arguments as string); } catch { /* ignore */ }
      content.push({
        type: "tool_use",
        id: (i.call_id ?? i.id) as string,
        name: i.name as string,
        input,
      });
    }
  }

  const usage = (response.usage as Record<string, number> | undefined) ?? {};

  return {
    id: response.id as string,
    type: "message",
    role: "assistant",
    content,
    model: response.model as string,
    stop_reason: hasToolUse ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input_tokens ?? 0,
      output_tokens: usage.output_tokens ?? 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  } as unknown as Message;
}

class CodexClient {
  private defaultModel: string;

  constructor(defaultModel: string) {
    this.defaultModel = defaultModel;
  }

  async createMessage(params: CreateMessageParams): Promise<Message> {
    const { accessToken, accountId } = await loadCodexToken();

    const res = await fetch(`${CODEX_BASE_URL}/responses`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${accessToken}`,
        "chatgpt-account-id": accountId,
        "OpenAI-Beta": "responses=experimental",
      },
      body: (() => {
        const b = JSON.stringify({
          model: params.model || this.defaultModel,
          instructions: params.system || "",
          input: toCodexInput(params.messages),
          tools: toCodexTools(params.tools),
          store: false,
          stream: true,
        });
        return b;
      })(),
    });

    if (!res.ok) {
      throw new Error(`Codex API error: ${res.status} ${await res.text()}`);
    }

    const response = await collectCodexSseResponse(res);
    return fromCodexResponse(response);
  }
}

// ---- Factory ----

export type LLMClient = AnthropicClient | OpenAICompatClient | CodexClient;

// OpenAI-compat プロバイダのデフォルト設定
// LLM_BASE_URL / LLM_MODEL で個別上書き可能
const COMPAT_PROVIDERS: Record<string, { baseURL: string; defaultModel: string }> = {
  ollama:       { baseURL: "http://localhost:11434/v1",                               defaultModel: "llama3.2" },
  "lm-studio":  { baseURL: "http://localhost:1234/v1",                                defaultModel: "" },
  groq:         { baseURL: "https://api.groq.com/openai/v1",                         defaultModel: "llama-3.3-70b-versatile" },
  gemini:       { baseURL: "https://generativelanguage.googleapis.com/v1beta/openai", defaultModel: "gemini-2.0-flash" },
  openai:       { baseURL: "https://api.openai.com/v1",                              defaultModel: "gpt-4o-mini" },
  openrouter:   { baseURL: "https://openrouter.ai/api/v1",                           defaultModel: "google/gemini-flash-1.5" },
};

export function createLLMClient(): { client: LLMClient; defaultModel: string } {
  const provider = process.env.LLM_PROVIDER ?? "anthropic";
  const baseURL = process.env.LLM_BASE_URL;
  const model = process.env.LLM_MODEL;

  // Codex は独自クライアント
  if (provider === "codex") {
    const effectiveModel = model ?? "gpt-5.1-codex-mini";
    console.log(`[LLM] provider: Codex (ChatGPT subscription), model: ${effectiveModel}`);
    return {
      client: new CodexClient(effectiveModel),
      defaultModel: effectiveModel,
    };
  }

  // OpenAI-compat: 既知プロバイダ名 または LLM_BASE_URL が設定されている場合
  const compatDefaults = COMPAT_PROVIDERS[provider];
  if (compatDefaults || baseURL) {
    const apiKey = process.env.LLM_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
    const effectiveBaseURL = baseURL ?? compatDefaults?.baseURL ?? "https://api.openai.com/v1";
    const effectiveModel = model ?? compatDefaults?.defaultModel ?? "gpt-4o-mini";
    console.log(`[LLM] provider: ${provider} (${effectiveBaseURL}), model: ${effectiveModel}`);
    return {
      client: new OpenAICompatClient(apiKey, effectiveBaseURL, effectiveModel),
      defaultModel: effectiveModel,
    };
  }

  // Anthropic (default)
  const apiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const effectiveModel = model ?? "claude-haiku-4-5-20251001";
  console.log(`[LLM] provider: Anthropic, model: ${effectiveModel}`);
  return {
    client: new AnthropicClient(apiKey),
    defaultModel: effectiveModel,
  };
}
