# Harness 3 Product & Architecture Roadmap

> **Status:** product direction and sequencing. Execution is tracked in [#133](https://github.com/giuliastro/harness-remote/issues/133).

## 1. Vision

Harness Remote is evolving into a **local-first control plane for running AI coding work across the user's machines**.

The target hierarchy remains:

```text
fleet → machine → project → task → agent run → backend
```

Codex, Claude Code, OpenCode, OMP, PI and future compatible agents are execution engines. Harness owns the layer above them: machine discovery, task placement, run configuration, attention, review and lifecycle.

## 2. Product proposition

> **Run and supervise AI coding work across your machines, from anywhere, while execution and credentials stay on them.**

Multi-agent support by itself is not enough. The differentiating direction remains multi-machine, vendor-neutral, local-first control, but real-device testing on 2026-08-14 showed that the project advanced too far into task/fleet foundations before the single-machine product contract was reliable.

The roadmap therefore has a new rule:

> **Do not add orchestration complexity on top of a connection/task flow that is not boringly reliable.**

## 3. Architecture contract

### Machine is the connection primitive

A Harness daemon represents one physical/logical machine:

```text
Machine daemon
  endpoint + stable credentials
  ├── PI
  ├── OpenCode
  ├── Codex
  ├── Claude Code
  └── OMP
```

The client saves the **machine**, not one duplicated server profile per agent.

Agents are discovered children of that machine and are selected at use time.

### One daemon, stable identity and auth

Ordinary daemon restart must preserve:

- machine identity;
- generated client username/password or equivalent credential material;
- known machine state needed for reconnect.

Restart is not credential rotation. Explicit user-supplied credentials remain valid overrides, and explicit rotation/reset may exist separately.

### Discovery is authoritative

For daemon-backed connections the client must not ask the user which backend is running before it connects. `/v1/machine` is the source of truth for:

- machine identity;
- discovered agents;
- transport/backend metadata;
- capabilities;
- `available | starting | unavailable | unauthenticated` state;
- failure reason;
- projects/tasks where applicable.

Legacy direct-server connections remain a compatibility mode and may still require explicit backend configuration.

### Slow work is asynchronous

Slow adapter startup, model discovery and task launch must not freeze the UI.

The control plane should return identity/state quickly and let long work continue as explicit `starting` state.

## 4. P0 Stabilization Gate

No Fleet expansion or new orchestration feature outranks this gate.

### P0.1 — Universal daemon reliability

Issues: **#143, #177**

#143 was closed too early and has been reopened.

Required outcomes:

- one public daemon endpoint represents all supported local agents that can be safely discovered;
- a machine with PI + OpenCode + Codex does not require separate public servers/profiles;
- no silent default selects OMP or another unavailable backend;
- slow agent startup reports `starting` and can recover/retry;
- one failed agent does not make the machine unusable;
- generated client credentials persist across restart;
- agent failure reasons are exposed through the machine API;
- real-device validation covers at least PI plus one second agent on the same daemon.

### P0.2 — Machine-first client and unified setup

Issues: **#178, #180**

There is one onboarding model for First Run, Add Machine and Edit Machine:

```text
Address
Username
Password
[ Connect ]
```

After connection, the app discovers agents automatically.

Required outcomes:

- no OpenCode-specific first-run wizard;
- no different PI wizard later;
- no deleting/recreating a server merely to switch agent;
- one machine stores endpoint/credentials once;
- agents appear/disappear automatically under the machine;
- connection test reports machine reachability **and** agent usability/reasons;
- existing duplicated daemon-backed profiles migrate safely;
- legacy direct profiles keep exact compatibility semantics.

### P0.3 — Task launch reliability

Issues: **#145, #173, #174, #175**

The current draft task path is not ready. Real Android testing found:

- model refresh can hang for a long time then timeout;
- reopening may show cached models with unclear freshness;
- Start can return to the session list before the task appears;
- launched sessions may not show their model catalog/current model;
- task/run configuration is weaker and less reliable than the mature session path.

Required task lifecycle:

```text
New Task opens immediately
  ↓
metadata/model refresh independently
  ↓
user selects agent/model
  ↓
Start creates and persists task identity immediately
  ↓
client shows task immediately as starting
  ↓
worktree + agent/session startup happens asynchronously
  ↓
running | failed | interrupted | completed
```

Model lifecycle:

```text
catalog → selection → task persistence → launch validation → session current-model readback
```

Rules:

- short explicit model/catalog timeout;
- stale cache visibly stale, never silently authoritative;
- model discovery works with zero user sessions;
- no visible technical catalog sessions;
- no silent model fallback;
- selected model is persisted and observable after launch;
- task appears immediately before slow startup finishes;
- failures remain visible/recoverable rather than disappearing.

**#172 remains draft and `TASK_LAUNCH_ENABLED` remains false in normal builds until this passes real Android testing.**

### P0.4 — Session correctness

Issue: **#181**

The PI `ciao` / `ciai` corruption remains open.

The native PI-history approach attempted in draft #182 widened behavior too much and caused duplicate transcript state during manual testing. It is abandoned.

The replacement must be a minimal fix in ACP replay/reconciliation/message-boundary handling with regression coverage and real-device validation. It must not change unrelated session semantics.

## 5. Definition of Ready

Before moving priority to Fleet or further orchestration, a real Android client against a real daemon must repeatedly pass:

1. start daemon;
2. restart daemon without changing app credentials;
3. app reconnects to the same saved machine;
4. app automatically discovers every usable local agent;
5. First Run and Add Machine use the same connection flow;
6. New Task opens immediately;
7. fresh/known model selection works with zero prior sessions;
8. Start immediately creates a visible `starting` task;
9. task transitions without manual refresh/reopen;
10. opening the run shows the selected/current model;
11. transcript/session state remains correct across refresh/restart;
12. one agent failure does not break the machine.

Until this passes, the project is in **stabilization**, even if individual backend components have green unit tests.

## 6. After Stabilization

### P1 — Complete the work lifecycle

Issue: **#169** plus follow-ups.

```text
run → diff → tests/checks → review → PR → CI visibility → finish
```

#169 may have implementation in draft work, but it remains open until accepted and merged through the normal review process.

### P2 — Multi-machine Fleet

Issue: **#146**

Fleet must aggregate **machine objects**, not duplicated legacy per-agent profiles.

Initial placement remains explicit:

```text
Task      Fix issue #200
Machine   Workstation
Agent     Codex
Workspace New worktree
```

Automatic placement comes later.

### P3 — Attention

Non-blocking track:

```text
#141 → #142 → #132
```

Attention remains important, especially on mobile, but it does not outrank making connection/task fundamentals reliable.

### P4 — Coordination

Only after fundamentals are reliable:

- Auto agent selection;
- Auto machine selection;
- workload/capability/cost/rate-limit routing;
- multi-agent implementation/review patterns;
- optional relay;
- team/RBAC/audit.

## 7. Engineering rules

1. **Machine-first, not backend-first.**
2. **One setup flow.** First-run and later setup must not diverge.
3. **Restart is not credential rotation.**
4. **Discovery beats declaration.** Do not ask the user for facts the daemon already knows.
5. **Identity before slow work.** Create machine/task/run state before expensive startup.
6. **Explicit async states.** `starting`, `running`, `failed`, `interrupted`, `unavailable` are product states, not hidden implementation detail.
7. **Caches disclose freshness.** Stale is never silently fresh.
8. **No silent fallback.** Especially model and agent choices.
9. **Legacy is compatibility mode.** Do not let old direct-server assumptions shape the new UX.
10. **Manual Android validation gates product claims.** Unit/integration tests are necessary, not sufficient.
11. **Prefer smaller fixes over cross-cutting workarounds.** If a fix changes unrelated session/connection behavior, narrow it before shipping.

## 8. Current priority order

```text
P0 STABILIZATION
#143 + #177   daemon/auth/discovery/all-agent reliability
      ↓
#178 + #180   machine-first client + unified wizard
      ↓
#145 + #173   New Task/model/start lifecycle
      ↓
#174 + #175   finish/restart robustness

IN PARALLEL, ISOLATED
#181          session boundary correctness

THEN
#169 + tests/review/PR lifecycle
      ↓
#146 Fleet
      ↓
auto routing/orchestration

ATTENTION remains non-blocking
#141 → #142 → #132
```

## 9. Success test

Harness is succeeding when users describe it as **the place they run and manage agent work**, and the basic workflow feels simpler than running the agents directly.

If adding the daemon causes more profiles, more credentials, more waiting or more ambiguity, the control plane has failed its job regardless of how much architecture exists underneath.
