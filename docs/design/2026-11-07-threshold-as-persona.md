# Boundary probing is a persona, not a lane

**Date:** 2026-11-07
**Status:** Accepted
**Supersedes:** [2026-08-27-threshold-agent.md](2026-08-27-threshold-agent.md)

## Background

The threshold lane was a separate agent type (`threshold`) that walked Product Discovery's `thresholdCandidates` as a checklist: `area`, `signal`, and `howToProbe` were assigned to ephemeral "Threshold Prober" agents. That found some boundary bugs, and it also made probing a script. The person was not experiencing a limit. They were executing steps.

shoal's other browser agents already have a behavioral contract. The interesting failure at a limit — the page goes blank, the message does not say what broke, the click that should have been once can be pressed again — is something a particular person does, then reports as what happened to them.

## Decision

Remove the threshold lane. Keep one browser persona whose contract is to push visible limits:

- When an input suggests a limit, try that limit once.
- Also send it empty, and try one huge number.
- Press a control that looks finished a second time.

Those rules are how this person uses any app. They are not a checklist of one product's fields.

Product Discovery still writes `thresholdCandidates`, and the `ThresholdCandidate` shape is unchanged so a cached spec still loads. At run time only `area` is used, as a hint for where this person looks first. `signal` and `howToProbe` are not passed as instructions.

The persona is on the roster:

- Org design always asks for this seed, and appends the canonical contract so a model cannot rewrite Exploration into app-specific steps.
- The dashboard seed path (`someone who pushes every visible limit`, or a seed that says 境界を押し込む) keeps that same contract.
- If HR did not recruit them, the run roster still includes one. They browse with the other browser personas. Logs and the diary use their name. There is no `threshold` species and no Swarm `TH` badge.

Findings go through `post_feedback`, in the first person, the same path as every other browser persona. Triage, severity, and Product Edge are unchanged. A boundary bug is still a bug. It is not an `edge-risk`.

Legacy `personas.yaml` packs that omit `contract` still load. This persona does not require a pack to ship them.

## Migration

| Removed | What to do |
|---|---|
| `agentType: "threshold"` | Boundary probing is `browser`. Old run logs that say `[threshold]` are historical. |
| `MAX_THRESHOLDS` | Delete it. There is no count to set. The persona is one member of the browser roster. |
| `SHOAL_THRESHOLD_ITERATIONS` | Delete it. They use the browser turn budget (`SHOAL_BROWSER_ITERATIONS`). |
| Dashboard / `POST /api/runs/start` `maxThresholds` | Stop sending it. Extra values are ignored. |
| MCP `start_run.maxThresholds` | Removed from the tool schema. A client that still sends the property is not forwarded; the run starts without it. |
| Swarm label `TH` | Gone. This person is a browser agent, shown as `BR`, under their name. |

Cached product specs that lack `thresholdCandidates` still load. Set `REFRESH_SPEC=1` once if you want this person to be pointed at discovered areas. Without candidates they still push limits they can see on the screen.

`agents.json` does not gain a new field. A fixed persona created from the boundary-pushing seed is an ordinary fixed persona with this contract.

## Out of scope

- Changing Product Edge or the `edge-risk` label.
- Changing triage severity.
- Changing the `ThresholdCandidate` shape, or dropping `signal` / `howToProbe` from stored specs.
- Expected-behavior checks, a boundary health score, or editing candidates in the Hall.
- A storage redesign for the roster.
