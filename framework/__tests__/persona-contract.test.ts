import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../log", () => ({
  warn: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

import * as log from "../log";
import {
  parsePersonaContract,
  tryParsePersonaContract,
  formatPersonaContract,
  formatContractSummary,
  personaInformation,
  parseBrowserInformationMode,
  effectiveInformation,
  PersonaContractError,
} from "../persona-contract";
import { sampleContract } from "./persona-contract-fixtures";

describe("parsePersonaContract", () => {
  it("accepts a complete contract", () => {
    expect(parsePersonaContract(sampleContract())).toEqual(sampleContract());
  });

  it("trims strings and drops empty list items", () => {
    const parsed = parsePersonaContract({
      ...sampleContract(),
      traits: "  skipper  ",
      knowledgeBoundary: { doesNotKnow: ["  a  ", "", "b"], mayInferFrom: ["x"] },
    });
    expect(parsed.traits).toBe("skipper");
    expect(parsed.knowledgeBoundary.doesNotKnow).toEqual(["a", "b"]);
  });

  it("clips overlong strings and lists", () => {
    const parsed = parsePersonaContract({
      ...sampleContract(),
      traits: "t".repeat(200),
      knowledgeBoundary: { doesNotKnow: ["n".repeat(250)], mayInferFrom: ["labels"] },
      abandonment: Array.from({ length: 10 }, (_, i) => `leave ${i}`),
    });
    expect(parsed.traits).toHaveLength(160);
    expect(parsed.knowledgeBoundary.doesNotKnow[0]).toHaveLength(200);
    expect(parsed.abandonment).toHaveLength(6);
  });

  it("rejects missing nested objects and non-string lists", () => {
    expect(() => parsePersonaContract({ ...sampleContract(), knowledgeBoundary: undefined })).toThrow(
      /knowledgeBoundary/,
    );
    expect(() => parsePersonaContract({ ...sampleContract(), stateRules: "x" })).toThrow(/stateRules/);
    expect(() => parsePersonaContract({ ...sampleContract(), abandonment: "leave" })).toThrow(/array of strings/);
    expect(() => parsePersonaContract({ ...sampleContract(), traits: "   " })).toThrow(/traits/);
  });

  it("rejects missing behavioralRules and empty lists", () => {
    expect(() => parsePersonaContract({ ...sampleContract(), behavioralRules: undefined })).toThrow(
      PersonaContractError,
    );
    expect(() => parsePersonaContract({ ...sampleContract(), abandonment: [] })).toThrow(/abandonment/i);
    expect(() => parsePersonaContract(null)).toThrow(/object/i);
  });

  it("keeps information when it is informed or first-run, and drops unknown values", () => {
    expect(parsePersonaContract({ ...sampleContract(), information: "first-run" }).information).toBe("first-run");
    expect(parsePersonaContract({ ...sampleContract(), information: "informed" }).information).toBe("informed");
    expect(parsePersonaContract({ ...sampleContract(), information: "naive" }).information).toBeUndefined();
    expect(parsePersonaContract(sampleContract()).information).toBeUndefined();
  });
});

describe("tryParsePersonaContract", () => {
  beforeEach(() => {
    vi.mocked(log.warn).mockReset();
  });

  it("returns undefined for missing or invalid input and warns on invalid", () => {
    expect(tryParsePersonaContract(undefined)).toBeUndefined();
    expect(tryParsePersonaContract(null)).toBeUndefined();
    expect(tryParsePersonaContract({ traits: "x" }, "pack.yaml")).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it("returns a parsed contract when valid", () => {
    expect(tryParsePersonaContract(sampleContract())?.traits).toContain("speeds through");
  });
});

describe("formatPersonaContract", () => {
  it("returns empty when the agent has no contract", () => {
    expect(formatPersonaContract(undefined)).toBe("");
  });

  it("tells the agent the contract outranks thorough testing and the feature list", () => {
    const text = formatPersonaContract(sampleContract());
    expect(text).toContain("[Your Behavioral Contract]");
    expect(text).toContain("A skipper skips. A reader reads.");
    expect(text).toContain("Mash Next on tutorials");
    expect(text).toContain("what the score means");
    expect(text).toContain("the contract wins");
    expect(text).toContain("post_feedback");
  });

  it("does not mention the feature list when the effective information is first-run", () => {
    const text = formatPersonaContract(sampleContract({ information: "first-run" }), "first-run");
    expect(text).toContain("The screen is the product");
    expect(text).not.toContain("[Implemented Features]");
    expect(text).not.toContain("feature list below");
  });
});

describe("personaInformation / effectiveInformation", () => {
  it("treats missing and unknown information as informed", () => {
    expect(personaInformation(undefined)).toBe("informed");
    expect(personaInformation(sampleContract())).toBe("informed");
    expect(personaInformation(sampleContract({ information: "first-run" }))).toBe("first-run");
  });

  it("parses start-run browserInformation, defaulting unknown values to mixed", () => {
    expect(parseBrowserInformationMode("mixed")).toBe("mixed");
    expect(parseBrowserInformationMode("first-run")).toBe("first-run");
    expect(parseBrowserInformationMode("informed")).toBe("informed");
    expect(parseBrowserInformationMode(undefined)).toBe("mixed");
    expect(parseBrowserInformationMode("naive")).toBe("mixed");
  });

  it("keeps explorer/threshold/regression informed even when the run is first-run", () => {
    const firstRun = sampleContract({ information: "first-run" });
    expect(effectiveInformation(firstRun, { mode: "first-run", lane: "explorer" })).toBe("informed");
    expect(effectiveInformation(firstRun, { mode: "first-run", lane: "threshold" })).toBe("informed");
    expect(effectiveInformation(firstRun, { mode: "first-run", lane: "regression" })).toBe("informed");
  });

  it("applies run mode on the browser lane", () => {
    const firstRun = sampleContract({ information: "first-run" });
    const informed = sampleContract();
    expect(effectiveInformation(informed, { mode: "first-run", lane: "browser" })).toBe("first-run");
    expect(effectiveInformation(firstRun, { mode: "informed", lane: "browser" })).toBe("informed");
    expect(effectiveInformation(firstRun, { mode: "mixed", lane: "browser" })).toBe("first-run");
    expect(effectiveInformation(informed, { mode: "mixed", lane: "browser" })).toBe("informed");
  });
});

describe("formatContractSummary", () => {
  it("joins traits with the comprehension rule", () => {
    const summary = formatContractSummary(sampleContract());
    expect(summary).toContain("speeds through copy");
    expect(summary).toContain("Mash Next on tutorials");
  });
});
