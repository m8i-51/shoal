import type { Agent } from "./agent-store";
import { agentOrigin, isActiveAgent, isFixedAgent } from "./agent-store";

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
 * Split a single run roster into explorer / browser / regression lanes.
 * No agent is assigned to more than one lane.
 * Prefer putting fixed agents into browser slots first (primary UX surface),
 * then explorers; last remaining agent (if any explorer lane exists) is regression.
 */
export function splitRosterForDispatch<T extends Agent>(
  roster: T[],
  caps: DispatchCaps,
): RosterDispatch<T> {
  const maxBrowsers = Math.max(0, Math.floor(caps.maxBrowsers));
  const maxExplorers = Math.max(0, Math.floor(caps.maxExplorers));
  const remaining = [...roster];

  const take = (count: number, preferFixed: boolean): T[] => {
    const selected: T[] = [];
    if (count <= 0) return selected;

    if (preferFixed) {
      for (let i = 0; i < remaining.length && selected.length < count; ) {
        if (agentOrigin(remaining[i]) === "fixed") {
          selected.push(remaining.splice(i, 1)[0]);
        } else {
          i++;
        }
      }
    }

    while (selected.length < count && remaining.length > 0) {
      selected.push(remaining.shift()!);
    }
    return selected;
  };

  const browsers = take(maxBrowsers, true);

  // Explorers + optional regression share the explorer budget.
  // Mirror legacy behavior: last of the explorer pool is the regression agent when explorers > 0.
  let explorers: T[] = [];
  let regression: T | null = null;

  if (maxExplorers > 0) {
    const explorerPool = take(maxExplorers, true);
    if (explorerPool.length === 0) {
      explorers = [];
      regression = null;
    } else if (explorerPool.length === 1) {
      // Single explorer slot → use as regression (legacy: allAgents[length-1])
      regression = explorerPool[0];
      explorers = [];
    } else {
      regression = explorerPool[explorerPool.length - 1];
      explorers = explorerPool.slice(0, -1);
    }
  }

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
