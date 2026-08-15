# Harness Remote

Harness Remote is a companion app for controlling coding-agent harnesses from phone or desktop, even when you are not at your main workstation.
It is designed to make daily usage simple: connect to a backend, check active sessions, see progress, send new prompts or slash commands, and stop a running action when supported.

## Supported Harnesses

The app is backend-agnostic: you pick the harness in **Settings** and each one keeps its own saved connection, so you can switch between them without re-entering anything.

| Harness | Status | How it connects |
|---|---|---|
| [OpenCode](https://github.com/sst/opencode) | supported | directly to the OpenCode HTTP server |
| [Oh My Pi (OMP)](https://omp.sh/) | supported | through the local bridge included in this repository |
| [PI](https://pi.dev/) | supported | through the local ACP bridge and the [`@automatalabs/pi-acp`](https://www.npmjs.com/package/@automatalabs/pi-acp) adapter |
| [Claude Code](https://code.claude.com/) | supported | through the local ACP bridge and the [`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp) adapter |
| [Codex CLI](https://github.com/openai/codex) | supported | through the local ACP bridge and the [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp) adapter |

What each harness actually provides, the assumptions the code makes about it, and what to re-check
when one of them changes are recorded in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

Support levels differ by what each harness exposes. The [OpenCode](#opencode-server-setup), [OMP](#oh-my-pi-bridge-setup), [PI](#pi-bridge-setup), [Claude Code](#claude-code-bridge-setup), and [Codex CLI](#codex-bridge-setup) sections below document the setup and per-backend limitations.

> **Note for AI/harness systems**: This repository is self-documenting. To configure a supported harness and the app autonomously, point your AI assistant to this repository URL (`https://github.com/giuliastro/harness-remote`) or this README and ask it to set up Harness Remote. Each supported harness has its own setup section below, and adding a harness means adding a backend entry plus its section.

## Screenshots

<!-- A raw table with 50% columns, rather than a markdown one: GitHub sizes markdown table columns
     from their content, and "Sessions" is a wider heading than "Detail", so that column took ~14px
     more and each screenshot scaled to fill whichever column it landed in — the right one rendered
     visibly smaller. Pinning the columns keeps the pair identical at any viewport width, which a
     fixed width on the images alone does not: max-width: 100% still clamps each to its own cell. -->

<table>
  <tr>
    <th width="50%">Sessions</th>
    <th width="50%">Detail</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/sessions.jpg" alt="Sessions list showing connection status, session cards with relative timestamps, and rename and delete actions"></td>
    <td><img src="docs/screenshots/detail.jpg" alt="Session detail showing the model chip, a collapsed reasoning bubble, an assistant reply, and the composer"></td>
  </tr>
</table>

## What It Can Do

Everything in the first group works on all five harnesses. The rest depends on what the harness
exposes, so each entry says where it applies; the app hides what a backend cannot do rather than
offering a control that fails.

- configure and test the connection to any supported harness — OpenCode, OMP, PI, Claude Code, or Codex CLI — each with its
  own saved credentials
- keep several servers saved under names of your own and switch between them from the header, rather
  than retyping a host every time you move between machines
- browse and monitor sessions (`idle`, `busy`, `retry`, `waiting`) — a session a harness reports as
  waiting, on a subagent for instance, reads as working rather than idle, and carries its own marker
  on a wide screen
- open a session and read messages and progress, thinking and tool calls included, each as its own
  step rather than folded into the reply
- copy a message: right-click it, or long-press on a phone, for its text or its markdown
- send prompts from the chat input, including a follow-up typed while the agent is still working
- stop running work when necessary
- pick the model a session uses
- browse the filesystem to choose the working directory for a new session
- adapt to the screen: Android-friendly bottom navigation on a phone, a two-pane sidebar layout that
  fills a wide screen (see [Desktop Mode](#desktop-mode))
- run as an installed app rather than a browser tab: an Android APK, or a
  [desktop build](#desktop-app) for Windows, macOS and Linux that also gets a native notification
  when a session finishes while you are working elsewhere
- jump to the top or the bottom of a long transcript or session list without dragging through it
- play a completion sound when a running session finishes
- switch UI language between English, Italian, and Traditional Chinese, and the theme between light,
  dark, and system

Depending on the harness:

- answer the questions the agent asks, options or free text, without leaving the app — OpenCode
- follow todo/plan updates as the agent works — OpenCode, OMP, Claude Code, Codex CLI
- send server `/commands` — OpenCode, OMP, Codex CLI
- choose the agent a session runs as — OpenCode
- review changed files and their diffs — OpenCode
- rename and delete sessions — OpenCode changes them in the harness; on OMP, PI, Claude Code and
  Codex CLI the same controls keep a bridge-local nickname and hide the session from that bridge only
- extend bridge-backed harnesses through optional host extensions: the bridge discovers compatible
  commands and the app enables their actions only for sessions where they are available; the first
  integration is Undo and Redo for OMP through
  [`@baylarsadigov/omp-undo-redo`](https://github.com/Baylar55/omp-undo-redo), which from version
  1.2.0 restores supported file changes as well as the conversation, in Git and non-Git workspaces

## Desktop Mode

The app is one build with two layouts, and there is no switch to flip: open it in a window at least
781px wide and it rearranges itself into a two-pane desktop layout. Narrow the window below that and
it goes back to the phone layout, live. The [installable desktop app](#desktop-app) packages that
same build, so a browser tab and the installed app show the same thing at the same width.

| | Phone layout | Desktop layout |
|---|---|---|
| Navigation | bottom nav, one view at a time | permanent left sidebar next to the chat |
| Sessions | full-screen list, tap to open | compact rows in the sidebar, always visible |
| Settings / Help | own full-screen views | modal over the chat, so the session stays put |
| Session status | `idle` / `busy` / `retry` pill | animated accent bar on the row, only while busy or retrying |

### Using it

1. Serve the web app — `npm run dev` in `web/` during development, or any static host for a
   `npm run build` bundle. The Android APK uses the same code and switches layout on a tablet or
   a large foldable.
2. Open it in a desktop browser. Above 781px the sidebar appears and the first session opens by
   itself, so you land in a conversation rather than on an empty pane.
3. Pick sessions from the sidebar. Hovering a row reveals its rename and delete icons; the
   session you are reading stays highlighted while you browse the rest.
4. Drag the divider between the two panes to resize. The sidebar accepts 220–480px, remembered per
   browser and clamped back inside the window if you later open the app on a smaller screen; the
   chat pane takes whatever is left, so the app always fills the window. The conversation itself
   stays within a readable column at the centre of that pane rather than stretching across a wide
   display — the panels, headers and composer are what grow.
5. Use the floating arrow buttons at the bottom right of a long transcript or session list to jump
   to either end. They only appear when there is enough scrolling left to be worth it, and jumping
   to the top also releases the chat's auto-follow so incoming output stops yanking the view down.

Everything else — prompts, slash commands, stopping a run, model and agent selection, todos,
diffs — behaves exactly as it does on a phone. The backend setup below is identical either way.

### Desktop app

The installable desktop app packages the same `web/` UI inside a secure Electron shell, for Windows,
macOS and Linux. Every `v*` tag builds all three and attaches them to the
[release](https://github.com/giuliastro/harness-remote/releases/latest), next to the Android APK.

To build one yourself, run `npm ci` in `web/` and then the script for the platform you are sitting
at — electron-builder does not cross-compile, so each artifact is built on its own OS:

| Platform | Script | Artifact in `web/release/` |
| --- | --- | --- |
| Windows | `npm run package:win` | `Harness-Remote-<version>-win-x64-unsigned.exe` |
| macOS | `npm run package:mac` | `Harness-Remote-<version>-mac-<arch>-unsigned.dmg` and `.zip`, for arm64 and x64 |
| Linux | `npm run package:linux` | `Harness-Remote-<version>-linux-x86_64.AppImage` and `-linux-amd64.deb` |

Nothing is signed, so the first launch needs a deliberate override: Windows SmartScreen offers
**More info → Run anyway**, and macOS Gatekeeper needs **right-click → Open** (or
**System Settings → Privacy & Security → Open Anyway**). Take that step only when you trust where the
artifact came from. An AppImage also needs its executable bit — `chmod +x` — before it will run.

Electron owns the HTTP and SSE traffic, so OpenCode and bridge servers do not need `--cors` for the
installed app; browser and PWA traffic still needs the exact browser origin in the server's CORS
configuration. Saved profiles live under Electron's user data and are never accepted as inline
request URLs. Closing the app also closes its active event streams.

## Progressive Web App (PWA)

The web app is installable and is published straight from this repo via GitHub Pages, at
https://giuliastro.github.io/harness-remote/. Open that URL over HTTPS and browsers will offer to
add it to the home screen / app list, opening in its own standalone window.

It is redeployed on every merge to `main` that touches `web/`, so it carries the current tip of the
branch rather than the last release. That is the point: it is where a change gets tried on a real
phone against a real server before it ships. The packaged builds in [Releases](https://github.com/giuliastro/harness-remote/releases/latest)
— the Android APK and the three desktop apps — are the stable channel and still come only from `v*`
tags. If you want a version that was cut deliberately, install one of those.

The deploy runs the web regression suites first, so a merge that breaks them does not reach the URL.

- A service worker caches the app shell (`index.html`, the manifest, and the icons) plus other
  same-origin static assets on a stale-while-revalidate basis, so UI still loads offline or on a
  flaky connection after first visit.
- Requests to your harness server are never cached — they go to whatever host you configured in
  Settings, cross-origin from wherever the PWA itself is hosted, so session data always comes from
  the live server.
- The service worker is skipped entirely in the native Android app (Capacitor), packaged Electron,
  and local dev builds; it only registers in production web builds.

Because the app talks to your server cross-origin, the server needs the PWA's origin listed
in `--cors`:

```bash
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096 --cors https://giuliastro.github.io
```

## Technology Stack

- frontend: React + TypeScript + Vite
- desktop packaging: Electron + electron-builder (unsigned Windows, macOS and Linux builds)
- mobile packaging: Capacitor (Android APK)
- networking: per-harness transports behind one app-side API — the OpenCode HTTP API spoken directly, and the local HTTP/SSE bridge in `bridge/` that fronts both OMP and PI over ACP
- CI/CD: GitHub Actions for cloud APK and unsigned desktop builds
- i18n: lightweight custom i18n module with English, Italian, and Traditional Chinese

## Download

Every release carries the Android APK plus desktop builds for all three platforms:

| Platform | File |
| --- | --- |
| Android | `-android.apk` |
| Windows | `-win-x64-unsigned.exe` installer |
| macOS | `-mac-arm64-unsigned.dmg` (Apple Silicon) or `-mac-x64-unsigned.dmg` (Intel), `.zip` alternatives |
| Linux | `-linux-x86_64.AppImage` or `-linux-amd64.deb` |

https://github.com/giuliastro/harness-remote/releases/latest

The desktop artifacts are unsigned, so expect a SmartScreen or Gatekeeper prompt on first launch —
[Desktop app](#desktop-app) explains how to get past it. The web app needs no download at all: it is
published as an installable [PWA](#progressive-web-app-pwa).

## Harness Setup

### OpenCode Server Setup

Start the OpenCode server with network access and Basic Auth.

macOS / Linux (bash/zsh):

```bash
OPENCODE_SERVER_USERNAME=opencode OPENCODE_SERVER_PASSWORD=your-password npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096
```

Windows PowerShell:

```powershell
$env:OPENCODE_SERVER_USERNAME="opencode"
$env:OPENCODE_SERVER_PASSWORD="your-password"
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096
```

Windows cmd:

```cmd
set OPENCODE_SERVER_USERNAME=opencode
set OPENCODE_SERVER_PASSWORD=your-password
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096
```

For browser-based web debugging, add CORS origins as needed:

```bash
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096 --cors http://localhost:5173 --cors http://127.0.0.1:5173
```

For Android APK (Capacitor native HTTP) CORS is usually not required, but keeping explicit origins is still fine.

If you use browser mode from another host/IP, include both localhost and your dev host:

```powershell
npx -y opencode-ai serve --hostname 0.0.0.0 --port 4096 --cors http://localhost --cors http://localhost:5173 --cors http://<YOUR_PC_IP>:5173
```

If remote/mobile cannot connect, open TCP 4096 in your OS firewall and network firewall/NAT.

### Oh My Pi Bridge Setup

Harness Remote connects to OMP through the bridge included in this repository. The bridge starts `omp acp` on the same computer and translates its ACP stdio protocol to the app's HTTP/SSE API. To show sessions created by another OMP process without loading and interrupting them, it reads the append-only user/assistant transcript under OMP's session directory; it does not modify OMP state.

#### Prerequisites

- Node.js 20 or newer;
- a working `omp` command in `PATH`;
- a checkout of this repository on the computer that runs OMP.

Start the bridge from the repository root. Restrict every worktree that the phone may access with `--root`; repeat the option to allow more than one root.

```bash
npx --yes ./bridge \
  --host 0.0.0.0 \
  --port 4097 \
  --username omp \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

The default ACP launch is `omp acp`. The bridge can launch another ACP adapter with `--acp-command` and repeatable `--acp-arg` options, for example:

```bash
npx --yes ./bridge \
  --acp-command npx \
  --acp-arg -y \
  --acp-arg @automatalabs/pi-acp@0.2.5
```

The preferred environment variables are `HARNESS_REMOTE_ACP_COMMAND` and
`HARNESS_REMOTE_ACP_ARGS`, where the latter is a JSON array of strings.
Existing `OMP_BRIDGE_*` names remain aliases for one compatibility release.
The PI setup below selects the adapter and the matching app backend automatically.

The default bind address is `127.0.0.1`. Use `0.0.0.0` only for a trusted LAN or VPN. The bridge refuses a non-loopback bind without both username and password.

#### Configure the app

1. In **Settings**, select **Oh My Pi (bridge)**.
2. Enter the computer's LAN or VPN address, port `4097`, and the same Basic Auth credentials.
3. Select **Test connection**. A healthy bridge reports the installed OMP version.
4. Create or open a session, then send a prompt. The user message appears immediately, followed by streamed assistant output.

To verify the bridge from the host before configuring the app:

```bash
curl --user "omp:use-a-long-unique-password" http://127.0.0.1:4097/v1/health
```

Expected response:

```json
{"healthy":true,"backend":"omp","version":"…"}
```

OMP sessions expose their configured model when ACP provides it, and model changes apply to subsequent prompts. Server slash commands are available: OMP advertises them over ACP, the bridge serves them at `/command`, and the app lists them under **Help → Commands**, with a separate tab for the `skill:` ones. Agent selection and VCS/diff remain unavailable.

A prompt sent while the agent is still working is queued rather than refused: it appears in the conversation
straight away and runs when the current turn ends. Stopping the session discards anything still queued.

Session titles come from the title you give a session in the app, otherwise from its first prompt; sessions created outside the app are listed with a generated `Session <id>` title when the ACP listing carries no title.

Rename and delete use the same controls as OpenCode, but they are bridge-local metadata: a rename is a
nickname and a delete hides the session from this bridge only. Both live under the bridge's state
directory, so clearing or moving `--state-dir` restores the harness title and makes hidden sessions
visible again. ACP defines no physical session deletion, so the native OMP history stays intact and
remains visible to desktop clients.

#### What `--root` does and does not restrict

`--root` restricts the bridge's own surface: which directories the app may browse (`/file`, `/path`) and which working directory a new session may use. It is not a sandbox for the agent. Once a session is running, OMP executes with your full user privileges and approves its own tool calls, so it can read and write outside the configured roots exactly as it would on the desktop. Point the bridge only at machines and accounts where you would already let OMP work unattended.

#### Browser access

Native app builds need no CORS configuration. To use the app from a browser instead, list each exact origin with `--cors`; the option is repeatable and no origin is allowed by default.

```bash
npx --yes ./bridge --port 4097 --username omp --password "…" --root "$HOME/Software" \
  --cors http://localhost:5173
```

#### Live synchronization scope

The bridge streams `busy`, assistant chunks, todos, and completion for work started through that same bridge. Sessions created by desktop OMP or another client are listed with their persisted history and remain writable: the first prompt from the app loads that session into the bridge's ACP process and continues it there. This supports sequential hand-off between desktop and mobile, including sessions created days earlier.

OMP ACP does not expose a global cross-client event feed, shared running-status API, or session lock. Concurrent desktop and app turns are accepted, and the bridge merges newly persisted OMP transcript branches into the app during polling so neither client's messages disappear. The two agent processes still run independently: response order and the context seen by each turn can branch. Sequential hand-off is deterministic; simultaneous use is supported for visibility but cannot provide server-level turn serialization.

The bridge keeps its last successful message/todo snapshot and bridge-local session nicknames/archive state under `~/.harness-remote/<backend>/`. This prevents an empty or partial ACP replay from erasing the app's conversation after navigation or a bridge restart. Use `--state-dir <path>` or `HARNESS_REMOTE_STATE_DIR` to relocate this state; deleting or replacing that directory also discards bridge-local renames and hidden-session records.

Do not expose the bridge directly to the Internet. Use Tailscale, another VPN, or a TLS-terminating reverse proxy, and open port `4097` only to the network that needs it.

### PI Bridge Setup

Harness Remote connects to PI through the same ACP bridge, using the community
[`@automatalabs/pi-acp`](https://www.npmjs.com/package/@automatalabs/pi-acp)
adapter, which embeds PI through its published SDK and speaks ACP over stdio.
The bridge starts the adapter and translates ACP into the HTTP/SSE API used by
the app.

#### Prerequisites

- Node.js 22.19 or newer, as required by the adapter. Nothing here needs Bun: the other
  widely referenced adapter, `@victor-software-house/pi-acp`, declares `engines.bun` and shells
  out to `bun`, which is why this project does not use it;
- a working `pi` command, with its provider credentials already configured — the bridge
  authenticates with PI's stored credentials rather than reading an API key from the environment;
- a checkout of this repository on the computer that runs the bridge.

Start the bridge from the repository root:

```bash
npx --yes ./bridge \
  --backend pi \
  --host 0.0.0.0 \
  --port 4097 \
  --username pi \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

The `pi` backend defaults to `npx -y @automatalabs/pi-acp@0.2.5`. The version is pinned
deliberately: an unpinned default failed with `notarget` when an upstream release appeared in
the registry index before its tarball could be fetched. Use `--acp-command` and repeated
`--acp-arg` options to track a newer adapter, or to launch one installed globally or from a
local checkout. The first start downloads the adapter, which is why the handshake allows 90s.

In the app, select **PI (ACP bridge)** and enter the same host, port, username,
and password. A successful health check reports `backend: "pi"` and the
adapter version.

PI supports session listing, history replay, streaming prompts, cancellation,
queued follow-up prompts, model selection, and bridge-local rename/delete.
Plan/todo updates, server slash commands, and VCS/diff are not currently exposed
through this bridge.

The nickname and hidden-session records live under the bridge state directory:
clearing or moving it restores PI's native title and listing. ACP does not define
physical session deletion, so deleted sessions remain in PI's own history.

Unlike OMP, PI's adapter asks before each tool call. **The bridge grants those requests
automatically**, choosing the broadest allow option the adapter offers, because there is no way
to prompt you on the phone mid-turn and a refusal silently prevents PI from doing any work at
all. The practical effect matches OMP, which approves its own tool calls without asking: an
agent reached through this bridge edits files unattended.

The bridge's `--root` restriction applies to directory browsing and new-session
selection; it is not a sandbox for PI. The adapter still runs with the full
filesystem privileges of the account that launched it. Do not expose the
bridge directly to the Internet; use a trusted LAN, VPN, or TLS-terminating
reverse proxy.

### Claude Code Bridge Setup

Harness Remote connects to Claude Code through the same ACP bridge, using the official
[`@agentclientprotocol/claude-agent-acp`](https://www.npmjs.com/package/@agentclientprotocol/claude-agent-acp)
adapter, which wraps the Claude Agent SDK and speaks ACP over stdio.

#### Prerequisites

- Node.js 22 or newer (same requirement as the PI adapter);
- a working `claude` command, authenticated via `claude login` (OAuth) — a subscription login
  is sufficient and does not require `ANTHROPIC_API_KEY`;
- a checkout of this repository on the computer that runs Claude Code.

Start the bridge from the repository root:

```bash
npx --yes ./bridge \
  --backend claude \
  --host 0.0.0.0 \
  --port 4097 \
  --username claude \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

The `claude` backend defaults to `npx -y @agentclientprotocol/claude-agent-acp@0.63.0`.
The version is pinned to avoid the same `notarget` issue that motivated pinning the
PI adapter. Use `--acp-command` and repeated `--acp-arg` options to track a newer
adapter. The first start downloads the adapter, which is why the handshake allows 90s.

In the app, select **Claude Code (ACP bridge)** and enter the same host, port,
username, and password. A successful health check reports `backend: "claude"`
and the adapter version.

Claude Code supports session listing, history replay, streaming prompts,
cancellation, queued follow-up prompts, todo/plan updates as the agent works, and
model selection. The picker offers whatever the adapter reports — Default, Sonnet,
Fable, Opus with 1M context, Haiku — each with the version it stands for, so
"Sonnet" reads as `Sonnet 5 · Efficient for routine tasks`. Agent selection, server
slash commands, and VCS/diff are not currently exposed through this bridge.

The adapter also advertises a permission `mode` and an `effort` level, which the app
does not use yet.

**Rename and delete are bridge-local.** Renames persist in `~/.harness-remote/claude/`
and survive bridge restarts, but are not propagated to the `claude` CLI itself.
Deletion hides the session from this bridge and clears its cached data; it does
not erase Claude Code's own history on disk. Deleted sessions reappear if the
bridge is started from a fresh state directory.

**Session visibility is not restricted by `--root`.** The bridge enumerates all
Claude Code sessions on the machine, potentially spanning every repository the
user has ever worked in. Anyone holding the bridge credentials can list and read
every past conversation. The `--root` option only governs directory browsing and
new-session cwd, not which sessions are visible.

Like PI, the Claude Code adapter asks before each tool call. **The bridge grants
those requests automatically** — there is no way to prompt on the phone mid-turn
and a refusal would silently prevent the agent from working. An agent reached
through this bridge edits files unattended.

The adapter still runs with the full filesystem privileges of the account that
launched it. Do not expose the bridge directly to the Internet; use a trusted
LAN, VPN, or TLS-terminating reverse proxy.

### Codex Bridge Setup

Harness Remote connects to Codex CLI through the same ACP bridge, using the official
[`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)
adapter, which embeds the OpenAI Codex engine and speaks ACP over stdio — no separate Codex
installation is needed.

#### Prerequisites

- Node.js 22 or newer (same requirement as the PI and Claude Code adapters);
- a Codex login via `codex login` (ChatGPT account) or an OpenAI API key set in the environment
  of the bridge process;
- a checkout of this repository on the computer that runs Codex.

Start the bridge from the repository root:

```bash
npx --yes ./bridge \
  --backend codex \
  --host 0.0.0.0 \
  --port 4097 \
  --username codex \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

The `codex` backend defaults to `npx -y @agentclientprotocol/codex-acp@1.1.14` and authenticates
through the adapter's ChatGPT method, so a `codex login` on the host machine is what the bridge
uses — an `OPENAI_API_KEY` environment variable works too, but is not required and is not preferred.
The version is pinned to avoid the same `notarget` issue that motivated pinning the PI adapter. Use
`--acp-command` and repeated `--acp-arg` options to track a newer adapter. The first start downloads
the adapter and its embedded Codex engine, which is why the handshake allows 90s.

In the app, select **Codex CLI (ACP bridge)** and enter the same host, port,
username, and password. A successful health check reports `backend: "codex"`
and the adapter version.

When the app runs in a browser (the Vite dev server, a PWA tab), the bridge must
admit that origin explicitly or the browser drops every response at CORS despite a
healthy backend:

```bash
npx --yes ./bridge --backend codex --host 0.0.0.0 --port 4097 \
  --username codex --password "use-a-long-unique-password" --root "$HOME/Software" \
  --cors http://localhost:5173 --cors http://192.168.1.20:5173
```

The same applies to the OMP, PI and Claude Code backends; `--cors` is a general
bridge option, documented in `CONTRIBUTING.md`.

Codex supports session listing, history replay, streaming prompts,
cancellation, queued follow-up prompts, todo/plan updates as the agent works,
model selection, and slash commands (`/status`, `/plan`, `/mcp`, ...). The model
picker offers whatever the adapter reports; like Claude Code, ids are bare rather
than `provider/model`. Reasoning-effort and mode levels are advertised by the
adapter but the app does not use them yet. No VCS/diff or agent picker is exposed
through this bridge.

**Sessions the Codex desktop app is holding open are read-only here.** Codex allows one
writer per conversation and keeps the lock for as long as a client has it open, so those
sessions cannot be joined over ACP. The bridge shows them anyway by reading Codex's own
transcript from `~/.codex/sessions`, and the app marks them *Started by another client*;
they keep updating as Codex works. Sending a prompt has to take the writer, so it fails
while the desktop app holds it — close the conversation there, or start a new session from
the app, and it becomes writable. The model picker is unavailable for those sessions too,
because Codex only reports the available models as part of the load it is refusing.

**Rename and delete are bridge-local**, exactly as with Claude Code. Session
visibility is not restricted by `--root`: the bridge enumerates every Codex
session on the machine.

**The bridge grants tool permissions automatically.** Codex can still ask for
permission in its CLI mode; through ACP the bridge answers `allow` for every
request, so an agent reached through this bridge edits files unattended — same
policy and same caveats as the Claude Code backend.

## Run Locally (Web)

```bash
cd web
npm install
npm run dev
```
Open the shown URL from your browser (or your phone on the same LAN). A desktop browser window
gets the two-pane layout described in [Desktop Mode](#desktop-mode); a phone gets the mobile one.

## Android APK Build (Cloud, no local SDK required)

1. Push to `main` to run build and regression checks and upload debug/release APK artifacts.
2. Create a `v*` tag after the checks and device smoke test succeed; it publishes a GitHub Release.
3. Download `harness-remote-debug-apk-v<version>` from GitHub Actions for installation tests.

To publish a signed release APK (`app-release-signed.apk`), configure these GitHub repository secrets:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

Tagged releases fail rather than publishing an unsigned APK when any signing secret is missing. The workflow builds the web app, runs web and bridge regressions, synchronizes Capacitor plus native live events, builds Android artifacts, and verifies APK signatures.

## Manual Android Packaging (Optional)

```bash
cd web
npm run build
npx cap add android
npx cap sync android
```

Then open `web/android` in Android Studio if you want local native debugging.

## App Configuration

Use your server values:

- Backend: the harness you are connecting to, which also decides the default port
- Host: computer LAN IP (for example `192.168.1.20`)
- Port: `4096` for an OpenCode server, `4097` for the bridge in front of OMP, PI, Claude Code, or Codex CLI
- Username/password: the Basic Auth credentials you started that server or bridge with

Each backend keeps its own saved connection, so switching between them in Settings does not make you
retype anything.

The app is not limited to LAN. You can also use it over WAN/VPN if your network routing (NAT/firewall) and security setup are configured correctly.

## Main Endpoints Used

Against an OpenCode server, spoken directly: `/global/health`, `/global/event`, `/session*`
(including `/session/:id/message`, `/command`, `/abort`, `/todo`, `/diff`), `/experimental/session`,
`/config/providers`, `/command`, `/agent`, `/project/current`, `/vcs`, `/path`, `/file*`, and
`/question*`.

For OMP, PI, Claude Code, and Codex CLI the bridge implements a deliberate subset of those paths,
plus its own `/v1/health` and `/v1/capabilities`. OMP also exposes generic session action discovery
and invocation through `/session/:id/action` and `/session/:id/action/:name` when a known host
extension is loaded. Capabilities tell the app which APIs are supported so it hides the rest rather
than calling something that 404s. [CONTRIBUTING.md](CONTRIBUTING.md) lists exactly what the bridge
does and does not answer.

What each harness actually provides behind those paths, and what to re-check when one of them
changes, is in [docs/DEPENDENCIES.md](docs/DEPENDENCIES.md).

## Contributing

Setup, the checks CI expects, how the regression suites work, and the rules that every change has to
hold on more than one harness and in both layouts are all in [CONTRIBUTING.md](CONTRIBUTING.md).
