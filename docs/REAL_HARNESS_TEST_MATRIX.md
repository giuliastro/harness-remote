# Real Harness Test Matrix

This is the release gate for the Harness 3 / TaskDesk restart. It closes the gap that caused the
archive: unit tests and an APK build were green while real agents and the mobile task flow were not.

The matrix has two different kinds of evidence:

1. **GitHub-hosted CI** proves deterministic regressions, web build and the installable debug APK.
2. **The Android Debian self-hosted runner** proves the actual installed PI, OMP and OpenCode
   harnesses, their credentials, adapter startup, model discovery, session creation, prompt/tool
   execution and the TaskDesk proxy.

Neither replaces the other. A hosted job cannot use the local OAuth credentials on the phone, and a
real device run does not replace normal regression tests.

## Release matrix

| ID | Path under test | Automated evidence | Android client acceptance | Required before a Harness 3 slice can merge to `main` |
| --- | --- | --- | --- | --- |
| CI-01 | bridge, web and Android package | `PR checks` is green and its debug APK installs | Open the exact artifact used for the test | Yes |
| LEGACY-PI | single PI bridge | `npm test` plus direct real-agent smoke where PI is installed | Existing session, model picker, new session, prompt, tool change, reopen | Yes |
| LEGACY-OMP | single OMP bridge | `npm test` plus direct real-agent smoke where OMP is installed | Existing session, model picker, new session, prompt, tool change, reopen | Yes |
| LEGACY-OC | direct OpenCode | OpenCode health/session API smoke | Existing session, model picker, new session, prompt, tool change, reopen | Yes |
| DAEMON-PI-OC | TaskDesk daemon, PI primary + managed OpenCode | Add the `real-harness-pi` label to this PR | Switch PI/OpenCode over one daemon URL; create a task and verify model list appears immediately | Yes for daemon work |
| DAEMON-OMP-OC | TaskDesk daemon, OMP primary + managed OpenCode | Add the `real-harness-omp` label to this PR | Switch OMP/OpenCode over one daemon URL; create a task and verify model list appears immediately | Yes for daemon work |
| TASK-LIFECYCLE | task/project/worktree/launch/finish APIs and UI | route/store/worktree tests; real daemon run above | Create a task, observe it in the list immediately, enter it, select a model, start it, reopen it, inspect result | Yes for task-first UI work |

**A green workflow alone is not a release verdict.** The matching Android client row must be marked
pass against the same commit and harness versions. A timeout, empty model list, delayed task
visibility, a missing streamed reply, or a tool that claims success without the expected file is a
failure, not a warning.

## One-command branches under test

Always test the candidate branch explicitly; never let `npx` silently use `main`.

```bash
# PI legacy path
npx --yes --package=github:giuliastro/harness-remote#test/real-harness-matrix \
  harness-remote --single --backend pi --host 0.0.0.0 --port 4097 \
  --username harness --password 'CHANGE_ME' --root "$HOME/harness-fixture"

# OMP legacy path
npx --yes --package=github:giuliastro/harness-remote#test/real-harness-matrix \
  harness-remote --single --backend omp --host 0.0.0.0 --port 4097 \
  --username harness --password 'CHANGE_ME' --root "$HOME/harness-fixture"

# OpenCode direct path
npx --yes --package=github:giuliastro/harness-remote#test/real-harness-matrix \
  harness-remote --backend opencode --host 0.0.0.0 --port 4097 \
  --username harness --password 'CHANGE_ME'
```

For the daemon rows, invoke the same command without `--single` while both the selected ACP
harness and `opencode` are present on `PATH`. The current archive intentionally supports **one**
ACP primary plus managed OpenCode; PI and OMP are separate daemon runs, not a claim that both ACP
servers are live together.

## Android Debian runner

Install the official GitHub Actions self-hosted runner *inside Debian*, not in the Termux host.
From the repository's **Settings → Actions → Runners → New self-hosted runner**, select Linux/ARM64
and run the generated download/configuration commands in the Debian shell. Add this custom label
when configuring it:

```bash
./config.sh --url https://github.com/giuliastro/harness-remote --token <one-time-token> \
  --labels harness-remote-android
./run.sh
```

The runner must have Node 20+, Git, `opencode`, `pi`, `omp`, and the already-authenticated
credentials required by the selected harness. Keep it running in a persistent Debian terminal or
tmux session only while invoking the workflow; it is not a public service and should not be exposed
outside the local device.

After this workflow has first been merged into its target base branch, an **Idle** runner can be invoked by adding `real-harness-pi` to a subsequent same-repository PR. That starts the PI + OpenCode workflow on the PR's exact commit. To run OMP afterwards, remove `real-harness-pi` and add `real-harness-omp`. The labels must be created once from **Issues → Labels** (or the PR label menu) before their first use. GitHub cannot label-trigger a workflow that exists only in the candidate PR. Each run:

- creates a disposable Git fixture under the runner temp directory;
- starts TaskDesk with the selected ACP primary and managed OpenCode;
- verifies authenticated health, session creation and non-empty model discovery for both agents;
- sends a real prompt that must create one uniquely named file and return a unique completion token;
- uploads the daemon log and two JSON reports as a 30-day artifact.

The workflow intentionally does not use production repositories and does not print harness
credentials. It remains manual because it spends real model quota and requires the Android device to
be awake with its local installations available.

## Android app acceptance script

Use the debug APK attached to the same PR/commit, then for each applicable row:

1. Add the exact daemon or legacy URL and test its connection.
2. Open an existing session and confirm its history is readable.
3. Create a new session/task; its card must appear immediately, without leaving and returning.
4. Open it, wait no more than 15 seconds for the model picker, choose a model and start a tiny
   file-creation prompt.
5. Confirm streamed progress, the changed file, completion state and session history after reopening.
6. For daemon rows, repeat after switching from the ACP primary to managed OpenCode on the *same*
   daemon profile. For task rows, complete the worktree/release result instead of deleting it.

Record the commit SHA, Android app version, Debian/Node version, harness/adapter version, selected
model, workflow artifact URL and result for every row in the PR description or a linked issue. Do
not use a generic “works for me” comment as evidence.

## Failure triage

| Symptom | Owner / first inspection |
| --- | --- |
| Adapter never becomes healthy | `harness-profiles.js`, executable discovery, stored credential method, daemon log |
| Empty or delayed model list | ACP `configOptions` handling, `/config/providers`, session creation timing |
| New task not visible immediately | task store mutation/reconciliation and client cache/invalidation |
| OpenCode works directly but not through daemon | agent router prefix, managed-host readiness and proxy auth |
| Agent reports success but fixture file is absent | permission handling and ACP tool-call completion |
| Android flow fails while smoke is green | client API routing/state lifecycle; keep legacy profile compatibility intact |

A defect found by this matrix is fixed with a regression test where possible and is rerun on the
same Android fixture before the relevant slice is considered mergeable.
