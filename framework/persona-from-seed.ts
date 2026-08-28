import { createLLMClient, type LLMClient } from "./llm-client.js";
import { completeText } from "./tool-session.js";
import type { ProductSpec } from "./product-discovery.js";

export interface GeneratedPersonaFields {
  name: string;
  role: string;
  persona: string;
  lenses: string[];
  accountRole?: string;
}

export class PersonaGenerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaGenerationError";
  }
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PersonaGenerationError(`generated persona missing ${field}`);
  }
  return value.trim();
}

/** Parse and validate LLM JSON into persona fields. Exported for unit tests. */
export function parseGeneratedPersona(raw: unknown): GeneratedPersonaFields {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new PersonaGenerationError("generated persona must be an object");
  }
  const obj = raw as Record<string, unknown>;
  const name = requireNonEmpty(obj.name, "name");
  const role = requireNonEmpty(obj.role, "role");
  const persona = requireNonEmpty(obj.persona, "persona");

  let lenses: string[] = [];
  if (obj.lenses !== undefined) {
    if (!Array.isArray(obj.lenses) || !obj.lenses.every((l) => typeof l === "string")) {
      throw new PersonaGenerationError("generated persona lenses must be an array of strings");
    }
    lenses = obj.lenses.map((l) => l.trim()).filter(Boolean);
  }
  if (lenses.length === 0) {
    throw new PersonaGenerationError("generated persona must include at least one lens");
  }

  const accountRole = typeof obj.accountRole === "string" && obj.accountRole.trim() !== ""
    ? obj.accountRole.trim()
    : undefined;

  return { name, role, persona, lenses, ...(accountRole ? { accountRole } : {}) };
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : trimmed;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new PersonaGenerationError("LLM response did not contain a JSON object");
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new PersonaGenerationError("LLM response JSON was invalid");
  }
}

export async function generatePersonaFromSeed(
  seed: string,
  spec: ProductSpec,
  opts: { client?: LLMClient; model?: string } = {},
): Promise<GeneratedPersonaFields> {
  const trimmedSeed = seed.trim();
  if (!trimmedSeed) {
    throw new PersonaGenerationError("seed is required");
  }

  const { client, defaultModel, provider } = opts.client
    ? { client: opts.client, defaultModel: opts.model ?? "test-model", provider: process.env.LLM_PROVIDER ?? "anthropic" }
    : createLLMClient();
  const model = opts.model ?? defaultModel;

  const goals = (spec.appGoals ?? []).filter((g) => typeof g === "string" && g.trim());
  const goalsBlock = goals.length > 0 ? goals.map((g) => `- ${g}`).join("\n") : "(none listed)";

  const text = await completeText({
    provider,
    client,
    model,
    maxTokens: 1024,
    system: `You expand a short persona seed into a concrete test-user persona for an AI exploration swarm.
Return ONLY a JSON object (no markdown prose) with keys:
- name: a human first name (string)
- role: short narrative role as a real user of this app (string) — this may be descriptive
- accountRole: short test-account role token such as user, instructor, or admin — NOT a narrative description
- persona: 2–4 sentences describing background, motivations, and how they use the app (string)
- lenses: 1–4 evaluation perspectives as short strings (array)

Rules:
- Ground the persona in THIS product's users and goals — not a generic QA engineer.
- Reflect the seed's character (tone, quirks, intent) vividly.
- Prefer end-user roles over professional auditor titles unless the seed clearly asks for that.`,
    userPrompt: `App: ${spec.appName}
Description: ${spec.appDescription}
Target users: ${spec.targetUsers}
App goals:
${goalsBlock}

Seed: ${trimmedSeed}

Expand this seed into the JSON object described above.`,
  });

  return parseGeneratedPersona(extractJsonObject(text));
}
