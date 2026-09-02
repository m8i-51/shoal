# Product Edge (edge-risk triage)

## Problem

Internal dogfooding surfaced the question that blocks a fully automated fix loop:
if a growing crowd of personas each reports what *their* kind of user expects, and
every ticket gets fixed, the product converges on the conventional version of its
category — "どこにも尖りがないもの". Repeating report → fix without an anchor also
lets the product drift somewhere nobody chose.

Nothing in shoal knew what the product was deliberately sharp about, so every
finding arrived with the same implicit weight: *this should be fixed*. Deciding
which ones would flatten the product was left entirely to the human reading the
tickets, with no signal to help — the reason the loop cannot move from
human-in-the-loop to human-on-the-loop.

## Decision

Give the product an explicit **edge** and make triage mark the tickets that
conflict with it. Nothing is suppressed: an edge changes how a ticket is
*labeled*, never whether it is filed.

`ProductSpec.productEdge` (`framework/product-edge.ts`):

| Field | Meaning |
|-------|---------|
| `sharpEdges` | What the product deliberately does differently, worth protecting even when it costs convenience |
| `tradeoffs` | What it deliberately does not do — accepted costs, not defects |
| `source` | `discovered` (inferred draft) or `human` (declared by the team) |

- **Discovery** drafts it from real evidence only (positioning copy, an unusual
  but consistent interaction) and may leave it empty. Confidence in a draft is
  low by construction, so the triage prompt tells the agent to flag conservatively.
- **The team owns it.** `PATCH /api/spec/edge` stamps `source: "human"`, and
  re-discovery keeps a human-declared edge instead of overwriting it with a new
  inference. The dashboard's Product Edge panel is the editor.

## Triage behavior

When (and only when) an edge is declared, `create_issue` gains an `edge_risk`
argument. Setting it:

- adds the `edge-risk` label alongside the category and `feedback-agent`,
- appends an "Edge risk — decide before fixing" section naming the edge at stake
  and why the obvious fix would blunt it,
- records the merged finding IDs in `TriageResult.edgeRisks` and
  `triage_result.json`.

Two guards keep the mark honest:

- **Defects can never be edge risks.** `edge_risk` on a `bug` is dropped in code,
  not just discouraged in the prompt — positioning does not excuse broken
  behavior, data loss, or an accessibility failure.
- **No edge, no tool.** With nothing declared, `edge_risk` is absent from the
  schema and ignored if it arrives anyway, so the agent cannot invent positioning
  to justify parking a finding.

## Why triage, not the agents

Personas keep reporting freely: the interesting findings come from a persona
saying what it actually experienced, and an agent told what the product is proud
of would report less. The edge is applied at the last gate before a ticket
exists, where the trade-off is a product decision rather than an observation.

## Out of scope

- Auto-closing or deferring edge-risk tickets (the human decides; this exists to
  make the choice visible, which is the prerequisite for automating it later).
- Feeding edge-risk outcomes back into persona recruitment via `adoption.ts`.
- Detecting drift across runs (an edge diff over time).
- Per-persona edges, or edges scoped to one screen.
