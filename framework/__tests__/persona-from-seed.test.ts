import { describe, it, expect } from "vitest";
import { parseGeneratedPersona, PersonaGenerationError } from "../persona-from-seed";
import { sampleContract } from "./persona-contract-fixtures";

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
