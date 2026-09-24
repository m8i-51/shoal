# Persona contracts (behavioral rules, not bios)

## Problem

Personas were 2–4 sentence biographies plus an evaluation lens. Two "first-time users" both behaved like competent testers: they read the tutorial, used the feature list from product discovery, and reported in a slightly different voice. The interesting user-test finding — the same 4-step onboarding, one person mashes Next unread, the other reads every step — could not happen, because nothing in the persona *constrained action*.

## Decision

Give every new persona a **contract**:

| Field | What it binds |
|-------|----------------|
| `traits` | Short behavioral signature (not age/job) |
| `behavioralRules` | Discovery / Comprehension / Help-seeking / Exploration |
| `knowledgeBoundary` | What they do not know; what they may infer from the screen |
| `stateRules` | When confusion rises and falls |
| `abandonment` | Observable stop conditions; any one is enough to leave |

The contract is how they use *any* screen. It is not a test plan for this app.

Generation (dashboard seed, HR `add_agent`, `personas.yaml`) must produce a fork: if the roster already has a skipper, recruit a reader. Seed generation **requires** the contract; YAML may omit it (legacy packs). Agents stored before this change keep working with no contract.

At runtime, browser and API agents get `[Your Behavioral Contract]`. It outranks being a thorough tester and outranks `[Implemented Features]`. Facts in `doesNotKnow` stay unknown until they appear on screen — and only if Comprehension lets them read that copy.

## Out of scope

- A/B preference scoring / pairwise rating of isolated screenshots
- Treating abandonment reports as ground truth rather than hypotheses
- Scaling to hundreds of personas

Knowledge and observation subtraction for selected browser agents is in [2026-09-19-first-run-persona.md](2026-09-19-first-run-persona.md).

Triage and Product Edge stay as they are: a skipper who "needs an onboarding wizard" is still a finding, and `edge-risk` still marks the ones that would sand the product down.
