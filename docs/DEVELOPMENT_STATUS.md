# Development status

> This file is the handoff point for ongoing development work that is not yet on `main`.
> Keep it short, current and safe to read at the start of a new coding-agent session.

## Branch policy

- Persistent integration branch: `codex/development-2026-09-11`
- Never merge development work directly into `main`.
- Feature/fix PRs target `codex/development-2026-09-11` only.
- Merge into the integration branch only after relevant tests and CI are green.
- ACP, Native Session and harness-runtime changes require regression review against previously fixed failures before merge.

## Current integration baseline

- Integration head after PR #471: `b30ccbd0c5a9dff878dc73a91870990b3bf01350`.
- PR #468 added bounded recovery of the embedded desktop daemon and was validated on Zorin with a real `SIGSTOP` recovery test.
- PR #469 added bounded Git aggregate outcome evidence: tracked files, insertions, deletions and binary files, with no raw diff/hunks/source sent to the client.
- PR #470 fixed the universal Machines UX race: connection fields now appear only after an explicit **Add machine** action, including when Electron discovers its managed local machine asynchronously.
- PR #471 made cross-machine continuation safety a blocking Chromium regression: target model/capability discovery, Project identity continuity and mismatched-repository fail-closed behavior now run on every PR.
- #469, #470 and #471 passed the complete PR gate before integration: Linux/web regressions, macOS/Windows bridge tests, Chromium product smoke and Debug APK.

## Work in progress

### P2 cross-machine browser execution

Branch: `codex/p2-cross-machine-browser-execution`

Goal: extend the blocking cross-machine browser regression through the real continuation mutation path instead of stopping at planning readiness.

Implemented on the branch:

- the smoke first proves mismatched Project continuity remains fail-closed and causes no target mutation;
- an exact-workspace continuation then creates one target native Session with a durable request id;
- the identical lineage edge must be stored on source and target machines before first-prompt delivery;
- the first prompt must be delivered exactly once with its own durable request id and the bounded transferred Task Context;
- the target Session must open writable in the production UI after the handoff;
- a source-only permission sentinel is asserted absent from target creation, portable lineage and the target prompt;
- portable controls must explicitly record source authority invalidation, target authorization re-evaluation and no attachment transfer.

The first full CI run exposed a real panel-state race before any mutation: a refreshed snapshot of the same target machine reloaded the Project catalog and cleared an explicit Project choice when more than one Project existed. The branch now preserves a still-valid Project selection across same-machine catalog refreshes, never carries a machine-local Project id to a different machine, and keeps the existing single-Project auto-selection behavior. A focused unit regression protects that selection rule. This UI-state fix does not change ACP adapters, Native Session writer semantics or handoff mutation ordering.

Next gate: rerun the complete PR CI and merge to `codex/development-2026-09-11` only if every gate, including the end-to-end Chromium smoke and Debug APK, is green.

## P2 roadmap position

Do not restart federation work already completed in PRs #411-#413: operational buckets plus machine/Project/harness/model/state filtering already exist in the current Native Session Home. Cross-machine creation/recovery, Project identity, lineage/portable-state boundaries and the first outcome surface were also implemented by later P2 PRs.

Continue issue #371 from the current code. Prefer small reliability/completeness slices that strengthen the existing Native Session model instead of creating a second synthetic Session index or changing ACP/writer behavior without real-harness validation.

## Product direction

Continue from `docs/HARNESS_3_ROADMAP.md`, prioritizing correctness/recovery, onboarding, attention visibility and Native Session federation. Avoid turning Harness Remote into a generic IDE/task manager or reimplementing capabilities that belong to native harnesses.