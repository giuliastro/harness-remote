# Full harness regression, 14 October 2026

Status: six harnesses passed real UI prompt, cancellation, continuation, and backend-restart checks. Giulio authorized Claude's **Codex API/gpt-6-luna** on 14 October, then clarified that he has never used Claude on this machine and does not know of a gateway to start. Its real UI test reached an unavailable configured gateway; no working Claude provider is established here. Claude's successful prompt cycle remains unverified. This is not a claim that all seven real-prompt flows passed. Main and PR #555 have not been merged or updated by this test run.

## Manual acceptance and merge scope

On 14 October, after testing the running full-harness environment, Giulio reported that it appeared to work and explicitly authorized merging this revision into main. This accepts the stabilization work below, including Copilot and MiMo, and supersedes the alternative scope-removal candidate in PR #555. Claude's unavailable provider remains an explicit limitation. This general manual acceptance does not establish a separate Chrome hidden-tab test or successful Claude prompt cycle.

## Failures reproduced and corrected

- The running Codex process referenced an adapter installation that no longer existed under `~/.cache`. New catalog processes failed with executable `ENOENT`. Test adapters now install under `~/.local/share/harness-remote/test-runtime`; daemon state/logs live under `~/.local/state/harness-remote/copilot-mimo-test`.
- MiMo **Untitled** belonged to the missing scratch directory `~/.cache/harness-remote/copilot-mimo-test/sandbox`. The native executable itself was present. Restoring that exact test directory recovered the history. ACP startup now reports a missing project directory explicitly instead of blaming the executable. The launcher prepares this old test scratch path; new tests use the durable sandbox under Software.
- Deferred model fallback suppressed the sole verified `copilot/auto` default in existing sessions. A narrow fallback now recognizes only a Copilot catalog containing that exact single default row; other harnesses and ambiguous catalogs keep their metadata rules.
- Catalog waits reused the historical turn's start time. Model bootstrap no longer shows an elapsed clock from an old turn; catalog errors have an explicit unavailable state.
- Real PI cancellation exposed a native assistant journal entry with `stopReason: "aborted"`, empty content, and `errorMessage: "Request aborted"`. The history adapter no longer turns that cancellation into `TURN FAILED`. Partial canceled text remains visible; genuine provider errors remain errors.
- The first authorized Claude send returned `Internal error: Network error. Please check your internet connection.` from the reachable daemon. A message-text classifier incorrectly treated this harness error as a machine disconnection. Browser, native HTTP, and Electron clients now retain HTTP error identity; session panels distinguish those responses from failed machine transport. The repeated UI attempt kept **Ready**, the selected Luna model, an enabled Send button, and the restored prompt, with no reconnect banner. Browser and Electron behavioral tests retain recovery for genuinely failed transport.

## Exact sessions originally reported

| Session | Agent-run UI result |
|---|---|
| MiMo **Untitled**, old cache sandbox | History opens; OpenAI/GPT-6 Luna is shown; no executable ENOENT |
| Codex **Add official OpenCode 2 integration** | History opens, live catalog loads, current model is shown as `gpt-6.1-sol · xhigh`; no prompt sent into Giulio's development conversation |
| Copilot **Reply exactly COPILOT-AUTO-UI-OK. Do not use tools or modify files.** | History opens and model selector shows **Auto**, rather than Harness default |
| Claude | Pinned local adapter with optional native binary loads a 16-row catalog; new native session creation succeeds |

## Real UI regression sessions

All prompts instructed the harness not to use tools or modify files. All six sessions were created through the application UI, their approved model was selected or verified, a first reply appeared, a running turn was canceled, and a follow-up reply appeared. The test backend was then stopped, its owned processes exited, and the app was reloaded against the restarted backend. Each session was found in the UI, its history/model recovered, and a third real reply appeared.

| Harness | Model | Native session ID | Verified assistant replies |
|---|---|---|---|
| Codex | `gpt-6-luna`, low | `01a13b58-4ac1-7361-85b1-2bae6ee1b8a5` | `ALL7-CODEX-FIRST-OK`, `ALL7-CODEX-AFTER-STOP-OK`, `ALL7-CODEX-RESTART-OK` |
| Copilot | `copilot/auto` | `d676c498-dedc-4f35-ab92-b879e2034282` | `ALL7-COPILOT-FIRST-OK`, `ALL7-COPILOT-AFTER-STOP-OK`, `ALL7-COPILOT-RESTART-OK` |
| MiMo | `openai/gpt-6-luna`, low selected before the first prompt | `ses_ffe5ec4a4a1c8ffeGk1bOOFkJJ` | `ALL7-MIMO-FIRST-OK`, `ALL7-MIMO-AFTER-STOP-OK`, `ALL7-MIMO-RESTART-OK` |
| OpenCode 2 | `opencode/longcat-2.5-preview-free` | `ses_ec4a34cf4ffeSv6ciScwV7KAz0` | `ALL7-OPENCODE2-FIRST-OK`, `ALL7-OPENCODE2-AFTER-STOP-OK`, `ALL7-OPENCODE2-RESTART-OK` |
| OMP | `openrouter/free`, low selected before the first prompt | `01a13b5f-0476-7140-8a8b-cbab2b48260f` | `ALL7-OMP-FIRST-OK`, `ALL7-OMP-AFTER-STOP-OK`, `ALL7-OMP-RESTART-OK` |
| PI | `openrouter/free`, low | `01a13b60-715f-7813-bf85-af6162a9bfbc` | `ALL7-PI-FIRST-OK`, `ALL7-PI-AFTER-STOP-OK`, `ALL7-PI-RESTART-OK` |
| Claude | Authorized `Codex API/gpt-6-luna`, explicitly selected in UI | `c3b2f0cf-773a-45c2-82c1-3055edb59196`, **ALL7-20261014-Claude** | Two UI sends failed before acceptance while switching model; no assistant reply, stop, or continuation claimed |

Native titles can change after generation. The UI restart checks used the native titles **Exact reply instruction** (Codex), **Summarize Conversation Data Safely** (MiMo), **Verification check** (OpenCode 2), **ALL7-20261014-OMP**, and the first prompt text for Copilot and PI.

Codex and PI returned the selected low variant in native message-page metadata after restart. OMP's inspected native journal contains the provider/model but no saved variant; MiMo's recovered model metadata likewise did not include a variant. These checks establish recovery of their model, not persisted recovery of the initial low setting. No variant was invented from the catalog.

PI's stop was repeated after the cancellation classification fix and backend restart. No `Request aborted` failure was rendered, and the follow-up restart marker appeared. The initial PI reply was also checked to appear once, without a duplicated partial prefix.

## MiMo process rotation and UI error handling

- Created UI sessions in `resource-a` and `resource-b`, both using Luna, and verified `ALL7-MIMO-RESOURCE-A-OK` and `ALL7-MIMO-RESOURCE-B-OK`.
- Confirmed `resource-a` was evicted, reopened it through the UI with a new native PID, recovered its prior reply, and verified `ALL7-MIMO-RESOURCE-A-RETURN-OK` in the same session.
- A 90-second OS sample collected 225 observations and saw at most three native MiMo processes. Runtime diagnostics retained at most two resident project clients; the configured total process budget remained three with no queued slot wait at completion.
- An unsaved machine form returned **HTTP 401** for a wrong password. Correcting the password returned **7 coding agent trovati**. The form was canceled, leaving the saved machine unchanged.

Background browser SSE suspension has automated lifecycle coverage. The in-app browser reports its independently controlled test pages as visible, so this run does not claim a real Chrome background-tab acceptance check.

## Claude gateway dependency

The native Claude settings point to `http://127.0.0.1:3456` and an API-key helper under `~/.claude-code-router/bin`. At the authorized test time, port 3456 had no listener and `~/.claude-code-router` was absent. The SDK could still return the 16 cached model rows, including the selected gateway Luna entry. Giulio clarified that he has never used Claude on this machine and does not know of a gateway to start. The origin of these settings is not established. Do not treat the cached catalog or the installed CLI as proof of a working provider, or ask Giulio to restore a service he has never used. No gateway was installed, no alternate model was substituted, and native Claude configuration and login were left unchanged. A working provider must be configured before Claude's successful response, cancellation, continuation, and restart checks can be completed. Its unavailable-provider error and recovery UI were exercised as described above.

## Automated checks and entry point

- Full bridge suite: **695 passed, zero failed**, `/tmp/hr-all7-final-bridge.log`.
- Full web suite: `npm --prefix web run test:ci:full` passed after the HTTP error correction, `/tmp/hr-all7-http-web.log`.
- Production frontend build passed after the HTTP error correction, `/tmp/hr-all7-http-build.log`.
- Launcher preflight passed with all seven required harnesses and 13 projects; shutdown released its ports.

```bash
bash /home/giulio/Software/harness-remote-all-harnesses-run-test.sh
```

Web `http://127.0.0.1:4915/`; machine `http://127.0.0.1:4914`; username/password `hr-copilot` / `hr-copilot`. The full test environment remains available; Giulio's manual acceptance and merge authorization are recorded above.
