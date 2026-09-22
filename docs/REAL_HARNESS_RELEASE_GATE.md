# Real-harness release gate

Harness Remote treats installed coding harnesses as the authority for their Native Sessions. Unit tests and browser fixtures are necessary, but they cannot prove that the current OpenCode, Codex, Claude, OMP, PI, GitHub Copilot CLI, OpenCode 2 and MiMo integrations still behave correctly against real installed harnesses.

This gate turns the existing Session-first soak into a repeatable release check and records what was actually verified on a machine.

## What it verifies

For every selected harness with usable inference, the gate makes that harness the **primary** once and runs the existing Session-first soak against a second harness. A strict release run therefore exercises, for each inference-capable primary:

- live model-catalog discovery;
- two real Native Sessions;
- repeated model changes;
- repeated prompt delivery and transcript convergence;
- cross-harness navigation/isolation;
- an advertised variant when one exists;
- native Stop followed by a usable Session;
- exactly-once user-turn checks;
- bounded listeners/subscribers and no leftover ACP requests, queued prompts or unresolved mutations.

Every selected harness, including one explicitly marked inference-unavailable, must still pass daemon preflight, installed-harness health/build identity and exact Native Session rediscovery. Declaring inference unavailable never turns missing integration plumbing into a pass.

The gate does not replace Android background/foreground or physical network-interruption testing. Those remain separate release checks because they require a real client/device boundary.

## Start the daemon

Run the development build you intend to validate and expose only the machine endpoint needed by the test. For example:

```bash
npm start -- \
  --host 127.0.0.1 \
  --port 4097 \
  --username harness \
  --password 'local-test-password' \
  --root "$HOME/Software"
```

Use the same commit/build for every harness in one release evidence set.

## Self-hosted real gate without API keys

When the development machine already has all supported harnesses installed and authenticated, prefer
`.github/workflows/real-harness-self-hosted.yml`. It runs on that same Linux account and therefore
reuses the harnesses' existing local login/session stores instead of copying credentials into GitHub
Secrets.

The workflow targets a runner with all of these labels:

```text
self-hosted, linux, x64, harness-real
```

Register the repository runner from **Settings → Actions → Runners → New self-hosted runner** while
logged into the same Linux user that normally runs Codex, Claude, OpenCode, OMP, PI, Copilot and
MiMo. During `config.sh`, add the custom label `harness-real`. GitHub supplies a short-lived
registration token in those setup instructions.

Do not run this runner under a separate service account if the purpose is real-login validation:
that account would have a different `HOME` and would not see the existing harness credentials.
Running the runner interactively with `./run.sh` is the simplest first validation. If it is later
installed as a service, keep it under the same Linux user and verify that `HOME` and PATH still
resolve to the authenticated harness installations.

The self-hosted gate never reads, copies or uploads credential files. It:

- verifies all eight executables are on PATH;
- creates only Harness Remote-owned workspaces below
  `~/.harness-remote/smoke-workspaces/`, which the normal Session rail filters;
- keeps those workspaces durable because some native harnesses persist Session ids but expose no
  deletion primitive; deleting a workspace would create broken history records;
- uses an isolated temporary Harness Remote daemon state directory;
- creates a temporary `opencode2` wrapper under `$RUNNER_TEMP` only when that alias is absent;
- runs the real Copilot/OpenCode 2/MiMo create → prompt → Stop → history → reopen smokes;
- starts the eight-harness daemon using the machine's existing local authentication;
- runs the strict real-harness release gate for
  `opencode,codex,claude,omp,pi,copilot,opencode2,mimo`;
- uploads only the credential-free JSON evidence report.

Trigger it manually with **Run workflow**, or add the `real-harness-local` label to a
same-repository pull request. Once that label is present, later pushes rerun the real local gate.
A missing executable, expired login, provider failure, model failure, broken history, Stop failure or
routing failure makes the workflow fail; none is converted into an inference-unavailable pass.

## Authenticated GitHub Actions gate

The repository also contains `.github/workflows/real-harness-auth.yml`, a deliberately opt-in
GitHub Actions gate that recreates a real eight-harness machine on an ephemeral Ubuntu runner. It is
not the ordinary PR regression suite: it installs the pinned harness CLIs, supplies non-interactive
provider credentials, runs the real Copilot/OpenCode 2/MiMo create-Stop-reopen probes, starts the
multi-harness daemon and finally runs this strict release gate across all eight harnesses.

Trigger it either with **Run workflow** or by adding the `real-harness` label to a same-repository
pull request. A labeled PR reruns the authenticated gate after later pushes. Fork pull requests never
receive repository secrets and therefore do not run this job.

Repository secrets required for the full authenticated gate:

| Secret | Used by |
| --- | --- |
| `OPENAI_API_KEY` | Codex API-key auth; OpenCode, OpenCode 2, OMP and PI provider inference |
| `ANTHROPIC_API_KEY` | Claude ACP inference; also seeds PI's ephemeral stored credential file |
| `MIMO_API_KEY` | MiMo Code via Xiaomi's OpenAI-compatible API |

Copilot normally needs **no repository secret**. The workflow grants its built-in `GITHUB_TOKEN`
`copilot-requests: write` and the Copilot CLI consumes that token non-interactively. If the account
or organization policy does not permit Copilot requests through the Actions token, configure the
optional `COPILOT_GITHUB_TOKEN` repository secret with a fine-grained PAT that has Copilot Requests
permission; the preflight prefers that token when present.

The workflow deliberately fails before inference if a required provider secret is absent. It never
prints secret values, lengths or prefixes. PI receives a temporary `~/.pi/agent/auth.json` with
mode 0600 on the ephemeral runner because the pinned PI ACP adapter prefers stored credentials.
That file is never uploaded. MiMo receives a secret-free inline config containing
`{env:MIMO_API_KEY}`; the literal key never enters the repository or the evidence artifact.

Only `bridge/artifacts/real-harness-authenticated.json` is uploaded as release evidence. Raw daemon
logs and credential files are not artifacts. The JSON report is designed to contain no provider
keys, HTTP Basic password, prompt bodies or complete model catalogs.

## Strict release run

From `bridge/`:

```bash
HR_URL=http://127.0.0.1:4097 \
HR_USER=harness \
HR_PASS='local-test-password' \
HR_DIR_A="$HOME/Software/project-a" \
HR_DIR_B="$HOME/Software/project-b" \
npm run gate:real-harness
```

By default the gate validates:

```text
opencode,codex,claude,omp,pi,copilot,opencode2,mimo
```

Each harness becomes primary once. The secondary rotates so that switching/isolation is exercised as part of every leg.

A successful strict run writes a report under `artifacts/real-harness-gate-<timestamp>.json` with verdict `verified`.

The report deliberately contains no username, password, prompt body or model catalog. It records the commit when available, platform/architecture/Node version, endpoint without URL credentials, harness pairs, durations, exit status, evidence strength, explicit model selectors and final verdict.

## Preflight

Before any long-running soak starts, the gate calls the daemon diagnostics endpoint once and verifies the requested release surface:

- the daemon is reachable and accepts the supplied credentials;
- every selected harness is registered on that daemon;
- every selected harness has model discovery configured.

It then health-checks the concrete installed build and requires a created Native Session to be rediscovered through the bounded Session index for every selected harness.

If any of those checks fail, no inference soak process is launched. The JSON report still gets written with `verdict: "failed"` and a concise section showing the missing harness, model-discovery or Session-discovery evidence. This keeps startup/configuration failures distinct from inference failures and avoids spending several minutes on legs that cannot succeed.

The preflight report contains only non-sensitive harness metadata such as id, backend, transport, state, model-catalog source and cached-model count. It does not persist credentials or full model inventories.

## Select known-working models

A harness catalog can contain thousands of models from providers that are not all configured on the machine running the release gate. When you know which models actually work, constrain that harness to them instead of letting the soak use the first distinct models in the catalog:

```bash
npm run gate:real-harness -- \
  --harnesses opencode,codex,omp,pi \
  --model opencode=muse-spark-1.3-contributor-free \
  --model opencode=muse-spark-1.2-contributor-free \
  --model codex=gpt-5.6-sol \
  --model codex=gpt-5.6-luna \
  --inference-unavailable omp,pi
```

`--model` is repeatable. For each harness configured this way, provide at least two distinct selectors because the release gate must still prove model switching. A selector can be:

- a `modelID`, when that id is unique in the harness-advertised catalog;
- an exact `providerID/modelID`, when the same model id appears under multiple providers.

The soak resolves every selector against the live catalog before creating the test Sessions. A missing or ambiguous selector fails closed rather than silently choosing another model. The ordinary repeated model changes, Stop recovery and cross-harness cycles then use only the selected model identities.

Variant coverage is also constrained to those selected model identities. If none of the known-working selected models advertises a variant, that optional variant leg is skipped rather than testing a different provider/model whose inference has not been established on that machine.

Harnesses without `--model` keep the existing automatic selection of the first three distinct advertised model identities. Explicit selection only changes release-test evidence; it does not change Harness Remote runtime model discovery or user-facing model behavior.

A harness cannot be both listed in `--inference-unavailable` and given explicit models in the same run.

## A selected harness has no usable inference

A harness can be installed and integrated correctly while none of its advertised provider models is usable on the machine under test. For example, a catalog can advertise models whose provider credential or subscription is not configured locally.

Do not let repeated inference timeouts masquerade as a Harness Remote regression. Declare only the affected selected harnesses explicitly:

```bash
npm run gate:real-harness -- \
  --harnesses opencode,codex,omp,pi \
  --inference-unavailable omp,pi
```

The gate still requires `omp` and `pi` to pass daemon registration, model-discovery configuration, installed-build health and Native Session rediscovery. Their inference-heavy **primary** legs are skipped instead of sending prompts to models known to be unusable on that machine.

If every attempted inference leg passes, the report is intentionally still not release-verified:

```json
{
  "releaseEligible": false,
  "settings": {
    "inferenceUnavailable": ["omp", "pi"]
  },
  "verdict": "inference-unverified"
}
```

The command exits with code `2`. The coverage matrix marks those harnesses with `inferenceStatus: "unverified"` and leaves the inference-heavy coverage items missing. This is evidence of what was actually tested, not a waiver.

`--inference-unavailable` can only name harnesses already selected by `--harnesses`. The same value can be supplied through `HR_GATE_INFERENCE_UNAVAILABLE`.

## Run a subset while developing

A two-or-more harness subset is useful before the full release run:

```bash
npm run gate:real-harness -- --harnesses codex,claude,opencode
```

This can prove the selected integrations, but it is not evidence that the omitted harnesses were verified. For a release candidate, run all supported harnesses unless the release record explicitly marks an integration as unverified.

## When a model does not echo markers reliably

The soak normally asks the primary model to echo a unique marker. This is the strongest routing evidence because it ties a specific prompt to a specific assistant reply.

For a harness/model that does not reliably obey that instruction:

```bash
HR_ECHO_MARKERS=0 npm run gate:real-harness
```

The run can still pass, but the JSON report records `routingEvidence: "turn-arrival"` instead of `echo-marker`. Do not describe the two evidence strengths as identical.

## Control-plane-only mode

If providers cannot serve inference for the whole selected surface but you still want to exercise routing, catalogs, Session creation and lifecycle plumbing:

```bash
npm run gate:real-harness -- --mode control-plane
```

This mode sets the soak to allow native turn errors and records:

```json
{
  "releaseEligible": false,
  "verdict": "control-plane-only"
}
```

It exits with code `2` even when every control-plane leg passes. This is intentional: a provider outage, missing subscription or invalid inference credential must never be silently promoted to a fully verified release.

Use `--inference-unavailable` instead when only specific selected harnesses lack usable inference and the remaining harnesses should still undergo the strict real-inference soak.

## Custom report location

```bash
npm run gate:real-harness -- --report /tmp/hr-release-evidence.json
```

or set `HR_GATE_REPORT`.

## Existing soak command

For focused diagnosis of one primary/secondary pair, the underlying probe is exposed directly:

```bash
HR_PRIMARY=pi \
HR_SECONDARY=opencode \
HR_URL=http://127.0.0.1:4097 \
HR_USER=harness \
HR_PASS='local-test-password' \
npm run soak:session
```

For direct soak diagnosis, `HR_PRIMARY_MODELS` can contain a JSON array of model selectors, for example `HR_PRIMARY_MODELS='["gpt-5.6-sol","gpt-5.6-luna"]'`.

Useful environment controls include `HR_CYCLES`, `HR_TURN_BUDGET_MS`, `HR_DIR_A`, `HR_DIR_B`, `HR_ECHO_MARKERS`, `HR_PRIMARY_MODELS` and `HR_ALLOW_TURN_ERRORS`.

## Interpreting catalog checks

Two different harnesses can legitimately advertise overlapping, or even identical, provider/model inventories. Catalog equality by itself is therefore not proof of cross-harness leakage and is no longer treated as a failure.

A populated catalog also does not prove that the local machine has credentials/subscriptions for every advertised provider. That distinction is why unavailable inference is recorded explicitly rather than inferred from a timeout.

The soak proves the relevant ownership invariants instead:

- both agent-scoped model endpoints return usable catalogs;
- diagnostics expose separate registered entries for the primary and secondary harness;
- each entry owns a populated model-catalog diagnostic with an explicit source;
- the primary and secondary catalog fingerprints remain individually stable while the test repeatedly switches between harnesses;
- Native Session creation and prompt routing continue to target the requested harness and Session.

If two harnesses intentionally expose exactly the same normalized model inventory, the soak prints that fact as a note and continues. This avoids a false negative without weakening the isolation checks that actually matter.

## Release record

For each release candidate, preserve the JSON report and record the distinction required by the capability matrix:

| Harness | Implemented | Advertised by installed harness | Verified on this real build | Evidence |
| --- | --- | --- | --- | --- |
| OpenCode | yes/no | yes/no | yes/no | report + notes |
| Codex | yes/no | yes/no | yes/no | report + notes |
| Claude | yes/no | yes/no | yes/no | report + notes |
| OMP | yes/no | yes/no | yes/no | report + notes |
| PI | yes/no | yes/no | yes/no | report + notes |
| GitHub Copilot CLI | yes/no | yes/no | yes/no | report + notes |
| OpenCode 2 | yes/no | yes/no | yes/no | report + notes |
| MiMo Code | yes/no | yes/no | yes/no | report + notes |

A green ordinary PR-check run proves the deterministic regression/product gates. It does **not** by
itself fill the final “Verified on this real build” column. A successful **authenticated real-harness
gate** with report verdict `verified` is the automated evidence intended for that column.
