# Harness 3 Product & Architecture Roadmap

> **Status:** product direction, not a promise that every item below will ship exactly as written.
>
> Execution is tracked in [roadmap issue #133](https://github.com/giuliastro/harness-remote/issues/133). Issues and PRs are canonical for implementation scope; this document is canonical for product direction and sequencing rationale.

## 1. Vision

Harness Remote started as a companion for controlling coding agents away from the primary workstation. Remote control remains useful, but it is no longer a sufficient product identity.

Harness should evolve into a **local-first control plane for running AI coding work across the user's machines**.

Codex, Claude Code, OpenCode, OMP, PI and future ACP-compatible agents remain execution engines. Harness owns the workflow above them:

- machines;
- projects and repositories;
- available agents and capabilities;
- tasks, runs and workspaces;
- human attention;
- results and Git lifecycle.

The target hierarchy is:

```text
fleet → machine → project → task → agent run → backend
```

A representative end state is:

```text
3 machines
5 projects
8 active agent runs
2 need attention
```

## 2. Positioning

Vendor-native products will provide excellent experiences for their own agents. Generic multi-agent orchestration is also an established category.

Therefore neither of these is enough by itself:

> use your coding agent from your phone

> one control plane for all coding agents

The sharper proposition is:

> **Run and supervise AI coding work across your machines, from anywhere, while execution and credentials stay on them.**

Remote access becomes a capability of the control plane rather than the category definition.

## 3. Market decision — August 2026

The August 2026 market review changed the sequencing materially.

Observed category facts:

- leading open orchestrators already provide multi-agent boards, worktree-per-task execution, diffs and PR flows;
- worktree isolation and parallel task execution are becoming table stakes;
- mobile orchestration already has entrants;
- vendor apps increasingly supervise concurrent long-running agents;
- ACP adoption makes “support many agents” progressively less defensible as proprietary engineering;
- leading tools reach a useful state from a single command, making setup friction disqualifying rather than cosmetic.

The strongest currently identified underserved position is **multi-machine, vendor-neutral, local-first fleet management**.

That is a wedge hypothesis, not a permanent moat and not yet a proven demand signal. Before making fleet work the largest investment, Harness should validate that a meaningful number of users actually run coding agents across multiple machines.

The compounding advantage should come from the graph Harness can build above the fleet:

> machines × projects × agents × capabilities × tasks × attention × results

## 4. Defensibility

No individual UI component is a moat. Defensibility should come from several layers compounding together.

### Agent neutrality

One workflow should survive changes in agent or vendor.

### Local-first execution

Credentials, source code and agent runtimes stay on execution machines by default.

### Machine/project/task graph

Harness should know where repositories live, which agents are available, which work is running and where results belong.

### Durable task lifecycle

The unit of value should move beyond a chat session:

```text
start → work → attention → verify → review → PR → finish
```

### Universal attention

Questions, permissions, failures and review-ready work should become normalized operational concepts rather than backend-specific UI details.

### Open protocol leverage

ACP and generic adapters should make additional agents cheaper to support. Backend compatibility is infrastructure, not the primary growth story.

## 5. Architecture direction

Evolve the existing `bridge/`; do not casually replace it with a greenfield system.

The long-term machine primitive is a Universal Daemon:

```text
Harness clients
      │
      ▼
Fleet control
      │
      ├── Machine A daemon
      │     ├ AgentHost[codex]
      │     ├ AgentHost[claude]
      │     └ AgentHost[opencode]
      │
      ├── Machine B daemon
      │     ├ AgentHost[codex]
      │     └ AgentHost[omp]
      │
      └── later machines…
```

Each daemon should expose stable machine identity, agent health/capabilities, projects, runs/tasks and an integration point for attention state.

Machine-scoped identifiers must be designed so a second or third machine can be added without redefining the model.

## 6. Execution sequencing

The roadmap has two dependency tracks, but **not an assumption of parallel maintainer capacity**. When capacity conflicts, Product/Adoption work wins.

### Primary track — Product / Adoption

#### P0A — One-command startup (#147)

Ship the cheap adoption win **before** the daemon refactor.

Use the bridge that exists today and provide a thin launcher that can:

- detect/select one supported backend;
- choose a usable port;
- preserve authentication requirements;
- print concise connection information;
- start the existing bridge;
- keep advanced/manual setup available.

Representative experience:

```text
harness-remote

Backend: codex
Connect to: http://192.168.1.20:4097
Username: harness
Password: ...
```

This milestone deliberately does not require the multi-agent daemon.

#### P0B — Universal Daemon (#143)

After first-run friction is reduced, evolve the bridge into one machine-level multi-agent runtime.

Core goals:

- one daemon represents multiple local agent hosts;
- stable machine identity;
- safe agent discovery;
- isolated per-host health/failure;
- fleet-safe API shapes;
- backward-compatible migration from current bridge use;
- integration boundary for the Attention Plane.

Real heterogeneous multi-host validation requires at least one reachable ACP-backed harness environment. Test doubles may validate architecture/mechanics, but they must not be presented as proof of real harness compatibility.

#### P1 — Create work (#145)

Harness must create work, not only observe sessions started elsewhere.

Minimum category-entry loop:

```text
project → task → isolated worktree → agent → run
```

Several tasks must be able to run concurrently in separate worktrees. Worktree isolation without concurrency delivers the mechanism but not the reason the category uses it.

Explicit agent and machine selection is enough initially. `Auto` routing comes later.

#### P1B — Finish work

A tightly following milestone should close the competitive loop:

```text
run → diff → tests/checks → review → PR
```

Keep this separate from #145 if necessary to ship sooner, but do not describe task launch alone as the complete table-stakes experience.

#### P2 — Multi-machine Fleet (#146)

Before implementation becomes the largest roadmap investment, validate demand cheaply with existing users/contributors:

- do they run coding agents on more than one machine?
- which combinations: workstation/laptop/server/VM?
- would one control surface materially change their workflow?

If demand is validated, Harness should aggregate multiple machine daemons while keeping code and credentials local.

Initial placement can be explicit:

```text
Task       Fix issue #200
Machine    Workstation
Agent      Codex
Workspace  New worktree
```

Automatic machine selection comes later.

#### P3 — Coordinate

Only after task/fleet fundamentals are reliable:

- `Auto` agent selection;
- `Auto` machine selection;
- availability/capability/cost/rate-limit/workload-aware routing;
- parallel implementation/review patterns;
- optional E2E relay/self-hosted relay;
- later team/RBAC/audit surfaces.

### Secondary track — Attention

Completed foundations:

- #130 — session UI extraction;
- #131 — normalized `AgentRun`.

Current dependency chain:

```text
#141 Track A mechanics → #142 Attention Plane → #132 Inbox component
#141 Track B real-harness compatibility → backend-specific ACP permission policy
```

#### #141 Track A

Implement hold/expose/answer mechanics using controlled ACP doubles.

The duration contract must remain **parameterized**:

- configurable deadline;
- pluggable expiry/fallback policy;
- reconnect behavior;
- no duplicate/resurrected requests.

Track A proves mechanics, not that real agents can wait indefinitely.

#### #141 Track B

When real ACP-backed environments are reachable, measure Codex, Claude Code, OMP and PI behavior and produce per-backend GO/PARTIAL/NO-GO results.

#### #142 Attention Plane

Build persistent, event-first, backend-neutral attention state. It may proceed without the full Track B matrix; only backend-specific deferred-permission policy remains gated on real evidence.

#### #132 Agent Inbox

The Inbox can ship as a component after #142 for the active connection. It should not become the main product story merely because it exists.

Once daemon/task/fleet work creates meaningful concurrent activity, the same mobile-friendly ordered list can become a strong fleet-level “Needs You” surface.

## 7. Zero-config principles

Setup is part of the product.

- the shortest path should be obvious and measured;
- the user should not need to understand one host/port/server process per backend;
- non-loopback exposure must remain authenticated;
- agent/provider credentials must never be printed or centralized;
- unusual environments retain explicit advanced overrides;
- future pairing should simplify authentication without weakening it.

## 8. Security principles

- credentials remain on execution machines;
- source code does not need to be centralized;
- filesystem roots stay explicit;
- no unauthenticated non-loopback exposure;
- machine identity/pairing must preserve or strengthen authentication;
- deferred permissions ship only where real protocol evidence supports them;
- future relay design should not require plaintext access to source, prompts or output;
- LAN/VPN/self-hosted paths remain valid.

## 9. What not to optimize for

Do not prioritize:

- raw harness count as a growth metric;
- another generic kanban board;
- worktrees marketed as unique differentiation;
- a polished Inbox built on incomplete attention data;
- smart routing before reliable task launch;
- a hosted cloud backend before local value is excellent;
- a greenfield rewrite without implementation evidence;
- multi-machine implementation before demand is validated.

## 10. Validation gates

The roadmap should remain falsifiable.

Before or during P0B:

- obtain at least one reachable ACP-backed harness environment for real integration validation.

Before P2 becomes the largest build:

- validate real multi-machine demand.

Before hosted relay or automatic routing:

- prove that users value the local task/fleet graph enough for routing/connectivity to compound rather than distract.

## 11. Current priority order

```text
PRIMARY
#147  One-command startup
  ↓
#143  Universal Daemon
  ↓
#145  Concurrent task launch + worktrees
  ↓
       Diff / tests / review / PR
  ↓
#146  Multi-machine Fleet (after demand validation)
  ↓
       Auto machine + agent routing / orchestration

SECONDARY / NON-BLOCKING
#141 Track A → #142 → #132
#141 Track B ─────────→ ACP permission policy
```

## 12. Success test

Harness is succeeding when users describe it as **the place they run and manage agent work**, not merely the app they use to remote into one coding session.

The strongest product test is not whether Harness supports the most agents. It is whether one workflow remains useful as the user changes agents, projects and machines while local execution stays under their control.
