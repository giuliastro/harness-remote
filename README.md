# Harness Remote

**Run and supervise AI coding agents on the machines where your code already lives, from anywhere.**

Harness Remote is a **local-first control plane for AI coding agents**. Connect to the machine where your code and credentials already live, then supervise OpenCode, Claude Code, Codex CLI, Oh My Pi and PI from one interface on phone, web or desktop.

**One interface. Multiple agents. Your machines, your credentials, your code.**

> Harness Remote is not another coding agent. It is the control plane above them.

Execution stays on your machines. Repositories stay on your machines. Agent credentials and model access stay on your machines. Harness Remote coordinates and supervises the work remotely.

## Quick start

There are currently two supported server paths. **The per-harness bridge is the stable compatibility path used by the current release.** The machine daemon is the newer path and is still being expanded.

### Stable per-harness bridge

Use this when you want the same connection model as the current stable clients: one configured server per harness.

From a checkout of this repository:

```bash
# Oh My Pi / OMP
node bridge/src/cli.js \
  --backend omp \
  --host 0.0.0.0 \
  --port 4097 \
  --username harness \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

```bash
# PI
node bridge/src/cli.js \
  --backend pi \
  --host 0.0.0.0 \
  --port 4097 \
  --username harness \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

The PI bridge uses `@automatalabs/pi-acp@0.2.5` by default. Claude Code and Codex CLI use the same bridge with `--backend claude` and `--backend codex` respectively. OpenCode continues to support its direct HTTP server path.

Then install a client from [GitHub Releases](https://github.com/giuliastro/harness-remote/releases/latest) and configure the matching harness with that host, port and credentials.

### Experimental machine daemon / one-command launcher

```bash
npx github:giuliastro/harness-remote
```

The launcher detects supported CLIs on `PATH`, chooses a primary ACP backend, can start OpenCode as a managed internal host, picks a free public port and prints credentials.

**Current limitation:** one launcher connection does **not yet serve every detected ACP backend simultaneously**. Today the daemon serves the selected primary ACP backend plus managed OpenCode when available. Other ACP CLIs may be detected and printed but are not yet independently routable through that same daemon connection. Use the stable per-harness bridge above for PI, OMP, Claude or Codex when you need deterministic compatibility with the current release.

## What works today

Harness Remote already gives you a common remote UI for five coding-agent harnesses:

| Harness | Stable connection |
|---|---|
| [OpenCode](https://github.com/sst/opencode) | direct HTTP server |
| [Claude Code](https://code.claude.com/) | per-harness ACP bridge |
| [Codex CLI](https://github.com/openai/codex) | per-harness ACP bridge |
| [Oh My Pi (OMP)](https://omp.sh/) | per-harness ACP bridge |
| [PI](https://pi.dev/) | per-harness ACP bridge via `@automatalabs/pi-acp` |

From Android, the web/PWA or the desktop app you can monitor sessions, read streamed progress, send prompts, stop work, select models where supported, inspect agent questions/todos and use the capabilities each harness exposes.

The machine-daemon work adds a stable machine identity and a foundation for routing multiple agent hosts through one connection, but the fully universal multi-ACP path is still in progress. Legacy per-harness connections remain supported and are the compatibility baseline while that migration continues.

The backend task foundation is also in place: the daemon can discover known projects, persist normalized tasks, prepare isolated Git worktrees, launch supported agents inside those workspaces, reconcile run state after daemon restarts, inspect Git results and explicitly release finished worktrees without silently deleting dirty or unmerged work.

These task/worktree/finish primitives are currently **backend/API foundations**. The complete task-first client experience — selecting a project, creating work and reviewing the result directly from the app — is still being built.

## Where it is going

The goal is not just remote chat with coding agents. The goal is a local-first operating layer for **coding work across agents and machines**:

- **Task-first client UX** — expose the existing project/task/worktree/launch primitives as the normal way to create work from phone, web and desktop.
- **Review / PR lifecycle** — extend result inspection into diff, tests/checks, review, PR creation and CI visibility.
- **Multi-machine fleet** — supervise and explicitly place work across desktops, laptops and servers without moving credentials or repositories into a hosted control plane.
- **Attention plane** — one place for the questions, permissions, failures and completed work that actually need you.
- **Fleet attention / Inbox** — turn normalized attention into a useful mobile queue once enough concurrent work exists.
- **Automatic coordination later** — choose machine and agent by availability, capability, workload, cost or rate limits only after explicit task/fleet workflows are reliable.

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

## Documentation

The previous full README — including detailed OpenCode, OMP, PI, Claude Code and Codex setup, Android/Desktop/PWA notes, security caveats, endpoints and build instructions — is preserved as [REFERENCE.md](REFERENCE.md).

Other useful docs:

- [Harness 3 roadmap](docs/HARNESS_3_ROADMAP.md)
- [Harness dependency notes](docs/DEPENDENCIES.md)
- [Contributing](CONTRIBUTING.md)

## Project status

Harness Remote is evolving from a multi-harness remote client into a local-first control plane. The current stable release continues to use the proven per-harness connection model. The one-command launcher, machine daemon and normalized task/worktree/run/finish backend are the migration path toward a unified machine-level control plane, and are still being stabilized before replacing the compatibility path.

The repository deliberately keeps backward compatibility while that transition lands in small, reviewable slices.

If that is a problem you have too — several coding agents, several machines, and too much terminal babysitting — issues and feedback are especially useful now.
