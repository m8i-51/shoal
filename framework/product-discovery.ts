import * as fs from "fs";
import * as path from "path";
import type { Page } from "playwright";
import type { LLMClient } from "./llm-client";
import { createMessageWithRetry } from "./agent-loop";
import Anthropic from "@anthropic-ai/sdk";

export interface ProductSpec {
  appName: string;
  appDescription: string;
  targetUsers: string;
  features: string;
  confidence: "high" | "medium" | "low";
  sources: string[];
  discoveredAt?: string;
}

function specCachePath(baseUrl: string): string {
  const host = new URL(baseUrl).host.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(process.cwd(), "product-specs", `${host}.json`);
}

export function loadCachedSpec(baseUrl: string): ProductSpec | null {
  const filePath = specCachePath(baseUrl);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as ProductSpec;
  } catch {
    return null;
  }
}

function saveSpec(baseUrl: string, spec: ProductSpec): void {
  const filePath = specCachePath(baseUrl);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(spec, null, 2), "utf-8");
  console.log(`  [product-discovery] spec saved: ${filePath}`);
}

function printSpec(spec: ProductSpec): void {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`  app: ${spec.appName}`);
  console.log(`  description: ${spec.appDescription}`);
  console.log(`  users: ${spec.targetUsers}`);
  console.log(`  features:\n${spec.features.split("\n").map((l) => `    ${l}`).join("\n")}`);
  console.log(`  confidence: ${spec.confidence} / sources: ${spec.sources.join(", ")}`);
  console.log(`${"─".repeat(60)}\n`);
}

const DISCOVERY_TOOLS: Anthropic.Tool[] = [
  {
    name: "navigate_and_read",
    description: "Navigate to a path and read page text + ARIA tree / アプリの指定パスに移動しテキストとARIAツリーを取得する",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path to observe (e.g. /, /tasks, /purchases)" },
      },
      required: ["path"],
    },
  },
  {
    name: "fetch_url",
    description: "Fetch text content from an external URL (README, About page, etc.) / 外部URLのテキストを取得する",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to fetch" },
      },
      required: ["url"],
    },
  },
  {
    name: "output_spec",
    description: "Finalize and output the product spec once enough information has been gathered / 十分な情報が集まったらプロダクト仕様を確定して出力する",
    input_schema: {
      type: "object",
      properties: {
        appName: { type: "string", description: "App name" },
        appDescription: { type: "string", description: "What the app does, who it's for, and its main value (2-3 sentences)" },
        targetUsers: { type: "string", description: "Target users: roles, technical level, usage scenarios" },
        features: { type: "string", description: "Implemented features, listed per screen as bullet points" },
        confidence: {
          type: "string",
          enum: ["high", "medium", "low"],
          description: "Inference confidence: high if README/docs obtained, low if UI observation only",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Sources used (e.g. ['/ (top page)', '/tasks (UI)', 'README'])",
        },
      },
      required: ["appName", "appDescription", "targetUsers", "features", "confidence", "sources"],
    },
  },
];

export async function discoverProduct(
  baseUrl: string,
  page: Page,
  client: LLMClient,
  model: string
): Promise<ProductSpec> {
  console.log("\n[product-discovery] starting...");

  const systemPrompt = `You are a product discovery agent.
Observe the given web app and infer what it is.

Steps:
1. Use navigate_and_read to observe the top page
2. Observe 2-3 key screens (follow tabs or navigation)
3. If a README or About page is available, fetch it with fetch_url
4. Once you have enough information, call output_spec (finish within 6 observations)

Guidelines for output_spec:
- appDescription: 2-3 sentences covering who uses it, why, and the main value
- targetUsers: roles, technical level, and usage scenarios (be specific)
- features: list per screen as "Screen name: feature 1 · feature 2 · feature 3"
- confidence: high if README/official docs obtained, low if UI observation only`;

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `App URL: ${baseUrl}\n\nInvestigate what this app is.` },
  ];

  let spec: ProductSpec | null = null;
  let iterations = 0;

  while (iterations < 8 && !spec) {
    iterations++;

    const response = await createMessageWithRetry(client, {
      model,
      max_tokens: 2048,
      system: systemPrompt,
      tools: DISCOVERY_TOOLS,
      messages,
    });

    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
    );
    if (toolUses.length === 0 || response.stop_reason === "end_turn") break;

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      let result: string;

      if (toolUse.name === "navigate_and_read") {
        const { path } = toolUse.input as { path: string };
        try {
          await page.goto(`${baseUrl}${path}`, { waitUntil: "networkidle", timeout: 10000 });
          await page.waitForTimeout(500);
          const [text, aria] = await Promise.all([
            page.evaluate(() => document.body.innerText.slice(0, 1500)),
            page.ariaSnapshot({ mode: "ai", depth: 5 }).then((s) => s.slice(0, 1500)),
          ]);
          result = `[${path} text]\n${text}\n\n[ARIA tree]\n${aria}`;
          console.log(`  [product-discovery] observed: ${path}`);
        } catch (e) {
          result = `fetch failed: ${String(e)}`;
        }

      } else if (toolUse.name === "fetch_url") {
        const { url } = toolUse.input as { url: string };
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
          const text = await res.text();
          result = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 2000);
          console.log(`  [product-discovery] fetched: ${url}`);
        } catch (e) {
          result = `fetch failed: ${String(e)}`;
        }

      } else if (toolUse.name === "output_spec") {
        const input = toolUse.input as ProductSpec;
        spec = {
          appName: String(input.appName),
          appDescription: String(input.appDescription),
          targetUsers: String(input.targetUsers),
          features: String(input.features),
          confidence: input.confidence,
          sources: Array.isArray(input.sources) ? input.sources.map(String) : [],
        };
        result = "product spec finalized";
        console.log(`  [product-discovery] spec confirmed (confidence: ${spec.confidence})`);

      } else {
        result = "unknown tool";
      }

      toolResults.push({ type: "tool_result", tool_use_id: toolUse.id, content: result });
    }

    messages.push({ role: "user", content: toolResults });
  }

  if (!spec) {
    console.log("  [product-discovery] spec not confirmed, using fallback");
    spec = {
      appName: new URL(baseUrl).hostname,
      appDescription: "(auto-discovery failed)",
      targetUsers: "(unknown)",
      features: "(auto-discovery failed)",
      confidence: "low",
      sources: [],
    };
  }

  spec.discoveredAt = new Date().toISOString();
  saveSpec(baseUrl, spec);
  console.log(`[product-discovery] done: "${spec.appName}" (confidence: ${spec.confidence})`);
  printSpec(spec);
  return spec;
}
