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

- Integration head after PR #470: `b39c803375514ad3f31680a9c856a041ecc95ff6`.
- PR #468 added bounded recovery of the embedded desktop daemon and was validated on Zorin with a real `SIGSTOP` recovery test.
- PR #469 added bounded Git aggregate outcome evidence: tracked files, insertions, deletions and binary files, with no raw diff/hunks/source sent to the client.
- PR #470 fixed the universal Machines UX race: connection fields now appear only after an explicit **Add machine** action, including when Electron discovers its managed local machine asynchronously.
- #469 and #470 both passed the complete PR gate before integration: Linux/web regressions, macOS/Windows bridge tests, Chromium product smoke and Debug APK.

## Work in progress

### P2 cross-machine browser gate

Branch: `codex/p2-cross-machine-browser-gate`

Goal: make the existing cross-machine continuation safety smoke a permanent blocking regression instead of an unexecuted standalone script.

Implemented:

- `cross-machine-continuation-browser-smoke.mjs` is wired into the blocking Chromium product gate;
- the smoke exercises the existing cross-machine planning surface, target model discovery, Project identity continuity and fail-closed behavior for a mismatched repository;
- `native-session-reliability-ci-contract.test.js` now requires that smoke to remain present in the blocking workflow;
- no ACP adapter, Native Session writer semantics or harness runtime behavior is changed.

Next gate: full PR CI, then merge to `codex/development-2026-09-11` only if green.

## P2 roadmap position

Do not restart federation work already completed in PRs #411-#413: operational buckets plus machine/Project/harness/model/state filtering already exist in the current Native Session Home. Cross-machine creation/recovery, Project identity, lineage/portable-state boundaries and the first outcome surface were also implemented by later P2 PRs.

Continue issue #371 from the current code. Prefer small reliability/completeness slices that strengthen the existing Native Session model instead of creating a second synthetic Session index or changing ACP/writer behavior without real-harness validation.

## Product direction

Continue from `docs/HARNESS_3_ROADMAP.md`, prioritizing correctness/recovery, onboarding, attention visibility and Native Session federation. Avoid turning Harness Remote into a generic IDE/task manager or reimplementing capabilities that belong to native harnesses.
