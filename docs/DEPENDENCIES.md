# External dependencies and the assumptions behind them

This app is a client for other people's software. Almost everything that has broken it broke
because a harness behaved differently from what the code assumed — not because of a logic error.
This file records what we depend on, what we assume from it, and what to check when it changes.

Keep it current. An assumption that is not written down is one nobody will re-check.

## Harness surfaces

### OpenCode — HTTP API

Spoken directly, no adapter. The app calls `/global/health`, `/global/event`, `/session*`,
`/config/providers`, `/command`, `/agent`, `/project/current`, `/vcs`, `/file*` and `/question*`.

**Assumed:** the server emits an SSE heartbeat roughly every 10s. The client aborts and reconnects
after 30s of silence, so a server that stops beating looks dead.

**Watch:** new or renamed endpoints, and the event envelope shape (`{directory, payload}`).

### Oh My Pi (OMP) — ACP over stdio, via `omp acp`

First-party command, no third party in the path. The bridge uses `session/new`, `session/load`,
`session/list`, `session/prompt`, `session/cancel` and `session/set_config_option`.

**Assumed, all observed on OMP 17.1.3 rather than read from a spec:**

| Assumption | What breaks if it changes |
|---|---|
| `session/list` returns no `title` | titles are derived from the first prompt; a real title would be ignored |
| A submitted prompt is never echoed back as `user_message_chunk` | the deduplication acknowledgement would swallow the user's message |
| Chunks carry a `messageId` | without one, chunk aggregation falls back to per-turn tracking |
| No `agent_plan` is emitted | the todo panel stays empty by design |
| The agent approves its own tool calls and never sends `session/request_permission` | the permission path would start being exercised |
| `available_commands_update` is emitted after extension initialization and contains registered command names | optional extension actions are not discovered |

**Also assumed, observed on OMP 17.2.10 while adding image attachments:**

| Assumption | What breaks if it changes |
|---|---|
| `initialize` advertises `agentCapabilities.promptCapabilities.image` | the composer hides its attachment picker and the bridge refuses attachments; a harness that dropped the flag would lose the feature rather than fail a prompt |
| A prompt may carry `{type:"image", mimeType, data}` blocks alongside text, and an image with no text is accepted | sending a bare screenshot would need a synthetic caption |
| No `audio` prompt capability is advertised | voice would have to be transcribed before it reaches a prompt |
| `session/load` replays a stored image as `user_message_chunk` with `content: {type:"image", data, mimeType}`, sharing the `messageId` of the text chunk in that turn | the thumbnail stops reappearing when a session is reopened, or lands in a message of its own |
| Images are re-encoded on the way in: a PNG upload replays and persists as `image/webp` | a mime taken from the upload rather than from the record would mislabel the part |
| The persisted transcript stores no filename for an image | the app labels a replayed thumbnail generically instead of by name |
| `session/load` mints a fresh `messageId` on every load | ids cannot be used to recognise the same message across two loads, which is why history dedup elsewhere falls back to text and timestamps |

**Watch:** any of the above and new `sessionUpdate` kinds; unknown updates are ignored by design.

#### Optional OMP extension actions

The bridge recognizes [`@baylarsadigov/omp-undo-redo`](https://www.npmjs.com/package/@baylarsadigov/omp-undo-redo)
only when the active `omp acp` session advertises both `undo` and `redo`. The package remains a
host-side OMP plugin; it is not an app or bridge dependency. Its command catalog proves that the
handlers were registered in that runtime.

Live action availability comes from extension version 1.1.0 or newer under
`~/.omp/omp-undo-redo/runtime/<acp-pid>/`. Version 1.2.0 adds non-Git file restoration without
changing this runtime contract. The bridge validates the runtime marker against the exact ACP child
PID, then reads schema-2 session state containing `actions`, `sessionRevision`, `activeSessionLeaf`,
and an invocation `actionResult` with a unique `token`. Process and runtime IDs prevent stale or
concurrent OMP state from controlling the session. This contract works for both Git and non-Git
workspaces.

File restoration remains extension-owned. Harness Remote invokes the same action and reloads the
authoritative active branch; with extension 1.2.0 or newer, successful non-Git actions restore
supported workspace file changes as well as conversation state. No bridge package dependency or
alternate action path is required.

The repository Git common-directory sidecar at
`omp-undo-redo/history/<sha256-session-id>.json` remains the durable fallback. The bridge adapts its
schema 1 (`checkpoints` plus `currentIndex`) into action availability and an active leaf revision.
The selected leaf constrains JSONL reconstruction to the active parent chain, so abandoned
append-only branches are not rendered after reload.

If neither authoritative source is available, the bridge hides Undo/Redo instead of synthesizing
availability from defaults. It also declines to select an active branch from JSONL append order and
lets ACP replay the live branch.

### PI — ACP over stdio, via a third-party adapter

This is the only dependency that is neither ours nor first-party, and the one to watch hardest.

- **Adapter:** [`@automatalabs/pi-acp`](https://www.npmjs.com/package/@automatalabs/pi-acp),
  Apache-2.0, in [`VikashLoomba/agentprism-workflows`](https://github.com/VikashLoomba/agentprism-workflows)
  under `packages/pi-acp`. Single maintainer (`automatalabsteam`).
- **Pinned to `0.2.5`** in `bridge/src/harness-profiles.js`.
- **It is young and moves fast:** first published 2026-07-16, eleven versions in the following ten
  days. Treat a bump as a change worth testing, not a routine refresh.

**Why an adapter at all.** PI's maintainer
[declined native ACP support](https://github.com/earendil-works/pi/issues/175), suggesting an
adapter over PI's own RPC mode instead. Several exist. The other widely referenced one,
`@victor-software-house/pi-acp`, declares `engines.bun` and shells out to `bun`; this project runs
on Node everywhere, which is why it is not used.

**Why the version is pinned.** An unpinned `npx -y` default failed live with `notarget`: version
`0.2.6` was in the npm index and tagged `latest` while its tarball was not yet fetchable. A
floating default breaks whenever an upstream publish goes wrong.

**Assumed:**

| Assumption | What breaks if it changes |
|---|---|
| Launched over stdio as an `npx`-installable `bin` | the `--acp-command` / `--acp-arg` defaults in the profile |
| Offers a non-`env_var` auth method (`pi-stored-credentials`) | the bridge would fall back to an API key from an unset environment variable and fail at inference |
| Asks `session/request_permission` before each tool call, offering an `allow_once` option | tool calls stop happening, silently — the failure mode is "reports success, changes nothing" |
| Streams chunks with **no** `messageId` | replies would split into one message per token, or aggregate wrongly |
| Emits no `agent_plan` | the todo panel stays empty |

**The adapter embeds its own PI.** It depends on `@earendil-works/pi-coding-agent` pinned to a
specific version (`0.82.1` in adapter 0.2.5), so the PI that actually runs is the one bundled with
the adapter, not the `pi` on your PATH. Your local install still matters for configuration and
credentials, which it reads from disk. Two consequences:

- updating `pi` locally does not change what the bridge runs;
- the adapter can lag PI releases, so a PI feature can exist locally and be unavailable here.

**Assumed:**

| Assumption | What breaks if it changes |
|---|---|
| Launched over stdio as an `npx`-installable `bin` | the `--acp-command` / `--acp-arg` defaults in the profile |
| Offers a non-`env_var` auth method (`pi-stored-credentials`) | the bridge would fall back to an API key from an unset environment variable and fail at inference |
| Asks `session/request_permission` before each tool call, offering an `allow_once` option | tool calls stop happening, silently — the failure mode is "reports success, changes nothing" |
| Streams chunks with **no** `messageId` | replies would split into one message per token, or aggregate wrongly |
| Emits no `agent_plan` | the todo panel stays empty |

**The adapter embeds its own PI.** It depends on `@earendil-works/pi-coding-agent` pinned to a
specific version (`0.82.1` in adapter 0.2.5), so the PI that actually runs is the one bundled with
the adapter, not the `pi` on your PATH. Your local install still matters for configuration and
credentials, which it reads from disk. Two consequences:

- updating `pi` locally does not change what the bridge runs;
- the adapter can lag PI releases, so a PI feature can exist locally and be unavailable here.

**Exit route.** If the adapter becomes unmaintained or unreliable, PI's own RPC mode
(`packages/coding-agent/docs/rpc.md` in the PI repo) is the first-party alternative. It means
writing a transport in the bridge rather than reusing the ACP client, but it removes the third
party entirely.

### Codex CLI — ACP over stdio, via the official adapter

- **Adapter:** [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp),
  published by the Agent Client Protocol project, MIT. **Pinned to `1.1.14`** in
  `bridge/src/harness-profiles.js`.
- **The adapter embeds `@openai/codex`**, so no separate Codex installation is needed on the host —
  but credentials still come from `codex login` (ChatGPT account) or an `OPENAI_API_KEY` in the
  bridge process environment.
- **Pinned for the same reason as PI and Claude:** an unpinned `npx -y` default fails live with
  `notarget` when a release outruns its own tarball in the registry.

**Assumed, inferred from the adapter bundle (`@agentclientprotocol/codex-acp@1.1.14`) rather than
read from a spec:**

| Assumption | What breaks if it changes |
|---|---|
| `session/list` enumerates every Codex thread on the machine | the session list empties |
| Rollouts stay at `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<sessionId>.jsonl` | `createCodexHistoryLoader` finds nothing and every session Codex holds open shows as empty |
| A rollout records the turns the user saw as `event_msg` records — `user_message.message`, `agent_message.message`, `agent_reasoning.text` | the transcript of an externally-held session goes empty, or starts showing the instruction blocks Codex feeds the model, which `response_item` carries under the `user` role |
| Model config option ids are bare (`gpt-5.2`), not `provider/model` | covered by the same bare-id handling the Claude Code backend proved; if ids gain a provider prefix they still parse, under that provider name |
| `reasoning_effort` and `mode` config options are advertised but not exposed | they stay invisible in the app; no crash, just unused surface |
| `plan` / `plan_update` notifications carry entries addressed as `{content, status, priority}` | todo updates stop rendering |
| `available_commands_update` exposes slash commands | the app's custom `/commands` picker goes empty |
| ACP permissions requests are auto-answered with `allow` (`permissionMode: "allow"`) | if the adapter asks and no answer were sent, tool calls would hang; granting is the deliberate policy |
| `api-key` is advertised before `chat-gpt`. The profile prefers `chat-gpt` so a `codex login` is honoured | the bridge would pick `api-key`, demand `CODEX_API_KEY`/`OPENAI_API_KEY`, and fail at inference; an env-var API key deliberately still works if set |

**One writer per thread.** Codex takes a writer lock for as long as a client keeps a thread open —
`~/.codex/thread-writer-locks/<sessionId>.lock` — and `session/load` answers
`thread <id> already has an active writer` for every session the Codex desktop app or a running
`codex` is sitting on. That is most of the sessions worth looking at, so the profile carries a
`historyLoader` that reads the rollout instead: reading takes no lock, and those sessions display
while Codex still owns them. They stay read-only, because prompting has to take the writer and
`AcpService.prompt` surfaces the refusal.

Reading a rollout means depending on a private on-disk format rather than a protocol, which is the
same trade OMP's loader makes. If the format moves, `bridge/test/codex-session-history.test.js`
pins the shape the loader expects, and the fallback is ACP replay — correct whenever Codex is not
holding the thread.

**Watch:** the embedded `@openai/codex` version (it decides which models and modes exist), the
rollout record shape, and any new `sessionUpdate` / notification shape.

## App and packaging

- **Capacitor** (`@capacitor/core`, `/android`, `/cli`, `/app`) — Android packaging and the back
  button. A major Capacitor version changes the generated Android project, and
  `web/native-android/*.java` is copied into it by `npm run cap:sync:android`; a plain
  `npx cap sync android` drops those files silently.
- **React 18, Vite, `react-markdown`, `remark-gfm`** — ordinary frontend dependencies.
- The **bridge has no dependencies at all** and runs on the Node standard library. Keep it that
  way: it is the piece that has to start reliably on someone else's machine.

### Electron and desktop packaging

- **Electron 43** owns main-process HTTP and SSE connections. Renderer receives only frozen preload
  methods; `contextIsolation`, sandbox, and disabled Node integration are load-bearing.
- **electron-builder 26** creates unsigned artifacts for all three desktops: Windows x64 NSIS, macOS
  arm64/x64 dmg and zip, Linux x64 AppImage and deb. No signing secret is configured, so SmartScreen
  and Gatekeeper warnings are expected. `web/release/` is generated and must not be committed.
- Renderer `web/dist` is built with Vite `--base=./` for `file://` loading. Standard `npm run build`
  keeps PWA/Pages absolute-base behavior.
- All three desktop targets take their icon from `public/app-icon.png`, the same 1024px source the
  PWA uses — electron-builder rasterises it per platform. `nativeImage` cannot decode SVG, which is
  why the taskbar overlay badge reads the PNG too. Android icon assets stay separate.
- Windows-only main-process APIs (`setOverlayIcon`) are absent, not inert, on macOS and Linux: guard
  them by platform. macOS also keeps its application menu, since that is where its shortcuts live,
  and does not quit when the last window closes.
- Saved profiles are validated and persisted by main process under Electron `userData`; request and
  stream calls carry profile IDs plus relative operations, never complete target URLs.

## When a harness changes

Unit tests will not catch this. Every quirk in the tables above was found by running a real agent,
and the fakes in `bridge/test/` only lock in what was already learned.

1. Run the harness for real: create a session, send a prompt, watch the reply stream, run a prompt
   that uses a **tool**, and stop a run.
2. Check whether a tool call actually did something. "Reported success and changed nothing" is the
   signature failure here.
3. Reopen a session and confirm the history is intact and in order.
4. Compare what you see against this file's tables, and update them in the same commit as the fix.
5. Update the capability matrix in `bridge/src/harness-profiles.js` if the harness gained or lost
   something.

For a version bump of the PI adapter specifically, the pin in `harness-profiles.js` is deliberate:
change it consciously, run the checks above, then commit the new pin.
