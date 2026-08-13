# Harness Remote

**Run and supervise AI coding agents across your machines, from anywhere.**

Harness Remote is a **local-first control plane for AI coding agents**. Connect to the machines where your code and credentials already live, then supervise OpenCode, Claude Code, Codex CLI, Oh My Pi and PI from one interface on phone, web or desktop.

**One interface. Multiple agents. Multiple machines. Your infrastructure.**

> Harness Remote is not another coding agent. It is the control plane above them.

```text
                         Harness Remote
                    phone · web · desktop
                              │
                     ┌────────┴────────┐
                     │  Machine Daemon │
                     └────────┬────────┘
                 ┌────────────┼────────────┐
              Codex        Claude       OpenCode
               OMP            PI            ...
```

Execution stays on your machines. Repositories stay on your machines. Agent credentials and model access stay on your machines. Harness Remote coordinates and supervises the work remotely.

## What works today

Harness Remote already gives you a common remote UI for five coding-agent harnesses:

| Harness | Support |
|---|---|
| [OpenCode](https://github.com/sst/opencode) | direct HTTP + managed daemon host |
| [Claude Code](https://code.claude.com/) | ACP bridge |
| [Codex CLI](https://github.com/openai/codex) | ACP bridge |
| [Oh My Pi (OMP)](https://omp.sh/) | ACP bridge |
| [PI](https://pi.dev/) | ACP bridge |

From Android, the web/PWA or the desktop app you can monitor sessions, read streamed progress, send prompts, stop work, select models where supported, inspect agent questions/todos and use the capabilities each harness exposes.

The Harness 3 daemon is now able to represent multiple agent hosts under one stable machine identity and route requests through a single machine connection. Legacy per-harness connections remain supported while the client UI moves to machine-first agent discovery and selection.

## Where it is going

The goal is not just remote chat with coding agents. The goal is a local-first operating layer for **coding work across agents and machines**:

- **Attention plane** — one place for the questions, permissions, failures and completed work that actually need you.
- **Multi-agent machine daemon** — one machine connection, multiple heterogeneous agents, independent lifecycle and failure isolation.
- **Task-oriented execution** — launch work against a repository instead of manually preparing every agent session.
- **Worktree isolation** — concurrent tasks get isolated Git workspaces rather than colliding in one checkout.
- **Finish-work loop** — diff → tests → review → PR as a first-class workflow.
- **Multi-machine fleet** — supervise and eventually route work across desktops, laptops and servers without moving credentials or repositories into a hosted control plane.

See [docs/HARNESS_3_ROADMAP.md](docs/HARNESS_3_ROADMAP.md) for the architecture and implementation roadmap.

## Why local-first

Coding agents are most useful where the repositories, build tools, local models, subscriptions and credentials already are. Harness Remote keeps that execution boundary intact and adds the missing remote control layer on top.

That means you can leave a workstation or server doing the work while you use another device to check progress, answer the agent, stop a bad run or start the next step.

## Clients

- **Android** — native Capacitor app.
- **Web / PWA** — installable web client published from this repository.
- **Desktop** — Electron builds for Windows, macOS and Linux.

Current screenshots:

<table>
  <tr>
    <th width="50%">Sessions</th>
    <th width="50%">Detail</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/sessions.jpg" alt="Harness Remote sessions view"></td>
    <td><img src="docs/screenshots/detail.jpg" alt="Harness Remote session detail"></td>
  </tr>
</table>

## Quick start

For the current one-command launcher:

```bash
npx github:giuliastro/harness-remote
```

It detects supported local agents and starts the appropriate Harness Remote path. OpenCode can be launched as a managed host; ACP-backed agents use the local bridge/daemon.

For releases and packaged clients, see [GitHub Releases](https://github.com/giuliastro/harness-remote/releases/latest).

## Documentation

The previous full README — including detailed OpenCode, OMP, PI, Claude Code and Codex setup, Android/Desktop/PWA notes, security caveats, endpoints and build instructions — is preserved as [REFERENCE.md](REFERENCE.md).

Other useful docs:

- [Harness 3 roadmap](docs/HARNESS_3_ROADMAP.md)
- [Harness dependency notes](docs/DEPENDENCIES.md)
- [Contributing](CONTRIBUTING.md)

## Project status

Harness Remote is evolving from a multi-harness remote client into a local-first control plane. The repository deliberately keeps backward compatibility while that transition lands in small, reviewable slices.

If that is a problem you have too — several coding agents, several machines, and too much terminal babysitting — issues and feedback are especially useful now.
