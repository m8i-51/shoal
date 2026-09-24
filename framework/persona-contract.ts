/**
 * Behavioral persona contract — how this person actually uses a screen,
 * not a demographic bio. Two contracts on the same 4-step tutorial should
 * fork (mash Next unread vs read every step).
 */

import * as log from "./log";

export class PersonaContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PersonaContractError";
  }
}

export interface PersonaBehavioralRules {
  discovery: string;
  comprehension: string;
  helpSeeking: string;
  exploration: string;
}

export interface PersonaKnowledgeBoundary {
  doesNotKnow: string[];
  mayInferFrom: string[];
}

export interface PersonaStateRules {
  confusionIncreasesWhen: string[];
  confusionDecreasesWhen: string[];
}

export const PERSONA_INFORMATION = ["informed", "first-run"] as const;
export type PersonaInformation = (typeof PERSONA_INFORMATION)[number];

export const BROWSER_INFORMATION_MODES = ["mixed", "first-run", "informed"] as const;
export type BrowserInformationMode = (typeof BROWSER_INFORMATION_MODES)[number];

export type AgentLane = "browser" | "explorer" | "threshold" | "regression";

export interface PersonaContract {
  /** Short behavioral signature shown in the roster (not age/job). */
  traits: string;
  behavioralRules: PersonaBehavioralRules;
  knowledgeBoundary: PersonaKnowledgeBoundary;
  stateRules: PersonaStateRules;
  abandonment: string[];
  /** Omitted on legacy contracts → informed. */
  information?: PersonaInformation;
}

const TRAITS_MAX = 160;
const RULE_MAX = 280;
const ITEM_MAX = 200;
const LIST_MAX = 6;

/** Shared instructions for seed generation and HR `add_agent`. */
export const PERSONA_CONTRACT_GENERATION_SPEC = `contract (required object): how this person BEHAVES on a screen. Not a biography, not an evaluation lens.
Two people looking at the same 4-step tutorial must fork — one mashes Next and closes it unread; another reads every step. If two recruits would both read carefully, rewrite one of them.
Fields:
- traits: short behavioral signature (e.g. "speeds through copy, skims numbers, wants a score to show someone" / "cautious, reads before tapping, resolves unknowns herself")
- behavioralRules.discovery: how they first look at a new screen (scroll depth, what they open)
- behavioralRules.comprehension: how they read. This is the tutorial fork.
- behavioralRules.helpSeeking: in-app help / ask a colleague / give up
- behavioralRules.exploration: how far they wander
- knowledgeBoundary.doesNotKnow: product facts they do not have. Do NOT pour the feature list into their head just because the model knows it.
- knowledgeBoundary.mayInferFrom: what they may use (visible labels, buttons, as much body copy as Comprehension allows)
- stateRules.confusionIncreasesWhen / confusionDecreasesWhen: observable conditions
- abandonment: stop conditions; any one is enough to leave
- information: "informed" (default — gets the product brief and diagnostic tools) or "first-run" (screen only: no spec, no console, no a11y tree). If the active roster has no first-run person and this recruit is a new-user lens, set first-run. Never set first-run on accessibility or security specialists.`;

function clip(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max);
}

function requireString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new PersonaContractError(`contract.${field} is required`);
  }
  return clip(value.trim(), max);
}

function requireStringList(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    throw new PersonaContractError(`contract.${field} must be an array of strings`);
  }
  const items = value
    .map((v) => clip(v.trim(), ITEM_MAX))
    .filter(Boolean)
    .slice(0, LIST_MAX);
  if (items.length === 0) {
    throw new PersonaContractError(`contract.${field} must not be empty`);
  }
  return items;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersonaInformation(value: unknown): value is PersonaInformation {
  return value === "informed" || value === "first-run";
}

export function isBrowserInformationMode(value: unknown): value is BrowserInformationMode {
  return value === "mixed" || value === "first-run" || value === "informed";
}

/** Missing or unknown contract.information → informed. Only "first-run" is poor. */
export function personaInformation(contract: PersonaContract | undefined): PersonaInformation {
  return contract?.information === "first-run" ? "first-run" : "informed";
}

/** Missing or unknown start-run mode → mixed. */
export function parseBrowserInformationMode(raw: unknown): BrowserInformationMode {
  return isBrowserInformationMode(raw) ? raw : "mixed";
}

export function effectiveInformation(
  contract: PersonaContract | undefined,
  opts: { mode: BrowserInformationMode; lane: AgentLane },
): PersonaInformation {
  switch (opts.lane) {
    case "explorer":
    case "threshold":
    case "regression":
      return "informed";
    case "browser": {
      switch (opts.mode) {
        case "first-run":
          return "first-run";
        case "informed":
          return "informed";
        case "mixed":
          return personaInformation(contract);
        default: {
          const _exhaustive: never = opts.mode;
          return _exhaustive;
        }
      }
    }
    default: {
      const _exhaustive: never = opts.lane;
      return _exhaustive;
    }
  }
}

/** Parse a full contract. Throws PersonaContractError on any missing/invalid field. */
export function parsePersonaContract(raw: unknown): PersonaContract {
  if (!isRecord(raw)) {
    throw new PersonaContractError("contract must be an object");
  }
  const rulesRaw = raw.behavioralRules;
  if (!isRecord(rulesRaw)) {
    throw new PersonaContractError("contract.behavioralRules is required");
  }
  const knowledgeRaw = raw.knowledgeBoundary;
  if (!isRecord(knowledgeRaw)) {
    throw new PersonaContractError("contract.knowledgeBoundary is required");
  }
  const stateRaw = raw.stateRules;
  if (!isRecord(stateRaw)) {
    throw new PersonaContractError("contract.stateRules is required");
  }

  return {
    traits: requireString(raw.traits, "traits", TRAITS_MAX),
    behavioralRules: {
      discovery: requireString(rulesRaw.discovery, "behavioralRules.discovery", RULE_MAX),
      comprehension: requireString(rulesRaw.comprehension, "behavioralRules.comprehension", RULE_MAX),
      helpSeeking: requireString(rulesRaw.helpSeeking, "behavioralRules.helpSeeking", RULE_MAX),
      exploration: requireString(rulesRaw.exploration, "behavioralRules.exploration", RULE_MAX),
    },
    knowledgeBoundary: {
      doesNotKnow: requireStringList(knowledgeRaw.doesNotKnow, "knowledgeBoundary.doesNotKnow"),
      mayInferFrom: requireStringList(knowledgeRaw.mayInferFrom, "knowledgeBoundary.mayInferFrom"),
    },
    stateRules: {
      confusionIncreasesWhen: requireStringList(stateRaw.confusionIncreasesWhen, "stateRules.confusionIncreasesWhen"),
      confusionDecreasesWhen: requireStringList(stateRaw.confusionDecreasesWhen, "stateRules.confusionDecreasesWhen"),
    },
    abandonment: requireStringList(raw.abandonment, "abandonment"),
    ...(isPersonaInformation(raw.information) ? { information: raw.information } : {}),
  };
}

/**
 * Best-effort parse for YAML packs and optional tool args.
 * Missing/invalid contracts are omitted rather than failing the whole persona.
 */
export function tryParsePersonaContract(raw: unknown, source?: string): PersonaContract | undefined {
  if (raw === undefined || raw === null) return undefined;
  try {
    return parsePersonaContract(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log.warn(`[persona-contract] ${source ?? "input"}: skipped invalid contract (${message})`);
    return undefined;
  }
}

/** One-line roster hint so HR can see the skipper/reader fork. */
export function formatContractSummary(contract: PersonaContract): string {
  return `${contract.traits} — ${contract.behavioralRules.comprehension}`;
}

function knowledgeClause(information: PersonaInformation): string {
  switch (information) {
    case "first-run":
      return "You have no product brief. The screen is the product. Facts in \"does not know\" stay unknown until you see them on the screen — and only if Comprehension lets you read them.";
    case "informed":
      return "Treat [Implemented Features] / [App Overview] as swarm background, not as your personal knowledge. Facts in \"does not know\" stay unknown until you see them on the screen — and only if Comprehension lets you read them.";
    default: {
      const _exhaustive: never = information;
      return _exhaustive;
    }
  }
}

function contractPreamble(information: PersonaInformation): string {
  switch (information) {
    case "first-run":
      return `This contract is how you actually use the app. It outranks being a thorough tester.
If a tutorial, dialog, or long explanation appears: follow Comprehension, not diligence. A skipper skips. A reader reads.
When this contract conflicts with "explore thoroughly", the contract wins.`;
    case "informed":
      return `This contract is how you actually use the app. It outranks being a thorough tester, and it outranks the feature list below.
If a tutorial, dialog, or long explanation appears: follow Comprehension, not diligence. A skipper skips. A reader reads.
When this contract conflicts with "explore thoroughly" or with [Implemented Features], the contract wins.`;
    default: {
      const _exhaustive: never = information;
      return _exhaustive;
    }
  }
}

/** System-prompt block. Empty string when the agent has no contract (legacy roster). */
export function formatPersonaContract(
  contract: PersonaContract | undefined,
  information: PersonaInformation = personaInformation(contract),
): string {
  if (!contract) return "";

  const doesNotKnow = contract.knowledgeBoundary.doesNotKnow.map((s) => `- ${s}`).join("\n");
  const mayInfer = contract.knowledgeBoundary.mayInferFrom.map((s) => `- ${s}`).join("\n");
  const up = contract.stateRules.confusionIncreasesWhen.map((s) => `- ${s}`).join("\n");
  const down = contract.stateRules.confusionDecreasesWhen.map((s) => `- ${s}`).join("\n");
  const leave = contract.abandonment.map((s) => `- ${s}`).join("\n");

  return `
[Your Behavioral Contract]
${contractPreamble(information)}

Traits: ${contract.traits}

How you look at a screen:
- Discovery: ${contract.behavioralRules.discovery}
- Comprehension: ${contract.behavioralRules.comprehension}
- Help-seeking: ${contract.behavioralRules.helpSeeking}
- Exploration: ${contract.behavioralRules.exploration}

What you do not know:
${doesNotKnow}
You may infer only from:
${mayInfer}
${knowledgeClause(information)}

Confusion increases when:
${up}
Confusion decreases when:
${down}

You leave when ANY of:
${leave}
When you leave, call post_outcome with achieved=false if you have that tool, and post_feedback (usually category "ux") in first person: what you thought at the moment you stopped, not a QA diagnosis.`;
}

/** JSON schema fragment for the HR `add_agent` tool. */
export const PERSONA_CONTRACT_TOOL_SCHEMA = {
  type: "object" as const,
  description:
    "How this person behaves on a screen. Required. Two recruits must fork on the same tutorial (skip vs read). Not a biography.",
  properties: {
    traits: {
      type: "string",
      description: "Short behavioral signature, not age/job",
    },
    behavioralRules: {
      type: "object",
      properties: {
        discovery: { type: "string" },
        comprehension: { type: "string", description: "The tutorial fork: mash Next unread vs read every step" },
        helpSeeking: { type: "string" },
        exploration: { type: "string" },
      },
      required: ["discovery", "comprehension", "helpSeeking", "exploration"],
    },
    knowledgeBoundary: {
      type: "object",
      properties: {
        doesNotKnow: { type: "array", items: { type: "string" } },
        mayInferFrom: { type: "array", items: { type: "string" } },
      },
      required: ["doesNotKnow", "mayInferFrom"],
    },
    stateRules: {
      type: "object",
      properties: {
        confusionIncreasesWhen: { type: "array", items: { type: "string" } },
        confusionDecreasesWhen: { type: "array", items: { type: "string" } },
      },
      required: ["confusionIncreasesWhen", "confusionDecreasesWhen"],
    },
    abandonment: {
      type: "array",
      items: { type: "string" },
      description: "Stop conditions; any one is enough to leave",
    },
    information: {
      type: "string",
      enum: ["informed", "first-run"],
      description:
        "informed (default): product brief + diagnostic tools. first-run: screen only. Use first-run for a new-user if the roster has none; never for a11y/security specialists.",
    },
  },
  required: ["traits", "behavioralRules", "knowledgeBoundary", "stateRules", "abandonment"],
};
