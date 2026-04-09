/**
 * Example target — copy this file and adapt it to your app.
 *
 * A target connects shoal to your app's API.
 * Define the tools agents can call, then implement the execute() handler.
 */
import type { TargetConfig } from "./types";

const BASE_URL = process.env.BASE_URL ?? "http://localhost:3000";

async function api(endpoint: string, method = "GET", body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return text ? JSON.parse(text) : { ok: res.ok };
}

export const exampleConfig: TargetConfig = {
  appTools: [
    // Define the API tools agents can call.
    // Each tool is described in plain English so agents know when and how to use it.
    {
      name: "get_items",
      description: "Get a list of items from the app.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "create_item",
      description: "Create a new item.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Item title" },
          description: { type: "string", description: "Item description (optional)" },
        },
        required: ["title"],
      },
    },
    // Add more tools as needed...
  ],

  async execute(toolName, input, agentId) {
    switch (toolName) {
      case "get_items":
        return api("/api/items");
      case "create_item":
        return api("/api/items", "POST", { ...input, createdBy: agentId });
      default:
        return { error: "unknown tool" };
    }
  },
};
