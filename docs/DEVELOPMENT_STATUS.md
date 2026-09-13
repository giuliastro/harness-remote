# Development status

> This file is the handoff point for ongoing development work that is not yet on `main`.
> Keep it short, current and safe to read at the start of a new coding-agent session.

## Branch policy

- Persistent integration branch: `codex/development-2026-09-11`.
- Never merge development work directly into `main`.
- Feature/fix PRs target `codex/development-2026-09-11` only.
- Merge into the integration branch only after relevant tests and CI are green.
- ACP, Native Session and harness-runtime changes require regression review against previously fixed failures before merge.

## Current integration baseline

- Integration head after PR #472: `3e5f65bbe11b99eccfc4536f432e9db7033540b6`.
- PR #468 added bounded recovery of the embedded desktop daemon and was validated on Zorin with a real `SIGSTOP` recovery test.
- PR #469 added bounded Git aggregate outcome evidence: tracked files, insertions, deletions and binary files, with no raw diff/hunks/source sent to the client.
- PR #470 fixed the Machines UX race: connection fields now appear only after an explicit **Add machine** action, including when Electron discovers its managed local machine asynchronously.
- PR #471 made cross-machine continuation planning/safety a blocking Chromium regression.
- PR #472 extended that blocking smoke through real execution: exact-workspace recovery after a blocked Project choice, exactly-once target Native Session creation, source+target lineage persistence, authority reset, exactly-once first prompt and opening the target Session after live model-catalog bootstrap.
- #472 also fixed the same-machine Project-catalog refresh race by preserving a still-valid explicit Project choice without carrying a machine-local Project id across machine changes.
- The final #472 head passed the complete PR gate before integration: type/regressions, bridge macOS/Windows, full Chromium product/native-Session suite and signed Debug APK artifact.

## Current roadmap boundary

There is no active implementation PR after #472.

### P0 — issue #368

Repository/fixture-side automation is effectively exhausted. Do not add synthetic coverage for the remaining true boundaries. #368 stays open for:

- strict `gate:real-harness` execution against actually installed, concretely versioned OpenCode/Codex/Claude/OMP/PI builds on a traceable machine;
- real daemon/adapter restart plus persisted-Session resume/claim evidence against those installed harnesses;
- physical Android foreground/background/network-interruption checks;
- repository-admin enforcement of `main` pull-request/required-check rules.

### P1 — issue #369

Repo-side pairing, Attention semantics, desktop-owned local runtime, packaged-runtime execution, PATH recovery, health/reconnect recovery and Machines simplification are implemented. #468/#470 add the latest recovery/UX evidence.

Do not invent more P1 UI/runtime surface merely because #369 remains open. It is intentionally left open while its declared P0 prerequisite still has real-environment/admin evidence outstanding.

### P2 — issue #371

Do not restart federation or cross-machine continuity work already integrated:

- #411-#413: federated Native Session read model, operational buckets and machine/Project/harness/model/state scopes;
- later P2 slices: durable Project/native identity, lineage, portable handoff state and crash/retry-safe target creation/first prompt;
- #435/#436: recovered portable state plus source-authority invalidation / target fail-closed authorization acceptance;
- #437-#439/#469: bounded Project/outcome evidence, structured completion/attention/next action and Git aggregates;
- #471/#472: blocking Chromium planning and full execution coverage.

One deliberate non-claim remains: do not infer `checks run/failed` from transcript/tool prose. There is no provider-neutral structured source yet, so absence is safer than heuristic evidence.

#371 remains open while its declared #368/#369 prerequisites are open at true-boundary evidence, not because another federation implementation is missing.

## Product direction

Continue from `docs/HARNESS_3_ROADMAP.md`, prioritizing correctness/recovery, onboarding, attention visibility and Native Session federation. Avoid turning Harness Remote into a generic IDE/task manager or reimplementing capabilities that belong to native harnesses.

Do not begin P3 provider-extension work merely to keep development moving while P0/P1/P2 true-boundary gates are unresolved. Prefer real validation or a clearly evidenced defect over speculative new surface area.
