# Design: Claude CLI provider (`LLM_PROVIDER=claude-cli`)

Date: 2026-08-27  
Status: draft (awaiting review)  
Repo: shoal

## Goal

Let shoal use a Claude Pro/Max (or Team/Enterprise) subscription the same way OpenClaw and xangi do: through the **official Claude Code login**, without shoal reading, storing, or refreshing OAuth tokens. Keep the existing Anthropic API-key path unchanged.

## Non-goals

- Extracting or proxying Claude.ai OAuth tokens into `@anthropic-ai/sdk` / Messages API
- Web UI controls for provider selection
- Enabling Claude Code built-in tools (Bash, Edit, etc.) by default
- Automating `claude auth login` inside Docker

## Context

| Product | How subscription works |
|---|---|
| xangi / OpenClaw | Spawn / Agent SDK → official Claude Code owns auth |
| shoal today | `@anthropic-ai/sdk` Messages API + custom `agent-loop` |
| shoal Codex | ChatGPT subscription OAuth against Codex API (`LLM_PROVIDER=codex`) |

Anthropic forbids third parties from intermediating Free/Pro/Max credentials in their own API clients. The allowed pattern used by OpenClaw is: user logs into Claude Code locally; the app launches Claude Code / Agent SDK and never touches the tokens.

shoal cannot drop-in replace `createMessage` with subscription OAuth. The Claude Agent SDK owns its own agent loop, so `claude-cli` must take a different execution path.

## Decision

Add `LLM_PROVIDER=claude-cli`:

1. Auth: user runs `claude auth login` (or `npm run auth:claude` helper).
2. Runtime: `@anthropic-ai/claude-agent-sdk` launches Claude Code.
3. Tools: shoal tools are exposed as an **in-process MCP** server to the SDK.
4. Loop: for this provider, skip `agent-loop.ts`’s Messages API turn loop; call Agent SDK `query()` once per agent task.
5. Cost: treat like Codex — `estimateCost` returns `null`.
6. Docs: state clearly that shoal never handles OAuth tokens; for redistributed/product use prefer API key or Bedrock.

## Architecture

```
ツール定義（name / description / input_schema / execute）
        ├─ anthropic / bedrock / openai / codex / … 
        │     → agent-loop.ts (createMessage 往復)
        └─ claude-cli
              → in-process MCP + Agent SDK query()
```

### Provider factory

Extend `framework/llm-client.ts` (or a sibling module) so `createLLMClient()` recognizes `claude-cli` and returns a client/runtime descriptor that callers can branch on — not a fake `createMessage` shim.

Preferred shape:

- Keep `createLLMClient()` for Messages-API-compatible providers.
- Add `isClaudeCliProvider(provider)` / `runWithClaudeCli({ system, tools, prompt, model, … })` for the SDK path.
- Call sites that today do `createMessage` loops (browser agent, API explorer, triage, designers, account manager) branch: if `claude-cli`, use the SDK runner with the same tool catalog; else existing loop.

### Tool catalog

Introduce a thin shared representation used by both paths:

```ts
interface ShoalTool {
  name: string;
  description: string;
  input_schema: object;
  execute: (input: unknown, ctx: ToolContext) => Promise<string | ToolResult>;
}
```

- Messages path: map to Anthropic `Tool` + existing executors.
- Claude CLI path: register as in-process MCP tools; `allowedTools` limited to those names.
- Claude Code built-in tools: **disabled by default** (`allowedTools` allowlist only / deny Bash|Edit|Write|… as required by SDK options).

### Auth helper

`scripts/auth-claude.ts` + `npm run auth:claude`:

1. Verify `claude` is on `PATH`.
2. Run `claude auth status` (or equivalent); if not logged in, print instructions to run `claude auth login` and exit non-zero (optional: spawn login interactively like Codex).
3. Update `.env`: `LLM_PROVIDER=claude-cli`, default `LLM_MODEL` if unset.
4. Never read keychain / `.credentials` / OAuth token files.

### Env / load-env

- `.env.example`: Claude CLI section next to Codex.
- `load-env.ts`: `claude-cli` skips “missing API key” warning (same as `codex`).
- If `ANTHROPIC_API_KEY` is set, document that Claude Code / Agent SDK may prefer it over subscription; users who want subscription should unset it (or follow Claude Code’s documented precedence).

### Cost

Add `claude-cli` to `FREE_PROVIDERS` in `framework/cost.ts` (alongside `codex`).

## User-facing UX

```env
# --- Claude CLI (Claude Code subscription / login) ---
# Prerequisite: install Claude Code, then `claude auth login` or `npm run auth:claude`
# LLM_PROVIDER=claude-cli
# LLM_MODEL=claude-sonnet-4-6   # optional
```

README (EN + JA) provider table: one row for Claude CLI, plus a short compliance note.

## Compliance note (README)

Anthropic does not permit third-party apps to offer Claude.ai login or to route Free/Pro/Max credentials through their own API clients. shoal’s `claude-cli` provider only launches the official Claude Code / Agent SDK after the user authenticates themselves. For shipping shoal as a hosted/redistributed product, use API keys or Bedrock.

## Testing

- Unit tests with mocked Agent SDK / MCP registration (no real Claude login in CI).
- `load-env` / `createLLMClient` / cost tests for `claude-cli`.
- `auth:claude` script tests with stubbed `claude` binary (status ok / missing / not logged in).
- Existing provider tests remain green.

## Rollout / risks

| Risk | Mitigation |
|---|---|
| Agent SDK API churn | Pin dependency; wrap behind one module |
| Behavioral drift vs Messages loop (turn limits, screenshots) | Share tool catalog; preserve max-turn / timeout controls at the SDK query options layer |
| Users expect drop-in `createMessage` | Document that `claude-cli` replaces the loop |
| ToS misunderstanding | README compliance note; no token file access in code review checklist |

## Defaults locked for implementation

- **All current `createMessage` call sites** (browser agent, API explorer, triage, product discovery, scenario/org designers, account manager) use the Claude CLI / Agent SDK path when `LLM_PROVIDER=claude-cli`. No hybrid “API key for triage, CLI for browsers” in v1.
- **Default model:** `claude-sonnet-4-6` (overridable via `LLM_MODEL`). Adjust only if Agent SDK rejects the alias at implement time; then pick the nearest supported Sonnet alias and document it.
- **Agent SDK options:** confirm exact flag names for in-process MCP registration and built-in tool denial against the pinned `@anthropic-ai/claude-agent-sdk` version during implementation; behavior must match “shoal tools only.”
- **Max turns / timeout:** map existing explorer limits onto SDK query options (or an outer abort) so runs cannot unbounded-loop.
