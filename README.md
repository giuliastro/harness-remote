# Harness Remote

## Your code stays put. Your work can move between coding agents.

Harness Remote is a local-first control plane for AI coding agents. It connects to the machines where your repositories, CLIs, credentials and subscriptions already live, then gives you one place to start, supervise and continue work from desktop, web or Android.

Use OpenCode, Claude Code, Codex CLI, Oh My Pi and PI without moving your source code or handing your provider credentials to another cloud service.

> Harness Remote is not another coding agent. It is the layer that keeps your project and your work continuous while you use the agents you already trust.

```text
Your machine                         Harness Remote                    Your devices
─────────────                        ──────────────                    ────────────
repository + installed agents  ───>  project + work continuity  ───>  desktop / web / Android
credentials + subscriptions          native-session handoffs
```

## Why Harness Remote

Most coding-agent tools ask you to choose an ecosystem. Harness Remote is built for the moments when that choice should remain yours.

| What you need | What Harness Remote does |
| --- | --- |
| Use the best agent for the next step | Start with one coding agent and continue the same project work with another. |
| Keep the real behavior of each agent | Leaves transcripts, context, tools, permissions, reasoning and resume semantics with the native harness. |
| Work remotely without exporting your environment | Runs on your machines, using your local repositories, logins, subscriptions and runtimes. |
| See one coherent workspace | Keeps the Project, Conversation, native-session chain and working-tree changes visible together. |
| Reach more than one computer | Connect workstations, laptops, servers or VMs without making source code a prerequisite for a central service. |

The result is not a lowest-common-denominator agent UI. It is a control plane that preserves native capability while making the work portable across the agents available to you.

## Get running in three steps

### 1. Start Harness Remote on the machine with your code

Install Node.js 20+ and at least one supported coding-agent CLI, then run:

```bash
npx github:giuliastro/harness-remote \
  --host 0.0.0.0 \
  --port 4097 \
  --username harness \
  --password "use-a-long-unique-password" \
  --root "$HOME/Software"
```

`--root` is the directory boundary Harness Remote may browse when you select projects. Choose the folder that contains the repositories you intend to use.

The launcher detects supported CLIs on `PATH`, starts the appropriate local runtime and prints the connection details. The public machine port is normally **4097**.

### 2. Add the machine from Harness Remote

On desktop, Android or web, open **Machines** and choose **Add machine**. Enter the address, port, username and password printed by the launcher, then select **Test connection**.

One machine connection discovers its projects and the coding agents it exposes. You do not need a separate network endpoint for every harness.

### 3. Open a project and start work

Choose a Project, pick the available agent and model, and begin a Conversation. The work runs in that Project's real directory. Use the **Sessions** view to inspect the native-session chain, and **Changes** to inspect the actual working tree.

For the complete launcher guide, including multi-agent selection, browser access and advanced daemon options, see [Quick start](docs/QUICK_START.md).

## The 3.0 workflow: one piece of work, native sessions underneath

Harness Remote 3.0 introduces a durable product model:

```text
Machine
  Project
    Conversation: "Refactor authentication"
      Native session: explore with OpenCode
      Native session: implement with Codex
      Native session: review with Claude
```

A **Project** is a real workspace on one of your machines.

A **Conversation** is the work you return to: its objective, project association, agent choices and explicit handoffs.

A **native session** is the real session owned by the selected coding agent. Its transcript, tools, memory, context compaction, permission model and runtime behavior remain native.

When you continue with the same agent, Harness Remote resumes the compatible native session when possible. When you continue with another, it creates or resumes that agent's session and supplies an explicit handoff: objective, decisions, unresolved work, relevant changes and checks already run.

Harness Remote never claims that one vendor's hidden memory has magically become another's. It preserves useful continuity while keeping the source of truth honest and inspectable.

## What makes this different

### Change agents without abandoning the work

The right agent can change between exploration, implementation and review. Harness Remote keeps the work anchored to the Project and Conversation, not to a single vendor's session identifier.

### Keep native strengths instead of emulating them

Coding harnesses already differ in tool use, permissions, model controls, transcript structure and memory. Harness Remote orchestrates those capabilities rather than flattening them into a brittle imitation. If a harness advertises a control, it can be surfaced; if it does not, Harness Remote does not invent one.

### Remote control without a cloud migration

Your repositories, agent logins and subscriptions remain on the machine that executes the work. Harness Remote makes them reachable from your devices; it does not require you to upload a project or replace the tooling you have already configured.

### Real workspace, visible changes

Normal Conversations use the selected Project directory. Harness Remote does not silently put routine work in a daemon-managed Git worktree. Isolation is for deliberate parallel work, with a visible lifecycle—not a surprise default.

### One surface for attention and progress

Supervise native work from desktop, web or Android. Follow output and activity, handle supported questions or permissions, stop a real native turn, inspect the session chain and review workspace changes from the same product surface.

## Supported coding agents

The launcher recognizes:

- OpenCode
- Claude Code
- Codex CLI
- Oh My Pi (OMP)
- PI

Harness capabilities are intentionally discovered from the running agent. Model catalogs, variants, reasoning controls, session operations and activity representations remain harness-specific where they should be. See the [3.0 capability matrix](docs/V3_HARNESS_CAPABILITY_MATRIX.md) for the current runtime contract and validation scope.

## Clients

- **Desktop (Windows, macOS, Linux):** add the machine endpoint; no browser CORS configuration is needed.
- **Android:** add the same endpoint; Android uses native HTTP transport.
- **Web / PWA:** run `cd web && npm ci && npm run dev`, then allow that exact browser origin with `--cors` on the launcher.
- **GitHub Pages:** the hosted client follows releases from `main`; allow `https://giuliastro.github.io` with `--cors` when using it.

For example, to permit both the hosted client and a local Vite client:

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

`--cors` is needed only by browser clients, not by desktop or Android.

## Local-first, with clear boundaries

`--root` limits the directories Harness Remote exposes for browsing and new-project selection. It is not an operating-system sandbox for a coding agent: a native harness continues to run with the privileges of the account that launched it.

Use a trusted LAN or VPN, keep authentication enabled for non-loopback access, and do not expose the daemon directly to the public internet. The detailed security and backend-specific guidance is in [REFERENCE.md](REFERENCE.md).

## 3.0 candidate status

This branch is the candidate for Harness Remote 3.0. The product experience is usable, but promotion depends on evidence from real installed harnesses: reliable create/resume/stop behavior, transport and reconnect resilience, accurate capability discovery, trustworthy cross-agent handoffs and consistent desktop, web and Android behavior.

The stable `main` branch remains the 2.x line until those release gates pass. This branch keeps compatibility code where existing 2.x users depend on it, but that legacy architecture is not the 3.0 product model.

## Development

Requirements:

- Node.js 20+
- one or more supported coding-agent CLIs on the host machine

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

## Documentation

- [Quick start and launcher options](docs/QUICK_START.md)
- [Harness Remote 3.0 product and architecture roadmap](docs/HARNESS_3_ROADMAP.md)
- [3.0 harness capability matrix](docs/V3_HARNESS_CAPABILITY_MATRIX.md)
- [Dependency and adapter notes](docs/DEPENDENCIES.md)
- [Legacy and backend-specific reference](REFERENCE.md)
- [Contributing](CONTRIBUTING.md)
