# Token Harness observability (read-only)

Harness Remote can inspect an optional local Token Harness installation on each Machine. Nothing is installed automatically and no agent settings, routing hooks or optimizer configuration are changed.

## User experience

Open **Machines** and choose **Usage & optimization** on an online machine. The panel reads on demand and displays:

- Installed coding agents and their configured optimization providers.
- Subscription allowance windows (e.g. 5-hour and weekly), remaining percentage, reset timestamps, source and cached evidence when Token Harness supplies them.
- Attributable optimization output reductions as separate token and character measurements, preserving measurement classes and operation counts.

Missing or unavailable quota remains **Unknown**, not 0%. Savings are *not* monetary savings or subscription-allowance savings. Observations refer to the connected Machine and may cover multiple projects; they are not attributed to a native Session.

The UI is shared across Electron, web and Android. It uses the existing authenticated Machine transport.

## Backend contract

`GET /v1/optimization` is an authenticated, machine-scoped, GET-only API. A 30-second single-flight cache prevents multiple clients from launching redundant probes. It returns a small, sanitized schema-1 view, not the raw CLI results.

The bridge calls the local `token-harness` executable with fixed read-only JSON commands:

- `doctor --json`
- `budget --json`
- `metrics --json`

Each invocation has a 12-second timeout and 2 MiB stdout cap. No shell, arbitrary command, untrusted filesystem path or user-provided CLI argument is permitted. No raw prompts, source contents, credentials, diagnostic paths or detailed provider configurations are forwarded to the client.

The bridge may run with Node.js 20+, while the Token Harness CLI requires Node.js 22.13+. A missing executable, incompatible runtime or unsupported JSON contract is an explicit `unavailable` state, not an error that breaks the Machine or its Sessions. If only one observation source fails, the other readings remain visible with a `partial` state.

`metrics` can update Token Harness's own local evidence/import state, but these commands never apply edits to coding-agent configuration.

## Validation

Run `npm test` from `bridge/` and `npm run test:v3-product-ui` and `npm run build` from `web/`. Tests cover quota unknown semantics, mixed measurement units, partial failures, one-flight cache, authentication/GET-only routing, transport and old gateway behavior.

## Follow-up changes worth considering in Token Harness

1. **A stable lightweight `observe --json` command** containing doctor, budget, provider health and recent metrics, with one versioned public DTO. This would reduce CLI process launches and contract coupling.
2. **A `--no-import` or snapshot-only option for metrics**, if strict read-only evidence-state access is desired.
3. **Explicit session correlation IDs in receipts** only when they can be backed by native harness events. Without this, maintain machine-/harness-level scope in Harness Remote.
4. **A source timestamp and stable bucket identifier on every allowance window** (already present in current Token Harness domain types), and documented semantics for unavailable/stale/authoritative values.
5. **A signed/portable bundled observer** for Electron installations without a global `token-harness` on PATH, without raising Harness Remote's own minimum Node version.

None of these Token Harness changes is required for this initial PR.
