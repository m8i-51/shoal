import { describe, it, expect } from "vitest";
import {
  computeRosterSlots,
  buildRunRoster,
  splitRosterForDispatch,
  partitionActiveAgents,
  ensureBoundaryPushingPersona,
  reserveBoundaryBrowserSeat,
  makeBoundaryPushingAgent,
} from "../roster";
import type { Agent } from "../agent-store";
import { sampleContract } from "./persona-contract-fixtures";
import { BOUNDARY_PUSHING_CONTRACT, BOUNDARY_PUSHING_SEED, isBoundaryPushingAgent } from "../persona-contract";

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

  it("puts one first-run and one informed browser when slots >= 2", () => {
    const roster = [
      agent({ id: "a-fr", name: "FR", origin: "auto", contract: sampleContract({ information: "first-run" }) }),
      agent({ id: "a-inf", name: "Inf", origin: "auto" }),
      agent({ id: "a-inf2", name: "Inf2", origin: "auto" }),
    ];
    const { browsers, explorers } = splitRosterForDispatch(roster, {
      maxBrowsers: 2,
      maxExplorers: 1,
    });
    expect(browsers.map((a) => a.id).sort()).toEqual(["a-fr", "a-inf"]);
    expect(explorers.map((a) => a.id)).toEqual(["a-inf2"]);
  });

  it("still prefers a fixed agent when there is only one browser slot", () => {
    const { browsers, explorers } = splitRosterForDispatch(
      [
        agent({ id: "a-fr", name: "FR", origin: "auto", contract: sampleContract({ information: "first-run" }) }),
        agent({ id: "f1", name: "F1", origin: "fixed" }),
        agent({ id: "a2", name: "A2", origin: "auto" }),
      ],
      { maxBrowsers: 1, maxExplorers: 2 },
    );
    expect(browsers[0].id).toBe("f1");
    expect(explorers.map((a) => a.id).sort()).toEqual(["a-fr", "a2"]);
  });
});

describe("boundary-pushing persona on the roster", () => {
  it("adds one when the roster has none, and does not add a second", () => {
    const roster = ensureBoundaryPushingPersona([
      agent({ id: "f1", name: "F1", origin: "fixed" }),
    ]);
    expect(roster.map((a) => a.id)).toEqual(["f1", makeBoundaryPushingAgent().id]);
    expect(isBoundaryPushingAgent(roster[1])).toBe(true);
    expect(ensureBoundaryPushingPersona(roster)).toHaveLength(2);
  });

  it("keeps an existing person who already has the seed or the exploration rule", () => {
    const seeded = agent({
      id: "fixed-ren",
      name: "Ren",
      origin: "fixed",
      seed: BOUNDARY_PUSHING_SEED,
    });
    expect(ensureBoundaryPushingPersona([seeded]).map((a) => a.id)).toEqual(["fixed-ren"]);

    const byContract = agent({
      id: "auto-ren",
      name: "Aya",
      origin: "auto",
      contract: BOUNDARY_PUSHING_CONTRACT,
    });
    expect(ensureBoundaryPushingPersona([byContract])[0].id).toBe("auto-ren");
  });

  it("prefers a browser seat and the candidate areas stay with that person", () => {
    const roster = ensureBoundaryPushingPersona([
      agent({ id: "f1", name: "F1", origin: "fixed" }),
      agent({ id: "a1", name: "A1", origin: "auto" }),
    ]);
    const caps = reserveBoundaryBrowserSeat(roster, { maxBrowsers: 1, maxExplorers: 1 });
    expect(caps.maxBrowsers).toBe(2);
    const { browsers, explorers } = splitRosterForDispatch(roster, caps);
    expect(browsers.map((a) => a.id)).toEqual(["f1", makeBoundaryPushingAgent().id]);
    expect(explorers.map((a) => a.id)).toEqual(["a1"]);
    expect(browsers.some((a) => isBoundaryPushingAgent(a))).toBe(true);
  });

  it("does not open a browser seat when browsers are off", () => {
    const roster = ensureBoundaryPushingPersona([agent({ id: "a1", name: "A1", origin: "auto" })]);
    expect(reserveBoundaryBrowserSeat(roster, { maxBrowsers: 0, maxExplorers: 2 }).maxBrowsers).toBe(0);
  });

  it("keeps a selected fixed persona when a first-run auto and the boundary persona share two browser seats", () => {
    const fixed = agent({ id: "f1", name: "Fixed", origin: "fixed" });
    const firstRun = agent({
      id: "a-fr",
      name: "FR",
      origin: "auto",
      contract: sampleContract({ information: "first-run" }),
    });
    const slots = computeRosterSlots({ maxBrowsers: 2, maxExplorers: 0, fixedCount: 1 });
    const built = buildRunRoster({ fixed: [fixed], autos: [firstRun], autoSlots: slots.autoSlots });
    expect(built.map((a) => a.id)).toEqual(["f1", "a-fr"]);

    const roster = ensureBoundaryPushingPersona(built);
    expect(roster.map((a) => a.id)).toContain("f1");
    const caps = reserveBoundaryBrowserSeat(roster, {
      maxBrowsers: slots.maxBrowsers,
      maxExplorers: slots.maxExplorers,
    });
    expect(caps.maxBrowsers).toBeGreaterThan(2);

    const { browsers, explorers } = splitRosterForDispatch(roster, caps);
    expect(browsers.map((a) => a.id)).toContain("f1");
    expect(explorers.map((a) => a.id)).not.toContain("f1");
    const dispatched = [...browsers, ...explorers].map((a) => a.id);
    expect(dispatched).toContain("f1");
    expect(dispatched).toContain("a-fr");
    expect(dispatched).toContain(makeBoundaryPushingAgent().id);
  });

  it("does not hand the boundary persona a seat that would drop a fixed persona", () => {
    const roster = [
      agent({ id: "f1", name: "Fixed", origin: "fixed" }),
      agent({
        id: "a-fr",
        name: "FR",
        origin: "auto",
        contract: sampleContract({ information: "first-run" }),
      }),
      makeBoundaryPushingAgent(),
    ];
    const { browsers, explorers } = splitRosterForDispatch(roster, { maxBrowsers: 2, maxExplorers: 0 });
    expect(browsers.map((a) => a.id)).toContain("f1");
    expect([...browsers, ...explorers].map((a) => a.id)).toContain("f1");
  });

  it("seats the boundary persona before a non-fixed informed auto when nobody is fixed", () => {
    const firstRun = agent({
      id: "a-fr",
      name: "FR",
      origin: "auto",
      contract: sampleContract({ information: "first-run" }),
    });
    const informed = agent({ id: "a-inf", name: "Inf", origin: "auto" });
    const roster = ensureBoundaryPushingPersona([firstRun, informed]);
    const requested = { maxBrowsers: 2, maxExplorers: 0 };
    const caps = reserveBoundaryBrowserSeat(roster, requested);
    expect(caps).toEqual(requested);

    const { browsers, explorers } = splitRosterForDispatch(roster, caps);
    const browserIds = browsers.map((a) => a.id);
    const explorerIds = explorers.map((a) => a.id);
    expect(browserIds).toContain("a-fr");
    expect(browserIds).toContain(makeBoundaryPushingAgent().id);
    expect(browserIds).not.toContain("a-inf");
    expect(explorerIds).not.toContain("a-inf");
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
