# Copilot and MiMo validation record

The current detailed follow-up is [Full harness regression, 14 October 2026](ALL_HARNESSES_REGRESSION_2026-10-14.md). It records the exact reported sessions, six complete real UI cycles including backend restart, the PI cancellation correction, durable runtime paths, and the authorized Claude Luna test blocked by an unavailable configured gateway. Giulio clarified that he has never used Claude on this machine; a working Claude provider is not established. The report also records the UI correction that prevents a harness HTTP error from disconnecting a healthy machine. Older paths and earlier test results below describe earlier runs.

**Date:** 14 October 2026

**Status:** The six-harness UI flow record below reflects earlier checks. The separate MiMo resource follow-up passed project rotation, native cancellation, continuation, and backend restart in the application UI. Giulio manually accepted the current full-harness revision and authorized its merge on 14 October; see the detailed follow-up above for coverage and the Claude provider limitation.

The launcher prepares an isolated test environment. It does not prewarm model catalogs by default; set `HARNESS_REMOTE_PREWARM_CATALOGS=1` to opt in. It does not change login state or global CLI configuration. Copilot Auto is available through the native `/model` command even though Copilot 1.0.97 does not expose individual model rows through ACP or its SDK on this machine. Auto follows the account's entitlement; an empty SDK catalog does not indicate a missing login or establish that every request is free. MiMo advertises reasoning variants under base models and omits the retired `mimo/mimo-auto` family.

**Full test restored on 14 October:** Giulio requested all seven harnesses again after confirming that closing other browser tabs recovered the blocked machine. Both `harness-remote-all-harnesses-run-test.sh` and `harness-remote-copilot-mimo-run-test.sh` now launch this full test worktree. The separate OpenCode 2 scope-cleanup PR is not merged, and main is unchanged. This test restoration does not establish manual acceptance.

Browser fetch event streams now release their sockets while their document is hidden and reconnect on foregrounding; identical subscriptions within a tab still share their transport. Regression checks cover hidden startup, abort on backgrounding, cancellation of delayed retries, foreground recovery, and late responses after abort. Build, launcher preflight (seven required harnesses and 13 projects), 27 focused backend tests, 107 workspace tests, and the event transport tests passed for this restoration. Giulio must reload existing tabs to load the new frontend before testing multiple tabs.

The restored application UI loaded the seven-harness session list, reopened **OMP Free regression**, recovered **Free Models Router**, and displayed the real response `FULL7-RESTORED-OMP-OK`. MiMo diagnostics returned zero live project processes after discovery, with the configured process budget still three. The in-app browser exposed both of its test tabs as visible, so it did not exercise real Chrome background-tab suspension; that specific multi-tab acceptance check remains for Giulio. No new Claude prompts were sent.

The fixes also keep MiMo prompt/model/cancel operations attached to the native session's working directory, preserve Copilot replay message boundaries, and share identical browser event streams so they do not exhaust the browser's connections. The Codex regression flow exposed a separate transcript lag: sessions written by this daemon now use live ACP messages while the native journal catches up. PI also uses its ACP stream alone during a live turn; the browser preserves the same answer identity when its partial text becomes the completed journal record, preventing duplicated prefixes.

## Run the test environment

Preflight starts both services, checks machine and project metadata, then stops only its own processes:

```bash
bash /home/giulio/Software/harness-remote-copilot-mimo-run-test.sh --check
```

Start the manual environment:

```bash
bash /home/giulio/Software/harness-remote-copilot-mimo-run-test.sh
```

The equivalent full-test entry point is `bash /home/giulio/Software/harness-remote-all-harnesses-run-test.sh`. If the environment is already running, reuse it instead of launching a second copy. Reuse an existing machine entry for the printed endpoint instead of adding duplicates.

The launcher starts backend and frontend and opens the app in a browser. Keep its terminal open; press Ctrl+C to stop its processes. Set `HARNESS_REMOTE_NO_BROWSER=1` to suppress browser opening. Ports 4914 (backend) and 4915 (web) are preferred; occupied ports trigger selection of free ports, printed by the launcher. Logs and machine state use the separate test directory `~/.local/state/harness-remote/copilot-mimo-test`. The wrapper rejects a duplicate launch for the same environment, and shutdown cleans up only its own processes. It reuses the current build. A warm-build metadata-only `--check` took 1.29 seconds. The launcher uses the current worktree's web dependencies and pinned Codex, PI, and Claude adapters in `~/.local/share/harness-remote/test-runtime`. Native credentials come from the normal `HOME`.

In Harness Remote, add a machine using the values printed by the launcher:

- Name: `Harness Remote Copilot and MiMo test`
- URL: `http://127.0.0.1:<printed backend port>`
- Username: `hr-copilot`
- Password: `hr-copilot`

The `Software` root and its projects are registered for project discovery (13 projects total). The sandbox project is at `~/Software/harness-remote-copilot-mimo-sandbox`; search for `harness-remote-copilot-mimo-sandbox` in the project picker. It includes three nested Git test projects, `resource-a`, `resource-b`, and `resource-c`, used by the resource follow-up. Use **Carica sessioni precedenti** if a native session is not immediately visible. PI's completed test session is named **PI OpenRouter Free verified**.

## UI test record

These are checks performed by the agent in the application UI. “Passed” records only the listed action; it does not mean the full harness flow or Giulio's acceptance test is complete.

| Harness / approved model | Catalog and prompt | Stop and continue | Restart and reopen | Remaining |
|---|---|---|---|---|
| Copilot / Auto | Create and prompt: `COPILOT-AUTO-UI-OK` — passed | Stop passed; follow-up `COPILOT-AFTER-STOP-OK` — passed | Backend/machine restart, distinct user-message replay, and `COPILOT-FINAL-UI-VERIFIED` — passed | None |
| MiMo / `openai/gpt-6-luna` low and medium | Catalog and variant selection; response `MIMO-LUNA-LOW-OK` — passed | Stop succeeded after writer mapping fix; same-session reply `MIMO-STOP-RESUME-VERIFIED` and `MIMO-AFTER-STOP-OK` — passed | Backend/machine restart, full transcript reopen, and `MIMO-FINAL-UI-VERIFIED` — passed | Resource follow-up also passed; see below |
| Codex / `gpt-6-luna` | Visible response `CODEX-LIVE-REPLY-VERIFIED` — passed | Stop and follow-up `CODEX-AFTER-STOP-VERIFIED` — passed | Reload and reopen passed | None recorded |
| OpenCode 2 / `longcat-2.5-preview-free` | First response `OPENCODE-LONGCAT-UI-VERIFIED` — passed | Stop passed; continuation after restart `OPENCODE-RESTART-VERIFIED` — passed | Native transcript and selected LongCat model recovered — passed | The earlier continuation was interrupted by shutdown; the replacement response above was verified |
| Oh My Pi / OpenRouter Free (`openrouter/free`) | Provider `openrouter`, model ID `openrouter/free`; response `OMP-FREE-UI-VERIFIED` — passed | Stop passed; same-session `OMP-AFTER-STOP-VERIFIED` after machine restart — passed | Reload, reopen, transcript and model recovered — passed | None |
| PI / OpenRouter Free (`openrouter/free`), low | Catalog and variant selection; complete response `PI-FINAL-STREAM-VERIFIED` with no duplicated prefix — passed | Stop passed; same-session response `PI-STOP-CONTINUE-FINAL-OK` — passed | Backend restart, reload, native rename, transcript and Free Models Router recovered — passed | Qwen free returned 404; router with reasoning off returned provider 400. Both errors were visible; low succeeded |
| Claude Code | No real prompts run, as instructed; native binary currently missing (read-only error check only) | Not run | Not run | Real tests prohibited pending new authorization |
| Legacy OpenCode v1 / Windows | Not tested in this environment | Not tested | Not tested | Out of this run |

**Shared UI error handling:** an unsaved test-machine form returned HTTP 401 with a deliberately wrong password, then connected successfully with the printed credentials and detected all seven harnesses. The temporary form was cancelled without saving it.

**Automated checks:** 693 bridge tests passed (`/tmp/hr-resource-bridge-final.log`); the full web suite (`test:ci:full`), final `test:model`, and production build passed. The launcher `--check` is metadata-only: the earlier warm-build run took 1.29 seconds and the final unchanged-build run took 0.94 seconds. It registered seven harnesses and 13 projects including the sandbox resource repos. Both preferred ports were verified free after cleanup, with no remaining MiMo ACP processes. These checks do not substitute for UI flows.

## MiMo resource follow-up validation

The resource follow-up bounds MiMo work within one backend to three native processes (runtime, catalog, and cleanup) and at most two resident user-project clients, with LRU idle eviction. Temporary-session discovery runs serially; duplicate-page results are cached for 30 seconds; the catalog process closes after refresh. Cleanup waits for actual exit, trying graceful shutdown before forced termination. Observed peak memory was about 1,069 MiB for metadata plus catalog activity and about 1,440 MiB during project rotation with three processes. These are measurements from these runs, not a universal memory cap.

When the native catalog lacks the current Codex conversation model, the conversation's `gpt-6.1-sol` plus `xhigh` selection remains displayed. This was verified on the current conversation; no real prompt was sent on Sol.

The new UI rotation test exposed two integration errors: the prompt-echo decorator dropped the project-close event and session lease, leaving a stale loaded-session handle, and idle-process retirement was broadcast as a whole-harness exit. Both are fixed and covered by regression tests through the decorator. MiMo's full native replay also replaces cached partial messages, avoiding duplicated history after reopening an evicted project.

The agent opened A, loaded B, created a session in C, and returned to A in the UI. A's native PID changed, the machine stayed available, and `MIMO-BOUNDED-POOL-FINAL-OK` appeared. An active turn was stopped; the native journal recorded `MessageAbortedError`, and the same session then answered `MIMO-AFTER-REAL-CANCEL-OK`. After a complete backend restart, all checked assistant markers appeared once and the session answered `MIMO-RESTART-BOUNDED-OK`. Stopping the launcher left no MiMo ACP processes. The test conversation is **Title for MIMO project pool conversation** in **resource-a**.

After the resource fixes, the agent reopened the existing sandbox sessions in the UI and verified another real response from each other eligible harness: Copilot with Auto explicitly selected (`COPILOT-AUTO-RESOURCE-FINAL-OK`), Codex Luna (`CODEX-RESOURCE-REGRESSION-OK`), OpenCode LongCat (`OPENCODE-RESOURCE-REGRESSION-OK`), Oh My Pi Free Router (`OMP-RESOURCE-REGRESSION-OK`), and PI Free Router with low explicitly selected (`PI-RESOURCE-REGRESSION-OK`). OMP and PI each displayed the final user prompt and assistant response exactly once. These supplement the create, model, variant, stop, and restart checks recorded above. Claude received no real prompt.

For Giulio's manual check, start the launcher and select the MiMo harness. Open `resource-a`, create or resume a MiMo session, then switch to `resource-b` and `resource-c` to exercise project rotation. Each project is available in the new-session project picker; existing sessions may require **Carica sessioni precedenti**. Return to `resource-a`, prompt and verify the response, stop a prompt and continue in the same session, then reload and reopen the session and send a final prompt. Check that the project and transcript are correct at each step and that this backend owns at most three native MiMo processes.

## Giulio's acceptance checklist

Claude remains listed among the seven installed harnesses, but its successful prompt flow is not part of the six passed cycles: this machine has no verified working Claude provider. Its cached gateway model list is not evidence of access. Leave its real-prompt acceptance pending until a provider is deliberately configured; no gateway setup is required to test the other six.

Use the launcher above and the printed machine URL and credentials. In the UI, select the sandbox project, then for each applicable harness:

1. Confirm the session is for the intended harness. Open the model catalog and choose the approved model and variant: Copilot Auto; MiMo `openai/gpt-6-luna` low or medium; Codex `gpt-6-luna`; OpenCode 2 `opencode/longcat-2.5-preview-free`; or Oh My Pi and PI `openrouter/free` (Free Models Router). Use low for PI: a router destination rejected reasoning off during this run. Leave the free-only filter off for subscription models.
2. Create a session and send a simple prompt. Confirm the assistant response appears in that session.
3. Start another prompt, stop it, then send a follow-up in the same session. Confirm both actions remain on the selected harness and session.
4. Reload the app, reopen the session, and confirm the transcript and current model recover. Click **Carica sessioni precedenti** if needed. For PI, the assistant answer must appear once, without a duplicated partial prefix.
5. Check connection error handling by temporarily entering an incorrect machine password and confirming the UI shows a clear connection error. Restore the launcher credentials afterward.

Claude Code real prompts remain disabled. Legacy OpenCode v1 on Windows is outside this run. Record Giulio's acceptance separately from the agent-run UI results above.
