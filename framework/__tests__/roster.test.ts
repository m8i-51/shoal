import { describe, it, expect } from "vitest";
import {
  computeRosterSlots,
  buildRunRoster,
  splitRosterForDispatch,
  partitionActiveAgents,
} from "../roster";
import type { Agent } from "../agent-store";

function agent(partial: Partial<Agent> & Pick<Agent, "id" | "name">): Agent {
  return {
    role: "user",
    persona: "p",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("computeRosterSlots", () => {
  it("keeps caps when fixed fit within N", () => {
    expect(computeRosterSlots({ maxBrowsers: 2, maxExplorers: 1, fixedCount: 2 })).toEqual({
      N: 3,
      F: 2,
      effectiveN: 3,
      autoSlots: 1,
      maxBrowsers: 2,
      maxExplorers: 1,
    });
  });

  it("bumps browsers when fixed exceed N", () => {
    expect(computeRosterSlots({ maxBrowsers: 1, maxExplorers: 0, fixedCount: 3 })).toEqual({
      N: 1,
      F: 3,
      effectiveN: 3,
      autoSlots: 0,
      maxBrowsers: 3,
      maxExplorers: 0,
    });
  });

  it("bumps explorers when only explorers were requested", () => {
    expect(computeRosterSlots({ maxBrowsers: 0, maxExplorers: 2, fixedCount: 4 })).toEqual({
      N: 2,
      F: 4,
      effectiveN: 4,
      autoSlots: 0,
      maxBrowsers: 0,
      maxExplorers: 4,
    });
  });
});

describe("buildRunRoster", () => {
  it("includes all fixed and truncates surplus autos", () => {
    const fixed = [
      agent({ id: "f1", name: "F1", origin: "fixed" }),
      agent({ id: "f2", name: "F2", origin: "fixed" }),
    ];
    const autos = [
      agent({ id: "a1", name: "A1", origin: "auto" }),
      agent({ id: "a2", name: "A2", origin: "auto" }),
      agent({ id: "a3", name: "A3" }), // missing origin → auto
    ];
    const roster = buildRunRoster({ fixed, autos, autoSlots: 2 });
    expect(roster.map((a) => a.id)).toEqual(["f1", "f2", "a1", "a2"]);
  });

  it("skips archived agents", () => {
    const roster = buildRunRoster({
      fixed: [
        agent({ id: "f1", name: "F1", origin: "fixed", status: "active" }),
        agent({ id: "f2", name: "F2", origin: "fixed", status: "archived" }),
      ],
      autos: [agent({ id: "a1", name: "A1", origin: "auto", status: "archived" })],
      autoSlots: 5,
    });
    expect(roster.map((a) => a.id)).toEqual(["f1"]);
  });
});

describe("splitRosterForDispatch", () => {
  it("does not double-assign agents across lanes", () => {
    const roster = [
      agent({ id: "f1", name: "F1", origin: "fixed" }),
      agent({ id: "f2", name: "F2", origin: "fixed" }),
      agent({ id: "a1", name: "A1", origin: "auto" }),
      agent({ id: "a2", name: "A2", origin: "auto" }),
    ];
    const { explorers, browsers, regression } = splitRosterForDispatch(roster, {
      maxBrowsers: 2,
      maxExplorers: 2,
    });
    const ids = [...browsers, ...explorers, ...(regression ? [regression] : [])].map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(4);
    expect(browsers.map((a) => a.id)).toEqual(["f1", "f2"]);
    expect(explorers.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(regression).toBeNull();
  });

  it("prefers fixed for browser slots", () => {
    const roster = [
      agent({ id: "a1", name: "A1", origin: "auto" }),
      agent({ id: "f1", name: "F1", origin: "fixed" }),
      agent({ id: "a2", name: "A2", origin: "auto" }),
    ];
    const { browsers, explorers, regression } = splitRosterForDispatch(roster, {
      maxBrowsers: 1,
      maxExplorers: 2,
    });
    expect(browsers[0].id).toBe("f1");
    expect(explorers.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(regression).toBeNull();
  });
});

describe("partitionActiveAgents", () => {
  it("splits active fixed vs auto and drops archived", () => {
    const { fixed, autos } = partitionActiveAgents([
      agent({ id: "f1", name: "F1", origin: "fixed" }),
      agent({ id: "f2", name: "F2", origin: "fixed", status: "archived" }),
      agent({ id: "a1", name: "A1", origin: "auto" }),
      agent({ id: "a2", name: "A2" }),
    ]);
    expect(fixed.map((a) => a.id)).toEqual(["f1"]);
    expect(autos.map((a) => a.id)).toEqual(["a1", "a2"]);
  });
});
