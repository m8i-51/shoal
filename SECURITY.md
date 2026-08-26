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
    are blocked at the network layer. Safe to point at production.
  - `safe` (default) — test data is allowed, but irreversible actions (delete,
    payment, sending email/invites) are avoided.
  - `full` — no restrictions. Use only against disposable environments.
- **Credentials** (LLM keys, `GITHUB_TOKEN`, tracker tokens, `test-accounts/`)
  are read from your environment / local files. Keep them out of commits — `.env`
  and `test-accounts/` are gitignored. Never paste secrets into issues or logs.

When in doubt, run against a staging or disposable environment rather than
production.
