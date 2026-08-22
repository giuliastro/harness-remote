# Harness Remote

**Run and supervise AI coding agents on the machines where your code already lives, from anywhere.**

Harness Remote is a local-first control plane for AI coding agents. Connect the machines where your repositories, CLIs, subscriptions and credentials already live, then use OpenCode, Claude Code, Codex CLI, Oh My Pi and PI from one interface on phone, web or desktop.

**Your projects. Any coding agent. One workspace.**

> Harness Remote is not another coding agent. It is the control plane above them.

Execution stays on your machines. Repositories stay on your machines. Agent credentials and model access stay on your machines.

## Harness Remote 3.0

Harness Remote 3.0 is conversation-first. It does not recreate the Session model already provided by modern coding agents.

The product model is:

```text
Machine
  Projects
    Project
      Conversations
        Conversation
          Native Session: OpenCode
          Native Session: Codex
          Native Session: Claude
```

A **Conversation** is a thin continuity layer above real native Sessions. It keeps one piece of work easy to return to while the underlying coding agent remains responsible for its own Session history, streaming, tools, reasoning, permissions and memory.

The important capability is agent independence:

1. start a Conversation with the coding agent and model you want;
2. work in the real project directory;
3. continue the same Conversation with another coding agent when useful;
4. Harness Remote creates or resumes the target agent's native Session and carries the continuity context across;
5. inspect the native Sessions and project Changes without replacing the harness transcript with a second chat protocol.

A normal Conversation does **not** create a hidden Git worktree. Isolation can be added explicitly for true parallel work, but it is not the default workspace model.

## Quick start

Harness Remote uses one launcher per machine. The launcher detects supported coding-agent CLIs on `PATH` and exposes them behind one machine endpoint.

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

The launcher currently recognizes:

- OpenCode
- Claude Code
- Codex CLI
- Oh My Pi (OMP)
- PI

When several supported agents are installed, they all remain behind the same machine endpoint. OpenCode can run as a managed internal host, normally on loopback port **4096**. Port 4096 is an implementation detail and should not be entered as the public machine port.

If `--port` is omitted, the launcher starts from the normal public port and chooses an available port when necessary. If username/password are omitted, it generates credentials and prints them.

## Connecting a machine

Open **Machines**, choose **Add machine**, and enter the address, public port and credentials printed by the launcher. Use **Test connection** before saving.

Harness Remote then discovers the machine, its projects and all supported coding agents through that one connection. You do not create a separate connection profile for every harness.

The same machine configuration is used by desktop, Android and web clients.

## Using the clients

- **Desktop (Windows, macOS, Linux):** install a desktop build, open **Machines**, and add the daemon address printed by the launcher. Desktop does not need browser CORS configuration.
- **Android APK:** install the APK and add the same machine endpoint. Android uses native HTTP transport, so browser CORS restrictions do not apply.
- **Web / PWA:** run the web client locally with `cd web && npm ci && npm run dev`, then open the URL printed by Vite. Because this is a browser client, the daemon must allow that exact web origin with `--cors`.
- **GitHub Pages:** the stable hosted client follows releases from `main`. To connect from it, allow the hosted origin with `--cors https://giuliastro.github.io`.

For example, to allow both the hosted client and a local Vite development client:

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

`--cors` accepts exact origins and may be repeated. It is needed only by browser clients, not by native Android or desktop clients.

## Root and project access

`--root` defines the filesystem boundary the remote client is allowed to browse and use. Pick a directory containing the projects Harness Remote may access, for example:

```bash
--root "$HOME/Software"
```

A path outside that boundary is intentionally rejected.

The normal 3.0 workflow selects a known **Project** and starts its Conversation in that project's real directory. Harness Remote does not silently relocate normal work into a daemon-managed worktree.

## Conversation continuity

Each coding agent keeps its own native Session format and behavior.

When a Conversation continues with the same agent, Harness Remote resumes the most recent compatible native Session when possible. When it continues with another agent, Harness Remote creates or resumes that agent's native Session and transfers explicit continuity context.

If a previously persisted native Session is no longer available, Harness Remote can create a new native Session and continue from the persisted conversation context rather than exposing an implementation-level Session ID failure to the user.

The **Sessions** tab makes this chain visible. The **Changes** tab stays grounded in the current project workspace and native Session.

## What remains native

Harness Remote should orchestrate capabilities that coding agents already implement instead of cloning them. Native Session history, context compaction, tool execution, reasoning, permission requests, questions, model behavior and harness-specific memory remain owned by the harness whenever possible.

Harness Remote adds the layer that an individual harness cannot provide by itself:

- one machine connection for multiple coding agents;
- one project workspace across agents;
- one Conversation that can continue through several native Sessions;
- agent and model switching from the same interface;
- remote supervision from desktop, web and Android;
- local execution with the user's existing credentials and subscriptions.

## Legacy compatibility

The repository still contains lower-level bridge and compatibility code because stable 2.x installations may depend on it. Those paths are not separate product modes in the 3.0 interface.

For low-level legacy setup details see [REFERENCE.md](REFERENCE.md).

## Development

Requirements:

- Node.js 20+
- one or more supported coding-agent CLIs installed on the host machine

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

Pull-request CI type-checks and builds the web app, runs regression and bridge tests on Linux/macOS/Windows, verifies the desktop application menu and produces a signed debug APK for test candidates.

## Documentation

- [Harness 3 roadmap](docs/HARNESS_3_ROADMAP.md)
- [Harness dependency notes](docs/DEPENDENCIES.md)
- [Legacy/full reference](REFERENCE.md)
- [Contributing](CONTRIBUTING.md)

## Project status

The 3.0 release-candidate path is moving Harness Remote from a remote Session viewer to a conversation-first universal agent control plane.

The release gate is practical: each supported harness must route to the correct native Sessions and models, cross-agent continuation must preserve useful context, the project workspace must remain predictable, desktop/web/Android must behave consistently, and the exact candidate SHA must pass both automated checks and real-harness manual testing before promotion.