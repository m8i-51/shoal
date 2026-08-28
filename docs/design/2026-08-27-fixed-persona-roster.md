# Fixed Persona Roster (seed → generate)

## Goal

Let teams create fixed personas from a short seed (e.g. 「偏屈おじさん」) in the dashboard, without editing YAML. Fixed personas always join each run; the persona designer only fills remaining auto slots. Retire means archive (keep memory/session; restore later).

## Data model (`agents.json`)

Extend `Agent` with:

| Field | Values | Default if missing |
|-------|--------|--------------------|
| `origin` | `fixed` \| `auto` | `auto` |
| `status` | `active` \| `archived` | `active` |
| `seed` | string (fixed only) | — |
| `lenses` | string[] | — |

- **Fixed retire (dashboard):** set `status: archived` (no hard delete). Memories and session files stay. Restore sets `active`.
- **Auto retire (HR `retire_agent`):** hard-delete as today. Fixed IDs always return `false` from `retireAgent` (boolean unchanged; HR tool wraps `{ success, error? }`).

## Creation flow

1. User enters a short seed in the Personas panel.
2. `POST /api/personas` loads product spec (app understanding + goals). Spec required — no generic persona without it.
3. LLM fills `name`, `role`, `persona`, `lenses` in one shot; save as `origin: fixed`, `status: active`.
4. User may PATCH fields afterward.

Lenses are stored/edited only in v1 — not wired into scenario/lens dispatch.

## Run roster

- `N = MAX_BROWSERS + MAX_EXPLORERS`
- `F =` count of active fixed
- `effectiveN = max(N, F)`
- `autoSlots = max(0, effectiveN - F)`
- If `effectiveN > N`, bump `MAX_BROWSERS` by the shortfall (if browsers are 0 and only explorers are non-zero, bump explorers instead).

HR prompt: do not touch fixed; align active autos to exactly `autoSlots` (add or retire autos only).

After HR, **deterministically** `buildRunRoster(fixed, autos, autoSlots)`, then `splitRosterForDispatch` into explorer/browser lanes with **no double assignment**. Surplus autos never run even if HR miscounts.

## API

| Method | Path | Behavior |
|--------|------|----------|
| GET | `/api/personas` | Fixed list (`archived=1` includes archived) |
| POST | `/api/personas` | `{ seed }` → generate + save |
| PATCH | `/api/personas/:id` | Edit fixed+active fields |
| POST | `/api/personas/:id/archive` | Archive |
| POST | `/api/personas/:id/restore` | Restore |

Errors: empty seed / missing spec → 400; LLM failure → 502; auto id → 404.  
`POST /api/personas` uses a stricter rate limit (~10/min) in addition to the global limiter.

## Out of scope

- Regenerate-from-seed button
- Bidirectional sync with `personas.yaml` packs
- Environment editor for fixed personas
- Wiring lenses into assignment pipelines
