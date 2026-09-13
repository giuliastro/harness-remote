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

- Integration head after PR #468: `13aae765760b8f9deffbf61525144b7b7988246f`
- PR #468 (`fix(P1): recover stopped embedded desktop daemon`) is merged into the integration branch only.
- Real Zorin validation covered stopping the embedded `daemon-cli.js` with `SIGSTOP`; automatic recovery succeeded.
- The desktop recovery path also covers child/orphan process cleanup, managed OpenCode internal-port recovery and bounded recovery retries.

## Work in progress

### P2 Session/Project outcome Git summary

Branch: `codex/p2-session-outcome-diff-summary`

Goal: make the Session outcome answer “what changed?” without transmitting source diff contents.

Implemented:

- aggregate tracked-file count;
- insertions and deletions;
- binary-file count;
- daemon-side `git diff --numstat -z --no-renames HEAD --` parsing;
- no diff hunks, patch/source contents or raw numstat output cross the daemon boundary;
- client-side validation of aggregate numeric fields;
- compact Session outcome presentation next to existing branch/worktree/file evidence;
- compatibility with older daemons where the optional summary is absent.

The branch was synchronized with integration after #468 using merge commit `baf9a6ca40f0d3f8abfb8c42e0fd2ec0a5407e49` before the UI/client completion commits.

Next gate: focused tests, full PR CI, then merge to `codex/development-2026-09-11` only if green.

### Next UX fix: Machine creation form

After the P2 outcome PR is integrated, fix the universal machine-management flow on a separate branch:

- if there are active/configured machines, do not leave the “new machine” fields expanded by default;
- show a simple Add machine action instead;
- reveal the fields only after the user chooses to add another machine;
- when no machines exist, keep first-run setup immediately understandable;
- behavior must be shared by Electron/web rather than special-cased for one platform.

## Product direction

Continue from `docs/HARNESS_3_ROADMAP.md`, prioritizing correctness/recovery, onboarding, attention visibility and Native Session federation. Avoid turning Harness Remote into a generic IDE/task manager or reimplementing capabilities that belong to native harnesses.
