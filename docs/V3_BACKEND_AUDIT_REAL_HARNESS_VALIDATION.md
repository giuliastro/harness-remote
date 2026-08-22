# Harness Remote 3.0 backend audit: real-harness validation

This is the manual release gate for #287 / draft PR #288. Run it on the machine that has the real OpenCode, Codex, Claude, PI and OMP credentials/configuration. It is intentionally non-destructive apart from creating the hidden prompt-less ACP catalog Sessions used by model discovery.

Do not use results from mocks as a substitute for this gate.

## 1. Start the audit branch

Run the daemon from `fix/v3-backend-reliability-audit` with the same host, port, roots and credentials used by the Android app.

Keep the daemon terminal visible. Capture any `[opencode]`, `[pi]`, `[codex]`, `[claude]`, `[omp]`, `MaxListenersExceededWarning`, connection or timeout messages.

## 2. Capture a cold baseline and all model catalogs

From a second terminal:

```bash
cd bridge
export HARNESS_REMOTE_URL=http://127.0.0.1:4099
export HARNESS_REMOTE_USERNAME=harness
read -s HARNESS_REMOTE_PASSWORD
export HARNESS_REMOTE_PASSWORD
npm run audit:probe > ../backend-audit-cold.json
```

Use the actual daemon URL/port/username. The password is read silently and is never emitted by the probe. The report contains sanitized `/v1/diagnostics` plus the model catalogs for OpenCode, Codex, Claude, PI and OMP.

Expected at rest after the probe settles:

- no indefinitely growing `router.inFlightRequests`;
- ACP `pendingRequestCount` returns to `0`;
- ACP service `inFlightLoads`, `queuedSessions` and `snapshotWrites` return to `0` after settling;
- model catalogs have a stable `source`, `refreshedAt`, cache count and no unexplained `lastError`;
- no credentials or prompt bodies appear in diagnostics.

If a harness is intentionally unavailable, keep its 404/503/error in the report rather than hiding it.

## 3. PI cold-first-selection regression

1. Stop the daemon completely.
2. Restart it from the audit branch.
3. On Android, select PI **first**, without warming PI from another client.
4. Open the model picker and leave PI selected while discovery starts.
5. It may show a loading state during cold `npx`/auth startup, but it must not become permanently disabled or require switching to another harness and back.
6. When the catalog appears, record which model is marked default and every model-specific option shown.
7. Run `npm run audit:probe > ../backend-audit-after-pi.json`.

Pass criteria:

- one ACP catalog operation at a time;
- one persisted technical catalog Session for PI, reused rather than multiplied;
- `pendingRequestCount` and model-catalog `inFlight` return to zero/false;
- no second catalog process/session is created because the Android HTTP request timed out;
- PI variants are only values actually advertised through `thinkingLevel`/compatible runtime option ids.

## 4. OpenCode listener/reconnect soak

With Android connected to the machine daemon:

1. Open a Conversation using OpenCode.
2. Repeat at least 25 cycles combining: open Conversation, return to list, reopen, switch OpenCode -> PI -> OpenCode, background the app for a few seconds, foreground it again.
3. During several cycles briefly disable/re-enable Wi-Fi or otherwise cause a short local-network interruption.
4. Do not restart the daemon during this block.
5. Capture `npm run audit:probe > ../backend-audit-after-reconnect.json`.

Pass criteria:

- OpenCode `eventStreams.*.upstreamStreams` never exceeds `1` for the daemon-owned global stream;
- downstream client count may change, but does not accumulate after clients close;
- reconnect count can rise, but listener/subscriber counts plateau instead of rising once per cycle;
- at rest there are no stuck HTTP in-flight requests;
- no repeated `MaxListenersExceededWarning` growth attributable to additional Harness Remote `/global/event` subscribers.

If the warning still appears while diagnostics prove exactly one Harness Remote upstream stream, record the warning and diagnostics together: that isolates the remaining leak inside OpenCode rather than masking it by increasing listener limits.

## 5. Conversation correctness for every harness

Run this block for OpenCode, Codex, Claude, PI and OMP wherever the real harness is configured:

1. Create/open a Conversation in the real project directory.
2. Send at least 10 ordinary turns.
3. Send one long reasoning/tool turn that lasts longer than the ordinary mobile request window.
4. Verify that a red transport error does not replace a later valid native answer.
5. Trigger **Stop** during an active turn.
6. Continue the Conversation after Stop.
7. Switch to a different harness, then return to the previous harness.
8. Verify that the expected native Session is resumed where supported and that a fresh Session is explicit when resume is impossible.
9. Capture diagnostics after each harness block.

For ACP long turns, the `session/prompt` timeout is an inactivity watchdog: activity from the same Session resets it; unrelated Session traffic must not keep a stalled prompt alive.

## 6. Lost-response / duplicate-prompt regression

During a Continue operation, create a short network interruption immediately after pressing Send, then restore the network.

Pass criteria:

- the persisted Run has one `clientRequestId`;
- reconnect/retry returns that same accepted Run;
- there is one native user prompt, not two;
- if the native answer completed while transport was down, authoritative Work Thread state wins over the stale connection error.

Repeat once with two quick retry attempts after reconnect. The Run history must still contain exactly one Run for that `clientRequestId`.

## 7. Stop with a lost HTTP response

1. Start a long-running turn.
2. Press Stop and interrupt the network around the same time.
3. Restore the network.

Pass criteria:

- the backend never persists `cancelled` unless the native Session abort succeeded;
- if native abort succeeded but the HTTP response was lost, the client reconciles the terminal Work Thread instead of displaying a stale red transport error;
- if native abort did not succeed and the Run remains active, the client does not fabricate cancellation.

## 8. Daemon restart / resume

For at least OpenCode, PI and one of Codex/Claude/OMP:

1. Complete several turns.
2. Restart only the Harness Remote daemon.
3. Reopen the Conversation from Android.
4. Continue it.
5. Verify transcript/history, native Session ownership and model selection.
6. Capture diagnostics again.

Pass criteria:

- no duplicate prompt or duplicate stream;
- no hidden catalog Session leaks into user Session lists;
- active/ambiguous Runs keep their persisted identity during recovery;
- transcript cache remains bounded and authoritative journal/history sources remain authoritative.

## 9. Capability matrix to record

For each harness record the real values observed by the probe/UI:

| Harness | Catalog source | Default model | Model IDs | Runtime variant option | Variant values | Create/resume | Stop | Event mechanism | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode | `/config/providers` | | | provider `variants` | | | | HTTP + daemon SSE fan-out | |
| Codex | ACP `configOptions` | | | `reasoning_effort` only if advertised | | | | ACP stdio -> bridge events | |
| Claude | ACP `configOptions` | | | none unless runtime advertises one | | | | ACP stdio -> bridge events | |
| PI | ACP `configOptions` | | | `thinkingLevel`/runtime alias only if advertised | | | | ACP stdio -> bridge events | |
| OMP | ACP `configOptions` | | | `thinking` only if advertised | | | | ACP stdio -> bridge events | |

Do not infer an option from another harness. Absence is a valid result.

## 10. Files to attach back to #287 / #288

Return:

- `backend-audit-cold.json`
- `backend-audit-after-pi.json`
- `backend-audit-after-reconnect.json`
- any additional per-harness diagnostics snapshots
- daemon log excerpt covering the test window, especially any timeout, reconnect, process exit or `MaxListenersExceededWarning`
- the filled capability matrix above

Remove nothing from the diagnostic JSON unless it is information you independently consider private; the endpoint/probe are designed not to include credentials or prompt bodies.

The audit PR stays draft until these real-machine results are reviewed.