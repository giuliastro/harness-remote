# Development status

> Handoff point for ongoing work that is not yet on `main`. Keep this current, concise and safe to read at the start of a new coding-agent session.

## Branch policy

- Persistent integration branch: `codex/development-2026-09-11`.
- Never merge development work directly into `main`.
- Internal feature/fix PRs target `codex/development-2026-09-11` only.
- Merge into integration only after relevant CI is completely green and the repository owner explicitly authorizes the merge after real validation.
- ACP, Native Sessions, routing, models and harness-runtime changes require regression review against previously fixed failures.
- Prefer executable behavioral coverage over source-text guards.
- Do not ask the repository owner for another manual runtime test until all applicable automated gates on the candidate are green.

## Current integration baseline

- Integration head: `f72f3e5a54678022654f3317a38839a30a1ba575`.
- This is the merge commit for PR #517, `fix(opencode): stabilize retry, error and remount lifecycle`.
- `web/package.json` is `3.1.0`.
- `main` remains on Harness Remote 3.0.2 at `21ce6db49af708c4c7c3f96ef6a50f62dced8dab` and must remain untouched until the final release gate is cleared.

The integration line is in **Harness Remote 3.1.0 release-candidate validation**. Do not start opportunistic feature work while release evidence remains incomplete.

## RC history

### RC1 — failed desktop startup validation

Frozen branch: `codex/release-candidate-3.1.0` at `a5695af0c874deeb2934f8308bc78f2196b5be1c`.

Real desktop testing exposed an indefinite `Connecting to your machines…` state when the embedded local runtime was healthy but another saved machine endpoint was slow/unreachable. PR #516 fixed the cause by preserving referential identity for semantically unchanged desktop runtime state so repeated local-runtime polling no longer restarts slower machine discovery. Keep RC1 frozen as failed evidence.

### RC2 — failed real OpenCode validation

Frozen branch: `codex/release-candidate-3.1.0-rc2` at `8976507c5ce4d511719db9d0fc8424430f5c710f`.

Real OpenCode testing exposed retry/error/remount and lifecycle-ownership failures. PR #517 first reached automated green at `9a09b50afb504834df8743418f5ce99ff12e896f`, but real Zorin/OpenCode validation then found two blockers the previous campaign had missed:

1. a turn could reach `Ready` while Harness Remote showed reasoning/activity instead of the normal final assistant answer;
2. a second Send in the same Session could then stall without producing a response.

Treat RC2 and `9a09b50` as failed real-validation evidence; never reuse or rewrite those branches/commits as a later candidate.

### RC3 — current frozen candidate

Frozen branch: `codex/release-candidate-3.1.0-rc3` at `f72f3e5a54678022654f3317a38839a30a1ba575`.

RC3 was frozen only after all of the following completed:

- PR #517 exact feature head `bc50c65e18169d9adbf9f0e4d0e9b82b8a58cafd` passed PR checks #2101 / Actions `35195461321`;
- type-check/build, full web regressions and OpenCode permission transport passed;
- bridge tests passed on macOS and Windows;
- Chromium product smoke passed the complete OpenCode reliability matrix, cross-machine continuation and complete-controls/screenshot coverage;
- Debug APK passed Android 36 setup, Capacitor sync, APK build, signature verification and artifact upload;
- Desktop runtime/menu #1242 / Actions `35195461347` passed on Ubuntu, macOS and Windows, including packaged embedded-daemon execution where applicable;
- OpenCode live Zen gate #35 / Actions `35195461297` passed against pinned real OpenCode + Zen using an existing native Session, multiple continuations, durable-final enforcement, reload/remount, model recovery and full daemon/managed-runtime restart;
- repository-owner real Zorin/OpenCode validation then passed, including the failures previously observed on `9a09b50` and multi-turn/multi-Session behavior;
- PR #517 was merged only into `codex/development-2026-09-11`.

The earlier isolated cross-machine assertion failure on runtime head `2270c26` did not reproduce: the same-SHA rerun passed and the fresh exact-head Chromium campaign passed the unchanged assertion. No speculative runtime change was introduced for that one-off failure.

## OpenCode stabilization contract now integrated

The 3.1 integration line now includes the OpenCode reliability work from #517:

- real `session.status` retry message/attempt/next metadata is preserved;
- terminal `session.error` can survive short navigation/persistence gaps, while later real busy/retry or durable successful output retracts stale error presentation;
- selected-detail and ambiguous machine-level streams do not own shared OpenCode Session lifecycle state;
- lifecycle identity is isolated by routed `agentId`;
- exactly one routed lifecycle owner exists per eligible OpenCode agent;
- permission/question ACK retains ACP behavior and adds only the bounded OpenCode trailing reconciliation needed for the native-ACK-before-durable-final race;
- `finish: "stop"` on reasoning-only output is not final-answer proof;
- after Send, OpenCode remains pending until durable terminal assistant text/error or bounded no-final recovery settles the turn;
- stable native idle without a durable final becomes an explicit failure instead of false `Ready` or a wedged second Send;
- background completion, remount, second Send, permission settlement and repeated multi-turn convergence are covered by executable browser regressions;
- managed POSIX OpenCode teardown prevents overlapping managed runtimes during restart;
- slow/unavailable sibling harness discovery is bounded and cannot indefinitely contaminate OpenCode rail state;
- ACP backends retain their established adapter/transcript semantics.

Read `docs/OPENCODE_RELIABILITY_CONTRACT.md` before changing this path. Preserve behavior established by #304/#306/#337/#351/#355/#391/#421/#422/#425/#451/#452/#453/#513/#517.

## RC3 remaining release evidence

RC3 is a **frozen candidate**, not a final release. Do not create the final `v3.1.0` release/tag or merge the 3.1 line to `main` until the true-boundary release checks are complete.

Remaining evidence:

- run the strict real-harness release gate against installed OpenCode, Codex, Claude, OMP and PI builds using `docs/REAL_HARNESS_RELEASE_GATE.md`; unavailable inference/model combinations must be recorded explicitly rather than substituted;
- verify real daemon/adapter restart plus persisted-Session resume/claim on the frozen RC3 build;
- verify physical Android foreground/background behavior and a real network interruption/reconnect boundary;
- preserve the resulting release evidence/report for the RC3 commit;
- repository-admin enforcement on `main` should require pull requests and required checks. The connected GitHub App cannot perform that administration write.

A green GitHub Actions campaign is necessary but does not by itself fill the final “Verified on this real build” column of the real-harness release record.

## Release mechanism

The intended next release is **Harness Remote 3.1.0**, not 3.0.3.

The existing release mechanism remains unchanged: the eventual release commit on `main` carries the `3.1.0` metadata and the repository release workflow creates `v3.1.0`. Do not create a final release tag from RC3 and do not move the frozen RC1/RC2/RC3 branches.

## Stable `main` line

- `main`: `21ce6db49af708c4c7c3f96ef6a50f62dced8dab` (Harness Remote 3.0.2).
- Stable-line PR #512 remains outside the 3.1 stabilization path; do not merge it into `main` without explicit authorization.
- RC1/RC2/RC3 work belongs to the 3.1 line; do not backport it opportunistically.

## Roadmap boundaries

### P0 — issue #368

Keep open for the remaining true-boundary release evidence and repository-admin enforcement. Do not substitute synthetic tests for physical/runtime boundary checks.

### P1 — issue #369

Repo-side pairing, Attention semantics, desktop-owned local runtime, packaged-runtime execution, PATH recovery, health/reconnect recovery and Machines simplification are implemented. Release readiness now depends on the RC3 true-boundary evidence above.

### P2 — issue #371

Do not redo already-integrated federation/cross-machine continuity:

- #411-#413: federated Native Session read model and operational scopes;
- durable Project/native identity, lineage, portable handoff and crash/retry-safe target creation/first prompt;
- #435/#436: recovered portable state and source-authority invalidation;
- #437-#439/#469: bounded Project/outcome evidence and Git aggregates;
- #471/#472: blocking Chromium planning and full cross-machine execution coverage.

Do not infer `checks run/failed` from transcript/tool prose; there is still no provider-neutral structured source.

## Product direction

Continue from `docs/HARNESS_3_ROADMAP.md`, prioritizing correctness/recovery, onboarding, attention visibility and Native Session federation. Avoid turning Harness Remote into a generic IDE/task manager or reimplementing capabilities that belong to native harnesses.
