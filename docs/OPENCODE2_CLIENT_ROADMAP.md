# OpenCode 2 Client Feature Roadmap

> **Status:** active implementation backlog for the OpenCode 2 client.
>
> GitHub issues and pull requests are canonical for scope and implementation. This document tracks sequencing, dependencies, and overall progress.

## Goal

Bring the remote OpenCode 2 experience closer to the native client without weakening Harness Remote's web, desktop, Android, multi-agent, or local-first design.

OpenCode owns execution, sessions, plugins, permissions, tools, and credentials. Harness Remote should expose those capabilities remotely with clear state, safe controls, and graceful behavior when a backend cannot provide equivalent data.

## Status Legend

| Status | Meaning |
|---|---|
| Planned | Scoped in an issue but implementation has not started |
| In progress | An implementation PR is open or active work is underway |
| Blocked | Progress requires an upstream API or another roadmap item |
| Shipped | Merged and available on the default branch |

## Current Baseline

The OpenCode 2 client already supports sessions, streamed messages, prompts, interruption, model and agent selection, commands, questions, permissions, attachments, filesystem browsing, and working-copy diffs.

The remaining work is primarily richer visibility and control. Model execution and agent tools already run on the OpenCode server regardless of which Harness Remote client is connected.

## Progress

| Phase | Issue | Feature | Status | Depends on |
|---|---:|---|---|---|
| 1 | [#3](https://github.com/nitsuga/harness-remote/issues/3) | Classify commands and support explicit skill activation | Shipped | - |
| 1 | [#4](https://github.com/nitsuga/harness-remote/issues/4) | Add compact and fork session actions | Planned | - |
| 1 | [#5](https://github.com/nitsuga/harness-remote/issues/5) | Support session import and export | Planned | - |
| 1 | [#6](https://github.com/nitsuga/harness-remote/issues/6) | Show and manage MCP server status | Planned | - |
| 2 | [#7](https://github.com/nitsuga/harness-remote/issues/7) | Derive and display persistent session todos | Planned | - |
| 2 | [#8](https://github.com/nitsuga/harness-remote/issues/8) | Expose richer session activity and attention states | Planned | - |
| 2 | [#9](https://github.com/nitsuga/harness-remote/issues/9) | Build a cross-session attention inbox | Planned | #8 |
| 3 | [#10](https://github.com/nitsuga/harness-remote/issues/10) | Visualize background subagents and delegated tasks | Planned | #8, #9 |
| 3 | [#13](https://github.com/nitsuga/harness-remote/issues/13) | Render structured message and tool parts richly | Planned | - |
| 3 | [#14](https://github.com/nitsuga/harness-remote/issues/14) | Research and provide accurate per-message diffs | Planned | #13 |
| 4 | [#11](https://github.com/nitsuga/harness-remote/issues/11) | Add an authenticated remote PTY terminal | Planned | - |
| 4 | [#12](https://github.com/nitsuga/harness-remote/issues/12) | Expose task and worktree workflows in the client | Planned | #8, #9 |

Progress: **1 of 12 shipped**.

## Delivery Phases

### Phase 1: Quick parity wins

Ship small, independently reviewable additions that map directly to OpenCode 2 APIs and existing Harness Remote UI patterns.

- Skills and commands
- Compact and fork
- Import and export
- MCP visibility and management

### Phase 2: Reliable supervision state

Build a durable state model before adding richer multi-agent presentation.

- Reconstructed session todos
- Busy, waiting, failed, completed, and needs-attention states
- Cross-session questions, permissions, failures, and completion inbox

### Phase 3: Rich execution visibility

Improve how agent work and historical results are represented.

- Background subagent and delegated-task hierarchy
- Structured message and tool-part rendering
- Accurate per-message diff research and implementation

### Phase 4: Full remote workspace control

Add larger interactive workflows after supervision state is reliable.

- Authenticated PTY terminal
- Task and worktree creation, execution, review, finish, and safe cleanup

## Implementation Principles

- Keep each feature in its own issue and PR unless a dependency makes separation artificial.
- Prefer documented OpenCode 2 API state over client-side inference.
- Label reconstructed or incomplete state honestly.
- Preserve backend-neutral UI and types where the concept applies to other harnesses.
- Make unsupported capabilities explicit rather than silently degrading behavior.
- Treat web, desktop, and Android behavior as part of acceptance, not follow-up polish.
- Add captured wire fixtures and regression tests because the OpenCode 2 API is experimental.
- Never expose server credentials, provider credentials, or sensitive raw payload fields in the UI.

## Progress Updates

Update this document in the PR that changes an item's status:

1. Mark the item `In progress` when the first implementation PR opens.
2. Link the PR from the feature issue.
3. Mark the item `Shipped` and update the shipped count when the PR merges.
4. Record a short blocker in the issue and mark the item `Blocked` when upstream behavior prevents progress.
5. Add newly discovered work to an existing issue when it belongs to that scope; create a new issue only for an independently deliverable feature.

## Related Documents

- [Harness 3 Product & Architecture Roadmap](HARNESS_3_ROADMAP.md)
- [Harness dependency notes](DEPENDENCIES.md)
- [Contributing guide](../CONTRIBUTING.md)
