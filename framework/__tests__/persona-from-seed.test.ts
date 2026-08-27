import { describe, it, expect } from "vitest";
import { parseGeneratedPersona, PersonaGenerationError } from "../persona-from-seed";

describe("parseGeneratedPersona", () => {
  it("accepts a complete persona object", () => {
    expect(
      parseGeneratedPersona({
        name: "Ken",
        role: "grumpy regular",
        persona: "A skeptical uncle who distrusts new UI.",
        lenses: ["clarity", "trust"],
      }),
    ).toEqual({
      name: "Ken",
      role: "grumpy regular",
      persona: "A skeptical uncle who distrusts new UI.",
      lenses: ["clarity", "trust"],
    });
  });

  it("rejects missing name/role/persona", () => {
    expect(() =>
      parseGeneratedPersona({ name: "", role: "r", persona: "p", lenses: ["x"] }),
    ).toThrow(PersonaGenerationError);
    expect(() =>
      parseGeneratedPersona({ name: "A", role: "r", persona: "p", lenses: [] }),
    ).toThrow(/lens/i);
  });

  it("rejects non-objects", () => {
    expect(() => parseGeneratedPersona(null)).toThrow(PersonaGenerationError);
    expect(() => parseGeneratedPersona([])).toThrow(PersonaGenerationError);
  });
});
