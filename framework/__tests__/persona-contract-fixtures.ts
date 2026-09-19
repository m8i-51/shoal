import type { PersonaContract } from "../persona-contract";

/** Shared skipper contract for unit tests — the tutorial-mash fork. */
export function sampleContract(overrides: Partial<PersonaContract> = {}): PersonaContract {
  return {
    traits: "speeds through copy, skims numbers, wants a score to show someone",
    behavioralRules: {
      discovery: "Thumb-scroll 1–2 screens. Open at most one disclosure.",
      comprehension: "Read the big type and the numbers. Mash Next on tutorials; do not read the body.",
      helpSeeking: "Does not search in-app. Asks a colleague 'what is this?' and otherwise gives up.",
      exploration: "At most two unsolicited screen changes.",
    },
    knowledgeBoundary: {
      doesNotKnow: ["what the score means", "that credits are finite"],
      mayInferFrom: ["visible labels", "button appearance"],
    },
    stateRules: {
      confusionIncreasesWhen: ["unexplained numbers appear together"],
      confusionDecreasesWhen: ["one sentence states what this screen is for"],
    },
    abandonment: [
      "90 seconds without knowing what the product is",
      "asked to log in before trying it",
    ],
    ...overrides,
  };
}
