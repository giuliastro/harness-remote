# Real-harness release gate

Harness Remote treats installed coding harnesses as the authority for their Native Sessions. Unit tests and browser fixtures are necessary, but they cannot prove that the current OpenCode, Codex, Claude, OMP and PI integrations still behave correctly against real installed harnesses.

This gate turns the existing Session-first soak into a repeatable release check and records what was actually verified on a machine.

## What it verifies

For every selected harness, the gate makes that harness the **primary** once and runs the existing Session-first soak against a second harness. A strict release run therefore exercises, for each primary:

- live model-catalog discovery;
- two real Native Sessions;
- repeated model changes;
- repeated prompt delivery and transcript convergence;
- cross-harness navigation/isolation;
- an advertised variant when one exists;
- native Stop followed by a usable Session;
- exactly-once user-turn checks;
- bounded listeners/subscribers and no leftover ACP requests, queued prompts or unresolved mutations.

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
opencode,codex,claude,omp,pi
```

Each harness becomes primary once. The secondary rotates so that switching/isolation is exercised as part of every leg.

A successful strict run writes a report under `artifacts/real-harness-gate-<timestamp>.json` with verdict `verified`.

The report deliberately contains no username, password, prompt body or model catalog. It records the commit when available, platform/architecture/Node version, endpoint without URL credentials, harness pairs, durations, exit status, evidence strength and final verdict.

## Preflight

Before any long-running soak starts, the gate calls the daemon diagnostics endpoint once and verifies the requested release surface:

- the daemon is reachable and accepts the supplied credentials;
- every selected harness is registered on that daemon;
- every selected harness has model discovery configured.

If any of those checks fail, no soak process is launched. The JSON report still gets written with `verdict: "failed"` and a concise `preflight` section showing the missing harnesses or model-discovery configuration. This makes startup/configuration failures distinct from Session/inference failures and avoids spending several minutes on legs that cannot succeed.

The preflight report contains only non-sensitive harness metadata such as id, backend, transport, state, model-catalog source and cached-model count. It does not persist credentials or full model inventories.

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

If a provider cannot serve inference but you still want to exercise routing, catalogs, Session creation and lifecycle plumbing:

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

Useful environment controls include `HR_CYCLES`, `HR_TURN_BUDGET_MS`, `HR_DIR_A`, `HR_DIR_B`, `HR_ECHO_MARKERS` and `HR_ALLOW_TURN_ERRORS`.

## Interpreting catalog checks

Two different harnesses can legitimately advertise overlapping, or even identical, provider/model inventories. Catalog equality by itself is therefore not proof of cross-harness leakage and is no longer treated as a failure.

The soak now proves the relevant ownership invariants instead:

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

A green GitHub Actions run proves the automated regression/product gates. It does **not** by itself fill the final “Verified on this real build” column.
