# OpenCode 2 integration — issue #552

Official distribution verified on 13 October 2026: the vendor's update endpoint
and npm publish `@opencode/cli` 2.0.28, with both `opencode` and `opencode2` binary
names. V1 remains separately published as `opencode-ai` 1.19.0. See
[v2 installation](https://opencode.ai/v2/docs/) and the
[shared-command warning](https://opencode.ai/docs/).

This integration includes the ACP Provider Kit / OpenCode 2 prototype from
#533–#537. The legacy HTTP backend remains `opencode`; its display name
is **OpenCode Legacy**. V2 remains `opencode2` and uses native ACP. Saved profiles,
Session ids and storage keys are not migrated between generations.

## One-command local test

The in-repo launcher was retired after #552 closed. Recover it from history if needed:

```bash
git show fb56553:bridge/scripts/opencode2-run-test.sh > opencode2-run-test.sh
```

Giulio's prepared local command is:

```bash
bash /home/giulio/Software/harness-remote-opencode2-run-test.sh
```

The script prepares the pinned v2 runtime and web dependencies/build, chooses free
loopback ports, starts backend and frontend, and opens the browser. Its isolated
machine exposes OpenCode 2 only. Both owned process groups stop with Ctrl+C.
`--check` verifies startup and shuts both servers down automatically.

Copy the **Machine URL** printed by the script into Machines → Add machine:

- Name: `OpenCode 2 test`
- Host: `127.0.0.1`
- Port: the printed machine port
- Username: `issue552`
- Password: `issue552`

The sandbox is `$HOME/.cache/harness-remote/issue552-test/sandbox` by default.
OpenCode's native sessions/cache and the daemon state live under the separate test
directory. Existing provider configuration is inherited; the script does not
overwrite credentials or a global CLI. `HARNESS_REMOTE_OPENCODE2_TEST_DIR` and
`HARNESS_REMOTE_OPENCODE2_RUNTIME_DIR` override those preparation directories.

## UI checklist

1. Test connection and save the machine. Expect one **OpenCode 2** ACP agent.
2. Open Sessions and expand the sandbox. Create a new session and choose
   **LongCat 2.5 Preview Free** (`opencode/longcat-2.5-preview-free`). If absent,
   stop model testing and ask Giulio for an alternative.
3. Inspect the advertised model and effort menus. Select an advertised effort,
   then send `Reply with exactly OPENCODE2-UI-552`. Expect the visible assistant
   response and an idle Session after completion.

   LongCat currently advertises no selectable effort variants. Its model row
   should therefore have no variant controls; other models may advertise them.
4. Ask for a long response, press Stop, and send a second prompt in the same
   Session. Expect Stop to settle and continuation to succeed.
5. Switch away, reopen, and reload the browser. Expect the same native Session,
   transcript and selected model, with no duplicate messages.
6. Try incorrect machine credentials. Expect a connection error without saving
   or silently routing to another agent. Restore the correct credentials.

## Regression checklist

- Keep OpenCode v1 installed on the Windows machine. Start this branch's gateway
  there and verify **OpenCode Legacy**, native Session discovery/resume, LongCat
  free model selection, prompt/streaming, Stop/continue and reconnect. Existing
  saved v1 profiles must still work. Do not update that CLI to v2.
- Repeat discovery, model/variant selection, creation, prompt, Stop/continue and
  reload for Codex (`gpt-6-luna`), OMP (`openrouter/free`) and PI
  (`qwen/qwen3.8-27b:free`) on their configured machines.
- Claude Code real tests remain disabled until Giulio explicitly reauthorizes
  them. If an approved model is unavailable, request an alternative; never
  substitute another model automatically.

## Validation status

- Automated checks run by the agent after integration with main: 656 bridge tests passed; the full frontend
  `test:ci:full` suite, TypeScript/Vite and Electron builds passed. Desktop transport
  checks include v2 profile retention, HTTP agent routing and SSE routing.
- Real ACP 2.0.28 handshake and session creation passed in isolated native data.
  The catalog includes the approved LongCat model and the advertised `effort`
  options. This is protocol evidence, not UI acceptance.
- Agent-operated UI checks passed on v2.0.28 with LongCat free: connect, create,
  model catalog/selection, assistant response, Stop/continue, browser reload,
  backend restart, native transcript replay, model recovery and continuation
  after reopen. Incorrect credentials show HTTP 401. The sandbox already contains
  a test Session titled `OPENCODE2-UI-552` or `OpenCode 2 UI #552` (native automatic
  titling can change the label).
- UI testing found and fixed lost model metadata and duplicate partial responses
  after native replay. V2's complete replay now owns transcript content; unchanged
  cached occurrences retain their known identity and timestamps.
- Giulio confirmed the all-harness manual test environment works on 13 October
  2026 and approved merging this integration. The environment uses the installed
  OpenCode 2.0.11 and existing native sessions under `Software`.
- A separate Windows OpenCode Legacy regression has not been recorded, and Claude
  Code real prompt tests remain disabled. These are distinct from Giulio's local
  acceptance. Isolated agent-operated tests use v2.0.28 without replacing the
  installed CLI or desktop application.
