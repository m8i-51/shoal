import { UNIVERSAL_LENSES } from "./org-designer";
import {
  inferScenarioChannel,
  soloScenarios,
  type Scenario,
  type ScenarioActor,
} from "./scenario-designer";

export type Lane = "explorer" | "browser";

export type Assignment = {
  scenario?: Scenario;
  lens?: string;
  actor?: ScenarioActor & { partnerRole: string };
};

export function scenarioFitsLane(scenario: Scenario, lane: Lane): boolean {
  const channel = inferScenarioChannel(scenario);
  switch (lane) {
    case "explorer":
      return channel !== "browser";
    case "browser":
      return channel !== "api";
    default: {
      const _exhaustive: never = lane;
      return _exhaustive;
    }
  }
}

/** Solo scenarios that a single agent may complete — concurrent work without actors[] is excluded. */
export function dispatchableSoloScenarios(scenarios: Scenario[]): Scenario[] {
  return soloScenarios(scenarios);
}

/**
 * 7:3 scenario-to-lens mix, filtered so UI-required work stays on the browser lane
 * and API-only work stays on the explorer lane.
 */
export function pickAssignment(idx: number, scenarios: Scenario[], lane: Lane): Assignment {
  const eligible = scenarios.filter((s) => scenarioFitsLane(s, lane));
  if (eligible.length > 0 && idx % 10 < 7) {
    return { scenario: eligible[idx % eligible.length] };
  }
  return { lens: UNIVERSAL_LENSES[idx % UNIVERSAL_LENSES.length] };
}

export type OutcomeLike = {
  scenarioId: string;
  achieved: boolean;
  reason: string;
};

/**
 * Concurrent scenarios require every actor to finish. A single agent's achieved=true
 * is not enough — mark those outcomes incomplete.
 */
export function reconcileMultiActorOutcomes<T extends OutcomeLike>(
  outcomes: T[],
  scenarios: Scenario[],
): T[] {
  const expectedActors = new Map<string, number>();
  for (const scenario of scenarios) {
    const n = scenario.actors?.length ?? 0;
    if (n >= 2) expectedActors.set(scenario.id, n);
  }
  if (expectedActors.size === 0) return outcomes;

  const grouped = new Map<string, T[]>();
  for (const outcome of outcomes) {
    const list = grouped.get(outcome.scenarioId) ?? [];
    list.push(outcome);
    grouped.set(outcome.scenarioId, list);
  }

  return outcomes.map((outcome) => {
    const expected = expectedActors.get(outcome.scenarioId);
    if (!expected) return outcome;
    const related = grouped.get(outcome.scenarioId) ?? [];
    const complete = related.length >= expected && related.every((o) => o.achieved);
    if (complete || !outcome.achieved) return outcome;
    return {
      ...outcome,
      achieved: false,
      reason: `multi-actor incomplete (need ${expected} actors): ${outcome.reason}`,
    };
  });
}
