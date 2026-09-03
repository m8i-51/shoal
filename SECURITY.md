# Security Policy

## Reporting a vulnerability

Please **do not** report security vulnerabilities through public GitHub issues,
pull requests, or discussions.

Instead, report them privately through GitHub's
[private vulnerability reporting](https://github.com/m8i-51/shoal/security/advisories/new)
(the **Security → Report a vulnerability** tab on this repository). This creates
a private advisory visible only to the maintainers.

When reporting, please include as much of the following as you can:

- A description of the issue and its potential impact
- Steps to reproduce or a proof of concept
- The affected version(s) and configuration
- Any suggested remediation

We will acknowledge your report, investigate, and keep you informed of the fix
and disclosure timeline.

## Supported versions

shoal is distributed on npm as [`@m8i-51/shoal`](https://www.npmjs.com/package/@m8i-51/shoal).
Security fixes are applied to the latest published release. Please upgrade to the
latest version before reporting an issue.

## Operational safety notes

shoal drives a real browser and can send API requests to the target app you
point it at. Two settings materially affect its blast radius:

- **`SHOAL_MODE`** controls how much agents may write to your app:
  - `read-only` — mutation requests (POST/PUT/PATCH/DELETE) from browser agents
    are blocked at the network layer, so shoal itself writes nothing to the
    target app. It does **not** mean nothing leaves the machine: everything
    agents read (page text, accessibility tree, console/network output,
    screenshots) is still sent to your configured LLM provider. See
    [What is sent to the LLM provider](#what-is-sent-to-the-llm-provider)
    before pointing it at an app with real user data.
  - `safe` (default) — test data is allowed, but irreversible actions (delete,
    payment, sending email/invites) are avoided; the destructive-click guard
    recognizes both English and Japanese phrasing and can be extended with
    `SHOAL_DESTRUCTIVE_PATTERNS`.
  - `full` — no restrictions. Use only against disposable environments.
- **Credentials** (LLM keys, `GITHUB_TOKEN`, tracker tokens, `test-accounts/`)
  are read from your environment / local files. Keep them out of commits — `.env`
  and `test-accounts/` are gitignored. Never paste secrets into issues or logs.
  Known credentials (test-account passwords, anything typed into a field
  detected as a password) are scrubbed from Playwright trace zips at save
  time, on top of the masking already applied to console output, run JSON,
  and the HTML report; set `SHOAL_TRACE=0` to disable tracing entirely.
- **`SHOAL_MAX_USD`** caps estimated LLM spend for a run. Without it, the only
  limits are the per-agent turn budgets. Set it when a run is triggered by
  anything other than you typing the command.

When in doubt, run against a staging environment, or with data that has been
anonymised, rather than production data — regardless of `SHOAL_MODE`, since
the mode only governs writes to your app, not what agents read and send to
the LLM provider.

## What is sent to the LLM provider

shoal's agents decide what to do next by sending what they observe to the LLM
provider you configured. No `SHOAL_MODE` changes this — it only controls
whether shoal writes to your app, not what leaves the machine. What is sent
includes:

- Page text and the accessibility tree of every screen an agent visits
- Console messages and network errors captured during a session
- DOM diffs computed between actions
- Screenshots (as images, for models that accept them)
- API tool results (whatever your target's API returns)
- Test-account credentials, in the prompt that hands an agent its login —
  the email and password shoal signs it in with, not real user credentials

Where this data goes is entirely a function of your provider configuration:

- **Provider choice** (`LLM_PROVIDER` / `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`
  / an OpenAI-compatible `LLM_BASE_URL`) decides which company's servers see
  it.
- **`AWS_REGION`** (with `LLM_PROVIDER=bedrock`) decides which AWS region
  processes it, if data residency matters for your compliance requirements.

If the target app can display real personal data — customer records, support
tickets, uploaded documents — that data reaches whichever LLM provider you
configured the moment an agent reads the screen it's on. Point shoal at a
staging environment with synthetic data, or at production data that has been
anonymised, rather than at an app carrying real personal data you would not
otherwise send to a third-party API.

## The dashboard is an authenticated control surface

`shoal serve` is not a read-only viewer. `POST /api/runs/start` launches a run
against a caller-supplied URL, with a caller-supplied LLM endpoint and key, and
the log and findings endpoints return whatever the swarm saw inside your app.

- It binds to **`127.0.0.1` by default**. Only the machine it runs on can reach it.
- Set **`SHOAL_HOST`** to expose it (e.g. `0.0.0.0` in a container). shoal
  **refuses to start** on a non-loopback address unless `SHOAL_ALLOW_INSECURE=1`
  is also set: the listener is plain HTTP, and a warning printed after the fact
  does not undo an accidental exposure. Exposure also makes a **token
  mandatory**: set `SHOAL_TOKEN`, or shoal generates one and prints it, with a
  ready-made `?token=…` URL, at startup.
- The `?token=…` URL is a **bootstrap only**: the server exchanges it for an
  `HttpOnly; SameSite=Strict` session cookie, and the dashboard strips it from
  the address bar. The token is never held in `sessionStorage` or any other
  JavaScript-readable place, so an XSS on the dashboard origin cannot read it
  out and reuse it elsewhere. `EventSource` and the report iframe ride the same
  cookie. Scripted clients may still send `Authorization: Bearer <token>` or
  `X-Shoal-Token: <token>`.
- **The listener is plain HTTP.** Over a non-loopback binding the token and the
  session cookie cross the network in cleartext, so put a TLS-terminating
  reverse proxy in front of it or, better, use an SSH tunnel. shoal warns about
  this at startup rather than shipping its own TLS listener: certificate
  handling belongs to the proxy, not to a test tool.
- Every request is checked for a `Host` we serve and a same-origin `Origin`,
  which blocks DNS rebinding and drive-by calls from another site you have open.
  Putting a reverse proxy in front — even one that leaves `SHOAL_HOST` at the
  loopback default and only the proxy listens publicly — fails both checks
  unless the proxy's public hostname is named in **`SHOAL_ALLOWED_HOSTS`**
  (comma-separated): a proxy that preserves the `Host` header sends one shoal
  has never heard of, and a proxy that rewrites `Host` to the upstream address
  (nginx's default) still forwards the browser's real `Origin` unchanged,
  which then no longer matches. Setting `SHOAL_ALLOWED_HOSTS` also makes a
  token mandatory, the same as a non-loopback `SHOAL_HOST` — the dashboard is
  reachable from the network either way.

Exposing the dashboard to a shared network — even with a token — means anyone
with that token can point a swarm at any URL your machine can reach. Prefer an
SSH tunnel to opening a port.

## Prompt injection from the target app

Agents read your app and act on what they read. Page text, accessibility trees,
console messages, network errors, DOM diffs, and API responses all flow into an
LLM that can click, fill forms, and file issues with your tracker token. So any
text your app can display — a product description, a user's comment, an error
message, a filename — reaches the model, and text that reaches a model can try
to instruct it.

What shoal does about it:

- Everything derived from the target app is wrapped in an explicit
  untrusted-content block before it reaches the agent, and every agent prompt
  states that content inside that block is data, never instructions.
- Attempts by page content to close or forge the block are neutralised, so
  injected text cannot escape into the instruction context.
- Agents are told to report an injection attempt as a finding rather than act
  on it.

What that does **not** do: none of this is a guarantee. Fencing raises the bar;
it does not make an LLM immune to persuasion. Treat these as the operating rules:

- **Do not point an authenticated swarm at an app whose content you do not
  trust.** An app where third parties can post content (public UGC, a shared
  inbox, a customer-facing form other people submit to) is exactly the case
  where injected instructions arrive from someone who is not you.
- **Give the run the least authority that still works.** `SHOAL_MODE=read-only`
  for anything production-adjacent; a tracker token scoped to one repo or
  project; test accounts with no access to real customer data.
- **Read what gets filed.** Issues are written by an LLM from content it read in
  your app. Review them as untrusted output, not as verified reports.
