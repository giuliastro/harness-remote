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

- Integration head after PR #469: `03c275dbe35932991bb6869ae4c766350ca97b6f`
- PR #468 (`fix(P1): recover stopped embedded desktop daemon`) is merged into the integration branch only.
- Real Zorin validation covered stopping the embedded `daemon-cli.js` with `SIGSTOP`; automatic recovery succeeded.
- The desktop recovery path also covers child/orphan process cleanup, managed OpenCode internal-port recovery and bounded recovery retries.
- PR #469 (`feat(P2): add bounded Git summary to Session outcome`) is merged into the integration branch only after green Linux/web regressions, macOS/Windows bridge tests, Chromium product smoke and Debug APK.
- Session outcome now includes bounded Git aggregate evidence (tracked files, insertions, deletions and binary-file count) without transmitting raw diff hunks, patch/source contents or raw numstat output.

## Work in progress

### Machine creation form gating

Branch: `codex/p2-machine-manager-new-form-gating`

Goal: keep the Machines screen simple when a machine already exists or appears asynchronously.

Implemented:

- opening Machines no longer opens the new-machine fields automatically;
- the editor appears only after the explicit Add machine action;
- an empty install still opens the Machines screen, but first shows the simple empty state and Add machine action;
- first-run button copy uses “Add machine” instead of “Add another machine”;
- behavior is shared by Electron, web and Android rather than keyed to a desktop-only condition;
- regression coverage prevents restoring the old `machines.length === 0 ? "new" : null` state race.

This fixes the observed Electron startup case where the manager initially rendered before the managed local machine was discovered, leaving a stale blank creation form visible after the machine appeared.

Next gate: full PR CI, then merge to `codex/development-2026-09-11` only if green.

## Next P2 direction

Continue issue #371 from the existing Native Session Home read model instead of creating a second synthetic Session index. The next low-risk slice should make operational buckets/scopes clearer (Active, Needs attention, Failed/interrupted, Completed/recent; Project/model filtering) using already-discovered records only, with no transcript reads, ACP/writer changes or new per-Session N+1 calls.

## Product direction

Continue from `docs/HARNESS_3_ROADMAP.md`, prioritizing correctness/recovery, onboarding, attention visibility and Native Session federation. Avoid turning Harness Remote into a generic IDE/task manager or reimplementing capabilities that belong to native harnesses.
