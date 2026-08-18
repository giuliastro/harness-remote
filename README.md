# Harness Remote

**Run and supervise AI coding agents on the machines where your code already lives, from anywhere.**

Harness Remote is a local-first control plane for AI coding agents. Connect to a machine where your repositories, CLIs, subscriptions and credentials already live, then supervise OpenCode, Claude Code, Codex CLI, Oh My Pi and PI from one interface on phone, web or desktop.

**One interface. Multiple agents. Your machines, your credentials, your code.**

> Harness Remote is not another coding agent. It is the control plane above them.

Execution stays on your machines. Repositories stay on your machines. Agent credentials and model access stay on your machines.

## Quick start

The v3 / TaskDesk path uses one launcher per machine. The launcher detects supported harness CLIs on `PATH` and chooses the appropriate runtime automatically.

From a checkout or directly from GitHub:

```bash
npx github:giuliastro/harness-remote \
  --host 0.0.0.0 \
  --port 4097 \
  --username harness \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

The important values for a client connection are the machine address, public port, username and password. The normal public port is **4097**.

When the machine has multiple supported harnesses, Harness Remote starts the machine daemon and exposes the detected agents through that one public endpoint. OpenCode can run as a managed internal host, normally on loopback port **4096**. That 4096 port is an implementation detail and should not be entered in the client wizard.

The launcher currently recognizes:

- OpenCode
- Claude Code
- Codex CLI
- Oh My Pi (OMP)
- PI

If only one compatible harness is installed, the launcher may use the single-backend compatibility path automatically. The client setup does not change: connect to the public address printed by the launcher and let the connection wizard discover the available harness.

If `--port` is omitted, the launcher starts from the normal public port and chooses an available port when necessary. If username/password are omitted, it generates credentials and prints them.

### Connecting from the app

Use **Connect server** and follow the connection wizard:

1. choose the harness you want to expose as that saved profile;
2. enter the host running Harness Remote;
3. use the public daemon port, normally `4097`;
4. enter the credentials printed by the launcher;
5. test the connection and save.

The wizard discovers the machine and routes the saved profile to the selected harness. Multiple profiles may point to the same machine and public port while selecting different harnesses.

For example, one machine can appear in the client as separate saved profiles for OpenCode, Codex, Claude, OMP and PI, while all of them use the same `host:4097` endpoint.

## Using the clients

All clients use the same connection wizard and the same machine endpoint.

- **Desktop (Windows, macOS, Linux):** install a desktop build from GitHub Releases, open Harness Remote, choose **Connect server**, and enter the machine address, public port and credentials printed by the launcher. Desktop does not need browser CORS configuration.
- **Android APK:** install the APK, open the app, and use the same **Connect server** wizard. Android uses native HTTP transport, so browser CORS restrictions do not apply.
- **Web / PWA:** run the web client locally with `cd web && npm ci && npm run dev`, then open the URL printed by Vite. Because this is a browser client, the daemon must allow that exact web origin with `--cors`.
- **GitHub Pages:** the hosted client is available at `https://giuliastro.github.io/harness-remote/` after deployments from `main`. To connect from it, start the daemon with `--cors https://giuliastro.github.io` in addition to the normal launcher options.

For example, to allow both the hosted GitHub Pages client and a local Vite development client:

```bash
npx github:giuliastro/harness-remote \
  --host 0.0.0.0 \
  --port 4097 \
  --username harness \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software" \
  --cors https://giuliastro.github.io \
  --cors http://localhost:5173
```

`--cors` accepts exact origins and may be repeated. It is needed only by browser-based clients such as the Web/PWA and GitHub Pages builds, not by the native Android or desktop clients.

## Root and project access

`--root` defines the filesystem boundary the remote client is allowed to browse and use. Pick a directory containing the projects you actually want Harness Remote to access, for example:

```bash
--root "$HOME/Software"
```

A path outside that boundary is intentionally rejected.

Manual sessions can still choose a directory inside the configured root. TaskDesk is moving the normal workflow toward selecting a known **Project** and letting the daemon choose the project directory or prepare an isolated Git worktree for the task.

## TaskDesk / v3

The v3 branch is evolving Harness Remote from a remote session viewer into a task-first control plane.

The backend already supports:

- machine identity and agent discovery;
- multiple harnesses behind one machine endpoint;
- per-agent model catalogs;
- persisted projects and tasks;
- Task -> Run -> Session linkage;
- project-directory or isolated Git worktree execution;
- running/completed/failed lifecycle state;
- restart reconciliation;
- result/workspace inspection and explicit cleanup.

The client UX is being completed and stabilized before v3 replaces the current mainline experience.

The intended product model is:

```text
Machine
  Projects
    Project
      Tasks
        Task
          Run / Session
```

A Task chooses a machine, project, harness and model. For Git projects it can run in an isolated worktree, so the user does not have to type platform-specific filesystem paths from the phone.

## Legacy compatibility

The repository still contains the standalone per-harness bridge and direct OpenCode compatibility code because existing installations and stable releases may depend on them.

Those paths are compatibility mechanisms, not the normal v3 onboarding flow. New v3 connections should use the machine launcher and the connection wizard above.

For low-level legacy setup details see [REFERENCE.md](REFERENCE.md).

## Development

Requirements:

- Node.js 20+
- one or more supported harness CLIs installed on the host machine

Useful commands:

```bash
# Launcher / daemon from a checkout
npm start

# Bridge tests
npm test

# Web client
cd web
npm ci
npm run dev
```

The pull-request CI type-checks and builds the web app, runs the regression suites and bridge tests on Linux/macOS/Windows, and produces a signed debug APK for test branches.

## Documentation

- [Harness 3 roadmap](docs/HARNESS_3_ROADMAP.md)
- [Nitsuga / TaskDesk integration plan](docs/NITSUGA_TASKDESK_INTEGRATION_PLAN.md)
- [Harness dependency notes](docs/DEPENDENCIES.md)
- [Legacy/full reference](REFERENCE.md)
- [Contributing](CONTRIBUTING.md)

## Project status

Harness Remote is moving toward a machine-first, task-first model while keeping compatibility with existing per-harness installations during the transition.

The immediate v3 goal is stability: every supported harness must route to the correct sessions and models, task launch must preserve project/workspace ownership, web and Android must behave consistently, and the exact candidate SHA must pass real-device testing before promotion to `main`.
