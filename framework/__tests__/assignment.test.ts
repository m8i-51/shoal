import { describe, it, expect } from "vitest";
import {
  pickAssignment,
  scenarioFitsLane,
  dispatchableSoloScenarios,
  reconcileMultiActorOutcomes,
} from "../assignment";
import type { Scenario } from "../scenario-designer";
import { UNIVERSAL_LENSES } from "../org-designer";

function scenario(partial: Partial<Scenario> & Pick<Scenario, "id" | "title">): Scenario {
  return {
    context: "",
    goal: "",
    constraints: "",
    ...partial,
  };
}

describe("scenarioFitsLane", () => {
  it("keeps browser-channel scenarios off the API explorer lane", () => {
    const s = scenario({ id: "s1", title: "Toggle dark theme", channel: "browser" });
    expect(scenarioFitsLane(s, "explorer")).toBe(false);
    expect(scenarioFitsLane(s, "browser")).toBe(true);
  });

  it("keeps api-channel scenarios off the browser lane", () => {
    const s = scenario({ id: "s1", title: "Create item via API", channel: "api" });
    expect(scenarioFitsLane(s, "explorer")).toBe(true);
    expect(scenarioFitsLane(s, "browser")).toBe(false);
  });

  it("infers browser from UI-only wording when channel is omitted", () => {
    const s = scenario({
      id: "s1",
      title: "Open the hamburger and notification panel",
      goal: "Toggle dark mode",
    });
    expect(scenarioFitsLane(s, "explorer")).toBe(false);
    expect(scenarioFitsLane(s, "browser")).toBe(true);
  });
});

describe("dispatchableSoloScenarios", () => {
  it("drops multi-actor scenarios and concurrent wording without actors", () => {
    const scenarios: Scenario[] = [
      scenario({ id: "s1", title: "Submit a form" }),
      scenario({
        id: "s2",
        title: "Admin revokes while user edits",
        actors: [
          { role: "admin", goal: "revoke" },
          { role: "user", goal: "edit" },
        ],
      }),
      scenario({ id: "s3", title: "Two users edit the same record at the same time" }),
    ];
    expect(dispatchableSoloScenarios(scenarios).map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("pickAssignment", () => {
  it("does not give a browser-only scenario to an explorer", () => {
    const scenarios = [
      scenario({ id: "ui", title: "OAuth login", channel: "browser" }),
      scenario({ id: "api", title: "List items", channel: "api" }),
    ];
    const assignment = pickAssignment(0, scenarios, "explorer");
    expect(assignment.scenario?.id).toBe("api");
  });

  it("prefers browser-channel work for the browser lane", () => {
    const scenarios = [
      scenario({ id: "api", title: "List items", channel: "api" }),
      scenario({ id: "ui", title: "Theme toggle", channel: "browser" }),
    ];
    const assignment = pickAssignment(0, scenarios, "browser");
    expect(assignment.scenario?.id).toBe("ui");
  });

  it("falls back to a lens when no scenario fits the lane (idx % 10 >= 7 or empty)", () => {
    const scenarios = [scenario({ id: "ui", title: "Hamburger", channel: "browser" })];
    const assignment = pickAssignment(7, scenarios, "explorer");
    expect(assignment.scenario).toBeUndefined();
    expect(assignment.lens).toBe(UNIVERSAL_LENSES[7 % UNIVERSAL_LENSES.length]);
  });
});

describe("reconcileMultiActorOutcomes", () => {
  const scenarioWithActors = scenario({
    id: "race",
    title: "Race",
    actors: [
      { role: "admin", goal: "revoke" },
      { role: "user", goal: "edit" },
    ],
  });

  it("rejects a one-sided achieved=true", () => {
    const outcomes = reconcileMultiActorOutcomes(
      [{ scenarioId: "race", achieved: true, reason: "I finished my half" }],
      [scenarioWithActors],
    );
    expect(outcomes[0].achieved).toBe(false);
    expect(outcomes[0].reason).toMatch(/multi-actor incomplete/);
  });

  it("keeps achieved only when both actors succeed", () => {
    const outcomes = reconcileMultiActorOutcomes(
      [
        { scenarioId: "race", achieved: true, reason: "admin done" },
        { scenarioId: "race", achieved: true, reason: "user done" },
      ],
      [scenarioWithActors],
    );
    expect(outcomes.every((o) => o.achieved)).toBe(true);
  });

  it("does not rewrite solo outcomes", () => {
    const outcomes = reconcileMultiActorOutcomes(
      [{ scenarioId: "solo", achieved: true, reason: "ok" }],
      [scenario({ id: "solo", title: "Solo" })],
    );
    expect(outcomes[0]).toEqual({ scenarioId: "solo", achieved: true, reason: "ok" });
  });
});
