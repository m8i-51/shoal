import type { Agent } from "./agent-store";
import { agentOrigin, isActiveAgent, isFixedAgent } from "./agent-store";
import {
  BOUNDARY_PUSHING_CONTRACT,
  BOUNDARY_PUSHING_SEED,
  isBoundaryPushingAgent,
  personaInformation,
} from "./persona-contract";

export const BOUNDARY_PUSHING_AGENT_ID = "agent_boundary_pusher";

/** Ephemeral roster member. Not written to agents.json. */
export function makeBoundaryPushingAgent(): Agent {
  return {
    id: BOUNDARY_PUSHING_AGENT_ID,
    name: "Ren",
    role: "presses every limit they can see",
    persona:
      "Fills a field to the limit it shows, sends it empty, types a huge number, and presses the same control again. Talks about what happened to them, and stays quiet when the limit is clear.",
    createdAt: "2026-11-07T00:00:00.000Z",
    origin: "auto",
    status: "active",
    seed: BOUNDARY_PUSHING_SEED,
    accountRole: "user",
    lenses: ["boundary behavior"],
    contract: BOUNDARY_PUSHING_CONTRACT,
  };
}

/**
 * The run roster always includes one boundary-pushing person.
 * If HR or a fixed persona already is that person, they are kept as-is.
 */
export function ensureBoundaryPushingPersona<T extends Agent>(roster: T[]): T[] {
  if (roster.some((agent) => isBoundaryPushingAgent(agent))) return roster;
  return [...roster, makeBoundaryPushingAgent() as T];
}

/**
 * The boundary companion is added after auto-slot truncation, so they are
 * one extra person on top of a roster that already fits the caps.
 *
 * Open browser seats until every dashboard-selected fixed persona still has
 * one, even when a non-fixed first-run already holds a seat and the fixed
 * count does not fill the cap. No-op when browsers are off, when no fixed
 * persona needs protecting, or when this person is already fixed.
 */
export function reserveBoundaryBrowserSeat<T extends Agent>(roster: T[], caps: DispatchCaps): DispatchCaps {
  if (caps.maxBrowsers <= 0) return caps;
  const pusher = roster.find((agent) => isBoundaryPushingAgent(agent));
  if (!pusher || isFixedAgent(pusher)) return caps;

  const fixedCount = roster.filter((agent) => isFixedAgent(agent)).length;
  if (fixedCount === 0) return caps;

  const nonFixedFirstRun = roster.some(
    (agent) => !isFixedAgent(agent) && personaInformation(agent.contract) === "first-run",
  );
  const hasInformed = roster.some((agent) => personaInformation(agent.contract) !== "first-run");
  // The mix keeps one browser seat for a non-fixed first-run when both kinds
  // are present. That seat is not available to an informed fixed persona.
  const firstRunSeat = caps.maxBrowsers >= 2 && nonFixedFirstRun && hasInformed ? 1 : 0;
  const needed = fixedCount + firstRunSeat + 1;
  if (needed <= caps.maxBrowsers) return caps;
  return { ...caps, maxBrowsers: needed };
}

export interface RosterSlotInput {
  maxBrowsers: number;
  maxExplorers: number;
  fixedCount: number;
}

export interface RosterSlots {
  N: number;
  F: number;
  effectiveN: number;
  autoSlots: number;
  maxBrowsers: number;
  maxExplorers: number;
}

/** Compute requested vs effective roster size and bumped explorer/browser caps. */
export function computeRosterSlots(input: RosterSlotInput): RosterSlots {
  const maxBrowsers = Math.max(0, Math.floor(input.maxBrowsers));
  const maxExplorers = Math.max(0, Math.floor(input.maxExplorers));
  const F = Math.max(0, Math.floor(input.fixedCount));
  const N = maxBrowsers + maxExplorers;
  const effectiveN = Math.max(N, F);
  const autoSlots = Math.max(0, effectiveN - F);
  const shortfall = effectiveN - N;

  if (shortfall <= 0) {
    return { N, F, effectiveN, autoSlots, maxBrowsers, maxExplorers };
  }

  // Bump browsers by default; if only explorers were requested, bump explorers.
  if (maxBrowsers === 0 && maxExplorers > 0) {
    return {
      N,
      F,
      effectiveN,
      autoSlots,
      maxBrowsers: 0,
      maxExplorers: maxExplorers + shortfall,
    };
  }

  return {
    N,
    F,
    effectiveN,
    autoSlots,
    maxBrowsers: maxBrowsers + shortfall,
    maxExplorers,
  };
}

export interface BuildRunRosterInput<T extends Agent> {
  fixed: T[];
  autos: T[];
  autoSlots: number;
}

/** Deterministic run roster: all active fixed + up to autoSlots autos (surplus excluded). */
export function buildRunRoster<T extends Agent>(input: BuildRunRosterInput<T>): T[] {
  const fixed = input.fixed.filter((a) => isFixedAgent(a) && isActiveAgent(a));
  const autos = input.autos.filter((a) => !isFixedAgent(a) && isActiveAgent(a));
  const slots = Math.max(0, Math.floor(input.autoSlots));
  return [...fixed, ...autos.slice(0, slots)];
}

export interface DispatchCaps {
  maxBrowsers: number;
  maxExplorers: number;
}

export interface RosterDispatch<T extends Agent> {
  explorers: T[];
  browsers: T[];
  regression: T | null;
}

/**
 * Split a single run roster into explorer / browser lanes.
 * No agent is assigned to more than one lane.
 * Prefer putting fixed agents into browser slots first (primary UX surface).
 * When there are at least two browser slots and the roster has both first-run
 * and informed people, put one of each in the browser lane so mixed runs mix.
 * First-run agents prefer browser slots (they are useless as API explorers).
 * The boundary companion is seated after fixed personas, so they never take
 * the last seat from a dashboard-selected member.
 * Regression is an extra browser job, not taken from the explorer pool.
 */
export function splitRosterForDispatch<T extends Agent>(
  roster: T[],
  caps: DispatchCaps,
): RosterDispatch<T> {
  const maxBrowsers = Math.max(0, Math.floor(caps.maxBrowsers));
  const maxExplorers = Math.max(0, Math.floor(caps.maxExplorers));
  const remaining = [...roster];

  const isFirstRun = (a: T): boolean => personaInformation(a.contract) === "first-run";

  const takeMatching = (count: number, pred: (a: T) => boolean): T[] => {
    const selected: T[] = [];
    if (count <= 0) return selected;
    for (let i = 0; i < remaining.length && selected.length < count; ) {
      if (pred(remaining[i])) {
        selected.push(remaining.splice(i, 1)[0]);
      } else {
        i++;
      }
    }
    return selected;
  };

  const takeAny = (count: number): T[] => {
    const selected: T[] = [];
    while (selected.length < count && remaining.length > 0) {
      selected.push(remaining.shift()!);
    }
    return selected;
  };

  const browsers: T[] = [];
  if (maxBrowsers >= 2) {
    const hasFirstRun = remaining.some(isFirstRun);
    const hasInformed = remaining.some((a) => !isFirstRun(a));
    if (hasFirstRun && hasInformed) {
      browsers.push(...takeMatching(1, (a) => isFirstRun(a) && agentOrigin(a) === "fixed"));
      if (!browsers.some(isFirstRun)) browsers.push(...takeMatching(1, isFirstRun));
      // Informed seat: a fixed persona, then the boundary companion, then
      // any other informed auto. A fixed persona is never displaced.
      browsers.push(...takeMatching(1, (a) => !isFirstRun(a) && agentOrigin(a) === "fixed"));
      if (!browsers.some((a) => !isFirstRun(a))) {
        browsers.push(...takeMatching(1, (a) => isBoundaryPushingAgent(a) && !isFirstRun(a)));
      }
      if (!browsers.some((a) => !isFirstRun(a))) {
        browsers.push(...takeMatching(1, (a) => !isFirstRun(a) && !isBoundaryPushingAgent(a)));
      }
      if (!browsers.some((a) => !isFirstRun(a))) browsers.push(...takeMatching(1, (a) => !isFirstRun(a)));
    }
  }

  browsers.push(...takeMatching(maxBrowsers - browsers.length, (a) => agentOrigin(a) === "fixed"));
  browsers.push(...takeMatching(maxBrowsers - browsers.length, (a) => isBoundaryPushingAgent(a)));
  browsers.push(...takeMatching(maxBrowsers - browsers.length, isFirstRun));
  browsers.push(...takeAny(maxBrowsers - browsers.length));

  const explorers: T[] = [];
  if (maxExplorers > 0) {
    explorers.push(...takeMatching(maxExplorers, (a) => agentOrigin(a) === "fixed"));
    explorers.push(...takeAny(maxExplorers - explorers.length));
  }
  const regression: T | null = null;

  return { explorers, browsers, regression };
}

/** Partition store agents into active fixed vs active auto lists. */
export function partitionActiveAgents<T extends Agent>(agents: T[]): { fixed: T[]; autos: T[] } {
  const fixed: T[] = [];
  const autos: T[] = [];
  for (const a of agents) {
    if (!isActiveAgent(a)) continue;
    if (isFixedAgent(a)) fixed.push(a);
    else autos.push(a);
  }
  return { fixed, autos };
}
