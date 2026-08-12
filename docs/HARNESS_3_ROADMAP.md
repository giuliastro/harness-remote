# Harness 3 Product & Architecture Roadmap

> **Status:** product direction, not a promise that every item below will ship exactly as written.
>
> Execution is tracked in [roadmap issue #133](https://github.com/giuliastro/harness-remote/issues/133).

## 1. Vision

Harness Remote started as a companion application for controlling coding-agent harnesses away from the primary workstation. That capability remains useful, but it is no longer a sufficient product identity.

The goal is to evolve Harness into a **local-first operating/control plane for AI coding agents**.

Harness should sit above Codex, Claude Code, OpenCode, OMP, PI and future ACP-compatible agents. Those products remain the execution engines; Harness becomes the durable workflow around them.

The product should eventually let a user:

- see all active agent work in one place;
- know which agent needs human attention without opening every session;
- start work remotely, not only observe existing sessions;
- organize work around projects and tasks rather than backend names;
- operate agents across one or more machines;
- review changes and complete the Git/PR lifecycle;
- keep execution, credentials and source code local by default;
- switch underlying agents without rebuilding the surrounding workflow.

A representative end-state summary is:

```text
3 machines
5 projects
8 active agent runs
2 need attention
```

The product should feel like the place where **agent work is managed**.

## 2. Positioning and category

Harness should avoid competing with individual coding agents on their native strengths.

Codex can become the best Codex environment. Claude Code can become the best Claude environment. OpenCode and other harnesses should keep innovating independently.

Vendor-specific products are also strongly incentivized to build excellent remote experiences for their own agents. Therefore:

> **"Use your coding agent from your phone" is not a durable moat.**

Harness should own the layer those vendors are not naturally incentivized to make neutral:

```text
                       Harness
                          │
            Attention / Tasks / Git / Policy
                          │
                 Universal Daemon
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
      Codex           Claude Code        OpenCode
        │                 │                 │
       OMP               PI          future ACP agents
```

The proposition is:

> **one local-first operating/control plane for all of your coding agents.**

Remote access becomes a capability of the control plane rather than the whole identity of the product.

### 2.1 Market context — August 2026

The positioning above is argued from first principles. This subsection records the observable state of the category so the argument can be re-checked rather than assumed, and so a later reader can tell which conclusions were evidence and which were belief. It should be dated and revised, not quietly deleted.

- The most-starred open orchestrator in this category is at roughly **27,500 stars** and installs with a single `npx` command; moving a task card creates an isolated worktree, starts the linked agent, captures diffs and logs, and can open a pull request. Its parent company shut down in April 2026 and it continues community-maintained.
- **Worktree-per-task parallelism is table stakes**, not differentiation. Numerous desktop orchestrators ship it, and JetBrains added first-class worktree support in 2026.1.
- **Mobile orchestration already has entrants.** At least two products ship phone apps that supervise agents executing on the user's own machine, one of them with a touch-optimised board and worktree per card.
- **Vendors own single-agent supervision.** A dashboard for parallel sessions shipped in May 2026 for one major agent, and a competing vendor's app is built explicitly around supervising concurrent long-running agents.
- **ACP adoption is broad**: 25+ agents by March 2026, adoption by JetBrains, Google and GitHub, and a registry since January 2026.

Three implications for this document:

**The category statement in section 2 is now the consensus position, not a wedge.** "One control plane for all of your coding agents" describes what several funded products already claim. It remains the correct description of the product; it is no longer, by itself, a reason anyone would choose it.

**Setup friction is disqualifying rather than unfortunate.** Section 8 treats zero-config as a direction. Against a competitor that reaches a working board in one command, it is the precondition for being evaluated at all. Every layer built above a multi-step setup is built for users who never arrive.

**Multi-machine is the one claim in this document with no visible incumbent.** Every orchestrator observed runs agents on the machine running the app. The success criteria in section 13 open with `3 machines`, and that line — combined with agent neutrality, which vendors will not adopt, and local-first, against a broadly cloud-shaped market — is the sharpest available answer to "why this and not the leader".

Sources for the above are collected in the market-check comment on issue #133.

## 3. Where defensibility should come from

No single UI component is a moat. The defensible product should come from several layers compounding together.

### 3.1 Agent neutrality

One workflow should survive changes in model/vendor/agent. Backend identity remains visible when it matters but should not dictate the primary navigation model.

### 3.2 Universal attention

Harness should normalize the moments where autonomous work needs a human:

- permission required;
- question / decision required;
- failure;
- completed work awaiting review;
- later, policy violations, machine problems or stale/unreachable work.

The user-facing concept should be:

> **This agent run needs you.**

not "this OpenCode-specific endpoint returned a question".

### 3.3 Local machine/project graph

Harness should know which supported agents exist on a machine, which projects/repositories are available, which runs belong to them and what state they are in.

This local context is useful precisely because it spans competing agents.

### 3.4 Durable task lifecycle

The long-term unit of value is not a chat session. It is a task:

```text
start → work → human attention → verify → review → PR → finish
```

Harness should progressively own more of this lifecycle above agent sessions.

### 3.5 Open protocol leverage

ACP and generic adapters should make future agents progressively cheaper to integrate. Harness should avoid building its moat from a pile of one-off integrations that have to be rewritten every time a vendor changes.

## 4. Product principles

### Project- and task-centric

The hierarchy should move from:

```text
backend → session
```

Toward:

```text
project → task / agent run → machine → backend
```

### Attention first

As work becomes asynchronous, the first question is not "which session do I open?" but:

> **Which agent needs me now?**

### Local-first

Agent execution and credentials stay on the user's machine by default. A hosted relay may improve connectivity later, but local/LAN operation must remain useful without it.

### Capability-aware

Normalize shared concepts without forcing every backend into a fake lowest common denominator.

### Event-first where possible

Attention and operational state should prefer push/event-driven collection over expensive background fan-out. Mobile performance is a product requirement, not an implementation detail.

### Progressive complexity

One-machine, multi-agent control should become excellent before adding unnecessary multi-machine or orchestration complexity.

## 5. Core architecture

The existing `bridge/` is the seed of the future architecture, not something to discard casually.

It already contains useful foundations:

- ACP client/service logic;
- harness profiles;
- capability differences;
- history/session normalization;
- HTTP/SSE transport;
- backend-specific lifecycle handling.

The target is a **Universal Daemon**:

```text
Harness clients
 phone / web / desktop
          │
          ▼
    Universal Daemon
          │
          ├── AgentHost[codex]
          ├── AgentHost[claude]
          ├── AgentHost[omp]
          ├── AgentHost[pi]
          └── AgentHost[opencode]
          │
          ├── Attention Plane
          ├── Projects
          └── later: Tasks / Git lifecycle
```

One daemon connection should eventually represent one machine and all of its supported agents.

## 6. Attention Plane

The Agent Inbox is a user interface. The important infrastructure is the Attention Plane underneath it.

Today, attention data is incomplete:

- question/permission data is mainly loaded when a session is opened;
- OpenCode exposes more direct interaction capability than the current ACP-backed bridge profiles;
- the bridge auto-approves ACP permission requests today;
- saved server profiles are switched rather than observed as one local agent fleet.

This is why the roadmap now inserts two steps before the Inbox:

- [#141 — validate deferred ACP permission behavior](https://github.com/giuliastro/harness-remote/issues/141)
- [#142 — build a backend-neutral Attention Plane](https://github.com/giuliastro/harness-remote/issues/142)

The desired lifecycle is:

```text
raised → pending → answered/acknowledged → cleared
```

The store/read API should work without opening session detail and should be suitable for eventual ownership by the Universal Daemon.

### Deferred permissions

Human approval is strategically interesting because it turns Harness from passive remote viewing into a real control layer and can improve the current silent auto-approval security model.

But protocol behavior must be measured first.

#141 explicitly tests whether Codex, Claude Code, OMP and PI can safely wait for a delayed ACP permission response and recover from allow/deny/disconnect conditions.

Deferred approval should not become a production default unless evidence supports it.

## 7. Target UX

### 7.1 Agent Inbox

Tracked by [#132](https://github.com/giuliastro/harness-remote/issues/132).

```text
NEEDS YOU

Codex · harness-remote
Permission required
npm run release

Claude · customer-api
Question
Use PostgreSQL or SQLite?

WORKING

Codex   Fix reconnect race      6m
OMP     Investigate tests      13m
Claude  Waiting for subagent    4m

RECENT

✓ Codex   PR ready
✓ Claude  Tests passed
✕ PI      Task failed
```

The mock must never outrun real backend capability. If deferred permissions are unavailable for a backend, Harness should not invent them.

The first Inbox may accurately represent the active machine/connection rather than attempting expensive concurrent polling of arbitrary saved profiles. Full local multi-agent aggregation becomes natural with #143.

### 7.2 Projects

Projects become first-class navigation targets:

```text
Harness Remote
~/dev/harness-remote

● 2 working
! 1 needs attention

Codex    Fix reconnect race
Claude   Review architecture
OMP      idle
```

### 7.3 New Task

Harness should eventually create work:

```text
Project
Harness Remote

Task
Fix issue #200, run tests and explain the changes

Agent
Auto / Codex / Claude / OpenCode / OMP / PI

Workspace
New worktree / Existing checkout

[ Start task ]
```

`Auto` can start simple; sophisticated routing belongs later.

### 7.4 Machines

```text
Workstation · Windows
Codex      available
Claude     available
OpenCode   running
OMP        available
3 active tasks
```

### 7.5 Session detail

The current session/chat experience stays useful as a detail view, eventually with clearer operational tabs such as:

```text
Chat | Changes | Tasks | Logs
```

### 7.6 Git / PR lifecycle

Once the daemon owns project context, Harness can add backend-independent value:

```text
agent finished
    ↓
review diff
    ↓
verify tests
    ↓
create PR
    ↓
track CI
    ↓
merge
```

## 8. Zero-config direction

The current setup is too configuration-heavy for broad adoption.

The target experience should approach:

```bash
npm install -g harness-remote
harness
```

then:

```text
Harness daemon
Machine: workstation

Detected agents
✓ Codex
✓ Claude Code
✓ OpenCode
✓ OMP
✓ PI

Projects
✓ ~/dev/harness-remote
✓ ~/dev/customer-api

Ready to pair
```

The user should not normally need to understand separate bridge commands, hostnames, ports and CORS for every local agent.

The first Universal Daemon milestone is tracked by [#143](https://github.com/giuliastro/harness-remote/issues/143).

## 9. Pairing and remote connectivity

Connectivity should be progressive.

### Level 1 — LAN / local

Default path. No account required.

### Level 2 — Existing VPN / private networking

Tailscale and similar tools remain valid.

### Level 3 — Optional Harness Relay

```text
Phone
  │ encrypted
  ▼
Harness Relay
  │ encrypted
  ▼
Local daemon
```

A relay should be designed so it does not require plaintext access to prompts, model output or source code. A self-hostable path should remain possible.

## 10. Security principles

The control-plane direction should improve the current safety posture.

- Agent credentials stay on the execution machine.
- Filesystem access remains explicitly scoped.
- No unauthenticated non-loopback exposure.
- Pairing replaces manual credentials with better UX, not weaker authentication.
- Deferred permission handling requires explicit timeout/disconnect fallback semantics.
- Relay design should not require plaintext access to source, prompts or responses.
- Direct LAN, VPN and self-hosted modes remain valid.
- Later team features can add identity/RBAC/audit without making them mandatory for individual users.

## 11. Roadmap phases

### Phase A — Prove the attention model

Completed:

- [x] #130 — extract session UI from `App.tsx`;
- [x] #131 — normalized `AgentRun` and attention model.

Next:

- [ ] #141 — deferred ACP permission spike;
- [ ] #142 — backend-neutral Attention Plane;
- [ ] #132 — Agent Inbox view.

**Outcome:** on the active machine/connection, Harness can answer **"Which known agent run needs me?"** without requiring every session to be opened and without high-fan-out polling.

### Phase B — Universal Daemon / Zero Config

- [ ] #143 — multi-agent machine daemon.

Then split follow-ups when the architecture is concrete:

- safe agent discovery;
- machine identity;
- QR/code pairing;
- project discovery;
- daemon lifecycle/upgrades;
- migration from per-backend profiles.

**Outcome:** install once, discover agents once, pair once.

### Phase C — Task Control Plane

Planned areas:

- project-centric navigation;
- remote task launch;
- Git worktrees;
- normalized task lifecycle;
- Attention Plane actions and notifications;
- diff/review/tests;
- create PR;
- CI/PR visibility;
- later multi-machine aggregation.

**Outcome:** **start → monitor → steer → review → finish** from one product.

### Phase D — Orchestration

Only after the fundamentals are reliable:

- `Auto` agent selection;
- availability/capability/preference/cost/rate-limit-aware routing;
- parallel runs;
- implementation + independent review patterns;
- quota/cost visibility;
- policies;
- optional E2E relay;
- team/RBAC/audit.

Example:

```text
Task: Fix websocket race

Codex  → implementation
Claude → independent review
Harness → tests, compare results, surface disagreement
```

**Outcome:** Harness coordinates agent capacity rather than merely exposing it.

### Sequencing risks

The phases above are ordered by architectural dependency, which is the right instinct and produces one problem: measured against section 2.1, the work that decides whether anyone evaluates the product sits in later phases than the work that improves it for people who already have.

Three specific tensions, recorded so the ordering is a decision rather than an oversight:

**Zero-config sits in Phase B, behind the attention model.** Nothing in Phase A is reachable by a user who has not already completed a multi-step, per-harness setup. A one-command first run belongs alongside Phase B's daemon at the latest, and arguably in parallel with Phase A, because it changes who can see any of it. A useful internal benchmark: the current setup took the author of this repository most of a working day to complete on a phone.

**Task launch and worktrees sit in Phase C.** Section 2.1 puts them at table stakes. Until Harness can start work rather than only observe work somebody started by hand, it is not in the comparison the category is actually making — however good the Attention Plane is.

**Multi-machine aggregation is a trailing bullet in Phase C** and a declared non-goal in #142 and #143. It is also the only unclaimed position identified in section 2.1. It does not need to be built early, but its boundary should be designed before Phase B hardens a single-machine machine API that later has to be undone.

**Phase A's own gating risk:** #141 requires one of the four ACP-backed harnesses. #142 depends on its outcome and #132 depends on #142, so the whole phase gates on an experiment that cannot run in an OpenCode-only environment, since OpenCode is reached directly over HTTP rather than through the ACP bridge. Splitting it — bridge-side hold/answer/timeout mechanics against the existing ACP test doubles, then the real-harness compatibility matrix when such a harness is reachable — keeps the phase moving without inventing the evidence the spike exists to gather.

## 12. What not to prioritize yet

### Do not optimize for harness count alone

More integrations are useful, but raw compatibility count is not the growth strategy. Prefer protocol leverage and the layer above agents.

### Do not build another coding agent

Harness should orchestrate existing agents rather than reproduce their reasoning/editing stacks.

### Do not build the cloud backend first

Local value must be strong independently.

### Do not ship a fake Inbox

A polished `Needs attention` UI backed by incomplete attention data is worse than a smaller honest milestone.

### Do not add smart routing before task launch works

Routing compounds a reliable task system; it cannot substitute for one.

### Do not prioritize voice/live preview before the operational loop

Potentially useful later, not core differentiation.

### Do not solve multi-machine before one-machine multi-agent is excellent

The Universal Daemon should first make one development machine feel coherent.

### Do not rewrite everything

The transition should remain incremental and preserve the existing remote client throughout.

## 13. Defensibility test

When evaluating a feature, ask:

> **Does this make Harness harder to replace with the native mobile/remote UI of one agent?**

Strong answers include:

- it works across competing agents;
- it uses local machine/project knowledge one vendor does not own;
- it normalizes human attention across agents;
- it creates durable task lifecycle state above sessions;
- it lowers setup friction for the entire local agent fleet;
- it compounds with the Universal Daemon.

A feature that is merely "remote Codex/Claude but nicer" can be useful without being strategically differentiating.

## 14. Success criteria

The transformation is working when users naturally describe Harness as **the place they manage coding-agent work** rather than the app they use to remote into a session.

Signals include:

- users operate multiple supported agents through one local daemon;
- the Attention Plane reliably brings users back at the right moment;
- project/machine identity matters more than backend/server configuration;
- task launch becomes routine;
- a meaningful part of the Git/PR lifecycle happens through Harness;
- adding an ACP-compatible agent requires little or no client redesign.

## 15. Current execution order

```text
#130 ✅
  ↓
#131 ✅
  ↓
#141 permission spike
  ↓
#142 Attention Plane
  ↓
#132 Agent Inbox
  ↓
#143 Universal Daemon
  ↓
Discovery / Pairing / Projects
  ↓
Remote Task Launch / Git lifecycle
  ↓
Orchestration
```

## 16. Questions that should remain open to critique

The roadmap should be challenged continuously, especially on these points:

1. Is **agent-neutral + local-first + universal attention + daemon** distinct enough from vendor-native remote control and existing multi-agent clients?
2. Should #143 move even earlier, potentially before the final Inbox UI?
3. Are deferred approvals worth their protocol complexity, or is task/review lifecycle the stronger differentiator?
4. Which layer is easiest for a strong competitor to copy?
5. Where can Harness create compounding advantage rather than a collection of features?
6. Which strategic assumption is most likely to be wrong?

Concrete code- and market-based criticism is more valuable than agreement.

## 17. Canonical planning references

- [#133 — Harness 3 control-plane roadmap](https://github.com/giuliastro/harness-remote/issues/133)
- [#130 — Session UI extraction](https://github.com/giuliastro/harness-remote/issues/130)
- [#131 — AgentRun and attention model](https://github.com/giuliastro/harness-remote/issues/131)
- [#141 — Deferred ACP permission spike](https://github.com/giuliastro/harness-remote/issues/141)
- [#142 — Attention Plane](https://github.com/giuliastro/harness-remote/issues/142)
- [#132 — Agent Inbox](https://github.com/giuliastro/harness-remote/issues/132)
- [#143 — Universal Daemon](https://github.com/giuliastro/harness-remote/issues/143)

This document is the canonical **why and where**. GitHub issues remain the canonical **what next and how**.
