import { describe, it, expect } from "vitest";
import { applyBoundaryPushingSeed, parseGeneratedPersona, PersonaGenerationError } from "../persona-from-seed";
import { sampleContract } from "./persona-contract-fixtures";
import { BOUNDARY_PUSHING_CONTRACT, BOUNDARY_PUSHING_SEED } from "../persona-contract";

describe("parseGeneratedPersona", () => {
  it("accepts a complete persona object", () => {
    const contract = sampleContract();
    expect(
      parseGeneratedPersona({
        name: "Ken",
        role: "grumpy regular",
        persona: "A skeptical uncle who distrusts new UI.",
        lenses: ["clarity", "trust"],
        contract,
      }),
    ).toEqual({
      name: "Ken",
      role: "grumpy regular",
      persona: "A skeptical uncle who distrusts new UI.",
      lenses: ["clarity", "trust"],
      contract,
    });
  });

  it("keeps optional accountRole", () => {
    expect(
      parseGeneratedPersona({
        name: "Miki",
        role: "趣味で学ぶシニア学習者",
        persona: "Learns slowly.",
        lenses: ["clarity"],
        accountRole: "user",
        contract: sampleContract(),
      }).accountRole,
    ).toBe("user");
  });

  it("rejects missing name/role/persona", () => {
    expect(() =>
      parseGeneratedPersona({ name: "", role: "r", persona: "p", lenses: ["x"], contract: sampleContract() }),
    ).toThrow(PersonaGenerationError);
    expect(() =>
      parseGeneratedPersona({ name: "A", role: "r", persona: "p", lenses: [], contract: sampleContract() }),
    ).toThrow(/lens/i);
  });

  it("rejects a persona without a behavioral contract", () => {
    expect(() =>
      parseGeneratedPersona({
        name: "Ken",
        role: "grumpy regular",
        persona: "A skeptical uncle.",
        lenses: ["clarity"],
      }),
    ).toThrow(/contract/i);
  });

  it("rejects non-objects", () => {
    expect(() => parseGeneratedPersona(null)).toThrow(PersonaGenerationError);
    expect(() => parseGeneratedPersona([])).toThrow(PersonaGenerationError);
  });
});

describe("applyBoundaryPushingSeed", () => {
  const generated = {
    name: "Ren",
    role: "limit tester for the checkout form",
    persona: "Fills the coupon box with the store's max.",
    lenses: ["checkout edge"],
    contract: sampleContract({
      behavioralRules: {
        ...sampleContract().behavioralRules,
        exploration: "Type 40 characters into the coupon field, then submit a second time.",
      },
    }),
  };

  it("replaces an app-specific contract when the seed is the boundary-pushing person", () => {
    const applied = applyBoundaryPushingSeed(BOUNDARY_PUSHING_SEED, generated);
    expect(applied.contract).toEqual(BOUNDARY_PUSHING_CONTRACT);
    expect(applied.contract.behavioralRules.exploration).not.toContain("coupon");
    expect(applied.name).toBe("Ren");
  });

  it("keeps a normal seed's contract", () => {
    expect(applyBoundaryPushingSeed("first-time user", generated).contract).toEqual(generated.contract);
  });

  it("treats a Japanese boundary seed the same way", () => {
    expect(applyBoundaryPushingSeed("境界を押し込む人", generated).contract).toEqual(BOUNDARY_PUSHING_CONTRACT);
  });
});
