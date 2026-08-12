# Harness Remote

Harness Remote is a companion app for controlling coding-agent harnesses from phone or desktop, even when you are not at your main workstation.
It is designed to make daily usage simple: connect to a backend, check active sessions, see progress, send new prompts or slash commands, and stop a running action when supported.

## Quick start for ACP-backed harnesses

For OMP, PI, Claude Code and Codex CLI, the repository now includes a thin one-command launcher over the existing bridge:

```bash
npm install
npm start
```

When installed as a package/repository binary, the equivalent command is `harness-remote`. It detects an unambiguous installed agent CLI, chooses an available port, generates LAN credentials when needed, prints the connection details, and starts the existing bridge. If several supported CLIs are installed, choose one explicitly, for example `harness-remote --backend codex`.

See [docs/QUICK_START.md](docs/QUICK_START.md) for the short path and overrides. OpenCode remains direct HTTP and is not wrapped by this bridge launcher.

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
- switch UI language between English, Italian, Traditional Chinese, and Simplified Chinese, and the theme between light,
  dark, and system

Depending on the harness:

- answer the questions the agent asks, options or free text, without leaving the app — OpenCode
- follow todo/plan updates as the agent works — OpenCode, OMP, Claude Code, Codex CLI
- send server `/commands` — OpenCode, OMP, Codex CLI
- choose the agent a session runs as — OpenCode
- review changed files and their diffs — OpenCode
