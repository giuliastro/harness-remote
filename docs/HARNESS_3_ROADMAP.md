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

The machine primitive is the Universal Daemon:

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

The daemon now provides stable machine identity, multiple agent-host representation, project/task foundations and fleet-safe ownership boundaries. Machine-scoped identifiers should continue to be designed so a second or third machine can be added without redefining the model.

### Task, run and session are different layers

A **session** is a backend-native conversation/execution context. It is transient execution state owned largely by the underlying harness.

A **task** is Harness-owned durable work. It should survive and organize the backend execution beneath it:

```text
Task
├── goal / prompt
├── placement
│   ├── machine
│   ├── project
│   ├── agent
│   └── workspace/worktree
├── runConfig
│   ├── model / variant
│   ├── agent or sub-agent mode
│   ├── attachments / initial context
│   └── future capability-specific run options
├── run history
│   └── one or more backend sessions/runs
├── result / diff / checks / review state
└── finish state
```

The distinction is intentional:

- a session answers **“what is this harness process/conversation doing now?”**;
- a task answers **“what work did the user ask Harness to accomplish, where and how should it run, what happened, and is it finished?”**.

Task placement and task execution configuration are separate concerns. `machine/project/agent/workspace` answers **where** work runs; `runConfig` answers **how** the selected agent should run it.

`runConfig` must be capability-aware rather than pretending every backend exposes the same controls. A choice should only be offered when the target agent can honour it, and persisted choices should make relaunch/retry reproducible.

The long-term product direction is **Task-first, not Session-first**. Direct session creation remains available while it provides functionality, backend compatibility or a quick unmanaged interaction that Tasks do not yet cover. It should be demoted only after Task creation is a practical functional superset of the useful direct-session configuration for supported agents.

The intended relationship is:

```text
Task → Run → backend Session
```

not:

```text
Task = Session + extra dropdowns
```

## 6. Current implementation status

As of August 14, 2026:

- ✅ **#147 — One-command startup** is complete.
- ✅ **#143 — Universal Daemon** is complete as an implementation milestone. Its architecture and mechanics are well covered by tests, but a real ACP-backed harness still needs to be run end to end before heterogeneous daemon compatibility is described as validated.
- 🟡 **#145 — Create work** now has a working Android/OpenCode task path and most backend foundations complete: project discovery, normalized tasks, isolated worktrees, agent launch, persisted task/run linkage, restart reconciliation, safe cleanup, result inspection and explicit finish semantics. Task/run configuration parity remains incomplete; #173 tracks the structural gap and #176 is the first model-selection slice.
- ✅ **#163 — Finish-work result and safe finalization primitives** is complete through #164.
- ⏳ Full review/tests/PR lifecycle remains ahead.
- ⏳ **#146 — Multi-machine Fleet** remains the next major differentiating product milestone after Task creation is reliable enough to be the primary unit of work and fleet demand is validated.

The product should not claim a complete Task-first workflow merely because Task launch works. Before direct Session creation is demoted, Task creation must preserve the meaningful per-run choices users already rely on.

## 7. Execution sequencing

The roadmap has two dependency tracks, but **not an assumption of parallel maintainer capacity**. When capacity conflicts, Product/Adoption work wins.

### Primary track — Product / Adoption

#### Completed foundation — #147 + #143

One-command startup and the Universal Daemon established the adoption/runtime base:

- low-friction startup;
- stable machine identity;
- multiple heterogeneous local agent hosts;
- isolated host health/failure;
- backward-compatible single-backend paths;
- fleet-safe machine boundaries.

The architecture/mechanics are implemented, but real heterogeneous multi-host validation still requires at least one reachable ACP-backed harness environment. Test doubles are evidence for the architecture, not proof of real harness compatibility.

#### Current — finish #145 as a Task-first product workflow

The backend loop supports:

```text
project → task → isolated worktree → agent → run → result → finish
```

That loop describes lifecycle and placement but is not sufficient by itself. Task creation also needs an explicit, capability-aware execution configuration:

```text
Task = goal + placement + runConfig + lifecycle
```

The immediate product work is therefore:

- choose a known project;
- enter a task goal;
- choose/resolve the target agent and machine;
- configure the run using the options the selected agent actually supports;
- prepare/start the isolated task;
- open the resulting run/session;
- inspect the result and finish safely.

#173 is the structural parity issue. Model/variant selection is the first slice; sub-agent/agent mode, attachments/initial context and future backend-supported run options should travel through the same `runConfig` channel instead of being added as unrelated Task fields.

Several tasks should eventually be usable concurrently in separate worktrees. Explicit agent selection is enough initially. `Auto` routing remains later.

#### Next differentiating milestone — Multi-machine Fleet (#146)

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
Model      agent-supported choice/default
Workspace  New worktree
```

Automatic machine selection comes later.

#### Finish-work expansion — review / tests / PR

The first backend finish primitives are complete, but the competitive loop is not:

```text
run → diff → tests/checks → review → PR → CI visibility → finish
```

These should continue incrementally after the Task contract is sound and alongside/after the first Fleet milestone, without coupling the core task model to one forge too early.

#### Later — Coordinate

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

## 8. Zero-config principles

Setup is part of the product.

- the shortest path should be obvious and measured;
- the user should not need to understand one host/port/server process per backend;
- non-loopback exposure must remain authenticated;
- agent/provider credentials must never be printed or centralized;
- unusual environments retain explicit advanced overrides;
- future pairing should simplify authentication without weakening it.

## 9. Security principles

- credentials remain on execution machines;
- source code does not need to be centralized;
- filesystem roots stay explicit;
- no unauthenticated non-loopback exposure;
- machine identity/pairing must preserve or strengthen authentication;
- deferred permissions ship only where real protocol evidence supports them;
- future relay design should not require plaintext access to source, prompts or output;
- LAN/VPN/self-hosted paths remain valid.

## 10. What not to optimize for

Do not prioritize:

- raw harness count as a growth metric;
- another generic kanban board;
- worktrees marketed as unique differentiation;
- a polished Inbox built on incomplete attention data;
- smart routing before reliable task launch;
- a hosted cloud backend before local value is excellent;
- a greenfield rewrite without implementation evidence;
- multi-machine implementation before demand is validated;
- adding session features to Tasks one field at a time without a coherent `runConfig` contract.

## 11. Validation gates

The roadmap should remain falsifiable.

Before the multi-agent daemon is described as validated:

- run at least one real ACP-backed harness end to end against it. Test doubles validate architecture and mechanics; they are not evidence of real harness compatibility.

Before direct `New Session` is demoted from the normal workflow:

- Task creation must be a practical functional superset of the useful direct-session configuration for supported agents;
- at minimum, capability-aware run configuration must preserve the choices users depend on rather than silently falling back to backend defaults;
- legacy/direct session workflows must remain available where the daemon or backend cannot yet satisfy the Task contract.

Before #146 becomes the largest build:

- validate real multi-machine demand.

Before backend-specific deferred permission behavior ships:

- validate deferred approval behavior against real ACP-backed harness environments rather than only test doubles.

Before hosted relay or automatic routing:

- prove that users value the local task/fleet graph enough for routing/connectivity to compound rather than distract.

## 12. Current priority order

Status lives in §6; this section expresses ordering only.

```text
PRIMARY
#147  One-command startup
  ↓
#143  Universal Daemon
  ↓
#145  Reliable Task-first workflow
  ↓
#173  Capability-aware runConfig / direct-session parity
  ↓
#146  Multi-machine Fleet (after demand validation)
  ↓
       Diff / tests / review / PR / CI lifecycle
  ↓
       Auto machine + agent routing / orchestration

SECONDARY / NON-BLOCKING
#141 Track A → #142 → #132
#141 Track B ─────────→ ACP permission policy
```

This ordering does **not** require every possible session knob before Fleet. It requires the Task model to have the correct extensible contract and the important currently-used choices to work, so Fleet is built on the durable unit of work rather than on a temporary launch wrapper.

## 13. Success test

Harness is succeeding when users describe it as **the place they run and manage agent work**, not merely the app they use to remote into one coding session.

The strongest product test is not whether Harness supports the most agents. It is whether one workflow remains useful as the user changes agents, projects and machines while local execution stays under their control.

A useful product-level test is:

> Would a normal user choose `New Task` for essentially all meaningful coding work, and use direct `New Session` only for a quick unmanaged interaction or legacy compatibility?

When the answer is yes across supported agents, Session has become an execution detail rather than the primary unit of work.
