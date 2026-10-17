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

First-party command, no third party in the path. The bridge uses `session/new`, `session/resume`,
`session/list`, `session/prompt`, `session/cancel` and `session/set_config_option`, and reads the
Session's own JSONL journal directly. `session/load` is used only by an OMP old enough not to
advertise `session/resume`.

**Read from the OMP source (`can1357/oh-my-pi`, verified at 18.0.7) rather than observed:**

| Fact | Where it comes from | What depends on it |
|---|---|---|
| `session/load` replays the whole stored transcript back over the wire, minting `crypto.randomUUID()` per replayed message | `AcpAgent.loadSession` → `#replaySessionHistory` | replay can never be a transcript identity, so the bridge does not use `session/load` to read |
| Replay flattens `developer`, `custom`, `hookMessage`, tool results and bash/python output into `user_message_chunk` | `#messageToReplayNotifications` | a replayed Session would grow turn boundaries nobody typed |
| `session/resume` opens the same stored Session and returns the same `configOptions` with no replay | `AcpAgent.resumeSession` → `#resumeManagedSession` (identical to `#loadManagedSession`, minus the replay) | this is how the bridge takes the writer |
| `initialize` advertises `agentCapabilities.sessionCapabilities.resume` | `AcpAgent.initialize` | the bridge falls back to `session/load` when it is absent, so an older OMP still works |
| The live path never emits `user_message_chunk`; only `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update` and `plan` | `acp-event-mapper.ts` | a submitted prompt is not echoed back, so the transport echo filter is a guard rather than a workaround |
| One `messageId` per live assistant message, cleared when that message ends | `#getLiveMessageId`, `#clearLiveAssistantMessageAfterEvent` | a turn that calls a tool legitimately streams under two ids |
| `session/prompt` resolves only after the end-of-turn updates are flushed and awaited | `AcpAgent.#trackPromptEvent` on `agent_end` | the answer is complete when the turn goes idle; no settle delay is needed |
| `initialize` advertises `promptCapabilities.image`, and prompts accept `{type:"image", mimeType, data}` | `AcpAgent.initialize`, `#convertPromptBlocks` | the composer's attachment picker |
| `session/list` returns `title`, `updatedAt` and `_meta.messageCount` | `AcpAgent.#toSessionInfo` | Session list metadata, and the Session index the app reads |
| `/rename <title>` calls `setSessionName(title, "user")`, which rewrites the title slot, appends a `title_change` entry and marks the name user-set so auto-titling leaves it alone | `builtin-lifecycle.ts`, `SessionManager.setSessionName` | a Session's name is stored by OMP rather than only in this bridge; it is sent only when the command catalog advertises `rename` |
| `available_commands_update` and `session_info_update` are pushed after new/load/resume | `#emitBootstrapUpdates` | optional extension actions are discovered from the command catalog |

**The journal format, from `session-entries.ts`, `session-manager.ts` and `session-migrations.ts`:**

| Fact | Where it comes from | What depends on it |
|---|---|---|
| Line 1 is a fixed-width `type:"title"` slot with no `id`; line 2 is a `type:"session"` header with an `id` but no `parentId` | `SessionTitleSlotEntry`, `SessionHeader` | neither is a node in the branch graph |
| The persisted branch leaf is the last entry in file order | `SessionEntryIndex.insert` sets `#leaf` per entry; `rebuild()` replays them in order | the bridge selects the same branch OMP would resume, with no ACP round trip |
| A branch is `parentId` walked back from the leaf | `SessionEntryIndex.pathTo` | abandoned sibling branches are not rendered |
| v1 journals carry no `id`/`parentId`; OMP adds them in memory on first open and rewrites the file | `migrateToCurrentVersion` → `migrateV1ToV2` | an old Session must be reconstructed linearly to be readable before that rewrite, or it reads as empty |
| A `user` message can be `synthetic` (injected) or `steering` (documented as never rendered) | `UserMessage` in `packages/ai/src/types.ts` | neither may open a conversation turn |
| `Interrupted by user` and `__omp.silent_abort__` are abort reasons OMP's own renderers suppress | `shouldRenderAbortReason`, `isSilentAbort`, `isUserInterruptAbort` | a Stop must not leave a red error banner in the reopened transcript |
| An assistant message carries `toolCall` blocks and the matching `toolResult` arrives as its own entry | `AssistantMessage`, `ToolResultMessage` | Activity is reconstructed from the journal instead of from replay |
| Large images are externalised to `blob:sha256:<hash>` in `~/.omp/agent/blobs/data` | `blob-store.ts` | such a payload is not base64 and is skipped rather than rendered as a broken data URL |
| Session files are `<timestamp>_<sessionId>.jsonl` under `~/.omp/agent/sessions`, created lazily | `SessionManager#assignSessionFile`, `getSessionsDir` | lookups match by id suffix and a miss is retried rather than remembered |

**Assumed rather than read:** the agent approves its own tool calls and never sends
`session/request_permission`.

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
- **Pinned to `0.5.0`** in `bridge/src/harness-profiles.js`.
- **It is young and moves fast:** first published 2026-07-16, eleven versions in the following ten
  days. Treat a bump as a change worth testing, not a routine refresh.

**Why an adapter at all.** PI's maintainer
[declined native ACP support](https://github.com/earendil-works/pi/issues/175), suggesting an
adapter over PI's own RPC mode instead. Several exist. The other widely referenced one,
`@victor-software-house/pi-acp`, declares `engines.bun` and shells out to `bun`; this project runs
on Node everywhere, which is why it is not used.

**Why the version is pinned.** A floating `npx` default can break when an upstream publish is
incomplete or changes the adapter contract. The bridge uses the tested version declared in
`harness-profiles.js` and upgrades it only with real-harness validation.

**Assumed:**

| Assumption | What breaks if it changes |
|---|---|
| Launched over stdio as an `npx`-installable `bin` | the `--acp-command` / `--acp-arg` defaults in the profile |
| Offers a non-`env_var` auth method (`pi-stored-credentials`) | the bridge would fall back to an API key from an unset environment variable and fail at inference |
| Asks `session/request_permission` before each tool call, offering an `allow_once` option | tool calls stop happening, silently — the failure mode is "reports success, changes nothing" |
| Streams chunks with **no** `messageId` | replies would split into one message per token, or aggregate wrongly |
| Emits no `agent_plan` | the todo panel stays empty |

**The adapter embeds its own PI.** The PI that actually runs is bundled with the adapter, not the
`pi` on your PATH. Your local install still matters for configuration and credentials, which the
adapter reads from disk. Two consequences:

- updating `pi` locally does not change what the bridge runs;
- the adapter can lag PI releases, so a PI feature can exist locally and be unavailable here.


**Exit route.** If the adapter becomes unmaintained or unreliable, PI's own RPC mode
(`packages/coding-agent/docs/rpc.md` in the PI repo) is the first-party alternative. It means
writing a transport in the bridge rather than reusing the ACP client, but it removes the third
party entirely.

### Claude Code — ACP over stdio, via the official adapter

- **Adapter:** [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp),
  which wraps the Claude Agent SDK and speaks ACP over stdio. **Pinned to `0.84.0`** in
  `bridge/src/harness-profiles.js`.
- **Authentication:** the host must already have `claude login` credentials or
  `ANTHROPIC_API_KEY` available to the adapter. The bridge does not manage Claude credentials.
- **Runtime:** Node.js 22 or newer. The first start downloads the pinned adapter through `npx`.

**Assumed:**

| Assumption | What breaks if it changes |
|---|---|
| The adapter is an `npx`-installable ACP process and accepts the standard ACP handshake | the default command in `harness-profiles.js` no longer starts or authenticates |
| `session/list`, `session/load`, `session/prompt` and `session/cancel` expose the session surface used by the generic bridge | session browsing, history replay, prompting or cancellation stops working |
| The `model` config option uses bare ids such as `sonnet` and `opus[1m]` | the model picker can no longer map the adapter's values back to the bridge |
| Plan/todo updates arrive through the ACP notifications already handled by `AcpService` | the Claude Code todo panel stops updating |
| Tool permission requests accept the bridge's automatic `allow` response | tool calls can hang or be refused; the bridge deliberately runs Claude unattended |
| The adapter does not advertise image prompt support | the app hides attachments and refuses image parts for this backend |

**Session scope and security.** Claude Code sessions are enumerated by the adapter independently of
the bridge's `--root` directories. The bridge can therefore expose sessions from repositories outside
the configured browsing roots to anyone who has the bridge credentials. Treat those credentials as
full access to the Claude Code account on that host, and use a trusted LAN, VPN or TLS-terminating
proxy rather than exposing the bridge directly to the Internet.

**Not assumed:** that every `tool_call` the adapter opens is closed by a `tool_call_update`. It is
observed to leave calls open — those still running when a turn ends, is cancelled or fails, and those
replayed out of a loaded session's history — so `AcpService` settles a Session's open tool calls and
reasoning as soon as the turn behind them is no longer live (`settleUnfinishedActivity`). Without it
an Activity section in a finished conversation reads `Working` for good, snapshot included.

**Watch:** the pinned adapter version, bare model ids, ACP session update and permission-request
shapes, and whether session visibility or image capability changes. The app intentionally does not
expose agent selection, server slash commands or VCS/diff for this backend.

### Codex — ACP over stdio, via the official adapter

- **Adapter:** [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp),
  published by the Agent Client Protocol project, MIT. **Pinned to `1.13.1`** in
  `bridge/src/harness-profiles.js`.
- **The adapter embeds `@openai/codex`**, so no separate Codex installation is needed on the host —
  but its optional native binary dependency must be present. Discovery first honors `CODEX_PATH`,
  then a working `codex` on PATH, then known Codex/ChatGPT desktop bundle paths on Linux/macOS.
  The discovered binary is passed to the adapter as `CODEX_PATH`. Credentials come from the native
  cached account or configured provider credentials; signing in to ChatGPT alone does not prove
  that the Codex runtime has a usable account.
- **Pinned for the same reason as PI and Claude:** an unpinned `npx -y` default fails live with
  `notarget` when a release outruns its own tarball in the registry.

**Assumed, inferred from the adapter bundle (`@agentclientprotocol/codex-acp@1.1.14`) rather than
read from a spec:**

| Assumption | What breaks if it changes |
|---|---|
| `session/list` enumerates every Codex thread on the machine | the session list empties |
| Rollouts stay at `${CODEX_HOME:-~/.codex}/sessions/<yyyy>/<mm>/<dd>/rollout-<timestamp>-<sessionId>.jsonl` | `createCodexHistoryLoader` finds nothing and every session Codex holds open shows as empty |
| A rollout records the turns the user saw as `event_msg` records. Current rollouts use `item_completed` with `UserMessage.content[type=text]`, `AgentMessage.content[type=Text]`, and `Reasoning.summary_text`; legacy rollouts use `user_message.message`, `agent_message.message`, and `agent_reasoning.text` | the transcript of an externally-held session goes empty, or starts showing the instruction blocks Codex feeds the model, which `response_item` carries under the `user` role |
| Model config option ids are bare (`gpt-5.2`), not `provider/model` | covered by the same bare-id handling the Claude Code backend proved; if ids gain a provider prefix they still parse, under that provider name |
| `reasoning_effort` and `mode` config options are advertised but not exposed | they stay invisible in the app; no crash, just unused surface |
| `plan` / `plan_update` notifications carry entries addressed as `{content, status, priority}` | todo updates stop rendering |
| `available_commands_update` exposes slash commands | the app's custom `/commands` picker goes empty |
| ACP permissions requests are auto-answered with `allow` (`permissionMode: "allow"`) | if the adapter asks and no answer were sent, tool calls would hang; granting is the deliberate policy |
| Adapter 1.13.1 checks the cached account on operations; explicitly calling `authenticate` at discovery can refresh tokens and open browser login | Codex disables that startup RPC to reuse the native account. Missing authentication must still fail visibly on operations; `chat-gpt` remains the declared method |

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

### OpenCode 2 — native default effort

Observed with OpenCode 2.0.11: both ACP session config and native session export may report
`default` as the selected effort even when it is absent from selectable model variants. Restoring
that value as an explicit variant makes the next prompt fail catalog validation after reopening.
The OpenCode 2 profile declares `modelVariantDefaultValues: ["default"]`; `AcpService` normalizes
it to the base model in both read paths. Actual variants such as `high` remain explicit, and unknown
variants are still rejected. Recheck config and export restoration together when this contract changes.

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
