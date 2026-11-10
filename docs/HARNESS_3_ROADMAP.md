# Harness Remote product and architecture

This document describes the durable product model, engineering boundaries and execution priorities for Harness Remote as they ship on `main`.

> **Superseded for planning (2026-11-10):** the P0–P3 gates below are complete. Current priorities are in [ROADMAP_4.md](ROADMAP_4.md), which also amends §14–§15. The product thesis, architecture boundary and reliability rules here still apply.

> **Status (2026-09-06):** Harness Remote 3.x is the canonical product line and `main` is the only baseline for new work. The latest published release is `v3.0.1`; `v3.0.0` remains the immutable initial Session-first release point. The former `checkpoint/v3-session-first-working-2026-08-25` and archive branches are historical/recovery references, not feature-development baselines.
>
> The old post-release list is superseded. Repository branch hygiene (#290) is complete. Current work is organized by explicit execution gates: **P0 reliability/startup (#368), P1 remote-first UX (#369), P2 Native Session Federation (#371), and P3 ACP/provider expansion (#372)**. Cross-machine handoff (#347), architecture simplification (#330), CI hardening (#366/#367) and startup correctness (#356) feed those gates.

## 1. Product thesis

Harness Remote is a **vendor-neutral, local-first control plane for native coding-agent Sessions**.

The promise is:

> **Your sessions. Any coding agent. Any device.**

Harness Remote does not try to become another coding agent, cloud IDE or universal fake Session implementation. It connects to the coding agents the user already runs and keeps their Native Sessions authoritative.

The product should increasingly behave like a **Native Session federation layer**:

- discover real Sessions regardless of where they were started;
- show their live state across machines and harnesses;
- surface work that needs the user's attention;
- let the user observe, resume and safely hand work to another agent;
- preserve explicit lineage without pretending hidden provider context is portable;
- keep source code, credentials and provider subscriptions on the machines that execute the work.

## 2. Strategic direction

Remote control alone is becoming a commodity. The durable differentiator is not "chat with a coding agent from a phone"; it is **trustworthy continuity across the user's real coding-agent Sessions**.

Harness Remote should therefore compete on:

1. **Native fidelity** — the harness remains the authority for transcript, reasoning, tools, permissions, context, compaction, models and resume semantics.
2. **Federation** — one operational view across machines, Projects and supported harnesses, without requiring import into a Harness Remote-owned conversation object.
3. **Continuity** — explicit same-machine and eventually cross-machine handoff between real Native Sessions, with inspectable lineage and recovery semantics.
4. **Remote-first supervision** — pairing, attention states, notifications, reconnect behavior and mobile UX that make long-running agent work easy to supervise.
5. **Reliability** — exactly-once prompt/Session behavior, deterministic reconciliation, bounded resources and release gates that make regressions difficult to ship.
6. **Capability honesty** — surface what each running harness really supports instead of flattening every provider into invented common controls.

Feature count is not a success metric. A smaller control plane that users can trust is more valuable than a broader product that occasionally duplicates turns, loses state or obscures where work actually ran.

## 3. User-facing model

The product model is built around Native Sessions:

```text
Machine
  Project
    Native Session
    Native Session
    ...
```

A Project is a real working directory/repository.

A Native Session is the real Session owned by its harness.

Older Task, Run and Conversation terms may remain in internal compatibility code while reachable, but they are not required user-facing abstractions and should not drive new product design.

The federation view may aggregate Sessions across machines, but it must not replace their identity:

```text
All Sessions
  workstation / repo-a / Claude Session A
  server      / repo-a / Codex Session B
  laptop      / repo-b / OpenCode Session C
```

## 4. Architecture boundary

### Harness Remote owns

- machine discovery, identity and routing;
- Project/filesystem boundaries;
- harness discovery and capability metadata;
- per-harness model discovery;
- Native Session discovery and presentation;
- remote observation and control;
- cross-agent continuation metadata and lineage;
- attention aggregation and remote UX;
- desktop, web and mobile experience;
- release-level reconciliation and diagnostics.

### Native harnesses own

- Session transcript/history;
- native context and memory;
- reasoning and assistant output;
- tools and tool state;
- permissions/questions;
- model behavior;
- native writer ownership;
- resume and compaction semantics;
- native Session persistence.

Architecture rule:

> If the harness already owns a capability well, Harness Remote should orchestrate it rather than clone it.

This boundary is a product advantage and must survive future provider expansion.

## 5. Native Session UX

Expected flow:

```text
start a native Session anywhere
  -> open Harness Remote
  -> discover the same Session
  -> observe it
  -> continue it when native ownership permits
```

No attach/import step is required merely to read or resume a supported Session.

The primary surfaces should converge toward:

```text
Home / Federation
  Needs attention
  Active Sessions
  Recently completed
  Recent Sessions
  Projects
  Machines

Project
  Sessions
  Changes

Session
  transcript
  Activity
  machine + Project
  harness + model
  live status
  Stop
  lineage
  Continue with another agent
  outcome / changes / checks
```

The product should answer five questions immediately:

1. Where is this work running?
2. Which harness/model owns it?
3. Is it actually working, ready, failed or waiting for me?
4. What changed?
5. What is the next safe action?

## 6. Observe vs Continue

Read access and writer ownership are different capabilities.

Harness Remote represents native behavior honestly per harness:

- discover/list;
- lookup by native Session ID;
- observe transcript;
- create;
- resume/continue;
- writer takeover rules;
- Stop/cancel;
- rename/delete;
- model and variant discovery;
- live event support.

Observation must never silently steal native writer ownership.

A federated Session index must remain metadata-oriented; it must not require every transcript body to be loaded or cached just to show status/search results.

## 7. Cross-agent continuation

Switching coding agent is a core product capability, but every hop remains a real Native Session.

Example:

```text
OpenCode Session A
  -> Continue with Codex
Codex Session B
  -> Continue with Claude
Claude Session C
```

Harness Remote retains the relationship, not a fabricated universal provider Session.

Durable linkage may include:

- continuedFrom;
- continuedTo;
- source/target machine;
- Project identity;
- timestamps;
- minimal inspectable handoff/recovery context;
- attachment-transfer metadata when explicitly supported.

Same-machine continuation is already the baseline. Cross-machine continuation is tracked in #347 and belongs to P2 (#371). It must not claim workspace equivalence unless repository/Project identity is sufficiently proven.

## 8. Workspace model

Normal Sessions work in the selected Project's real directory.

Hidden daemon-managed worktrees are not the default. Worktree isolation may exist only as an explicit parallel-work option with visible path, branch and lifecycle.

Future parallel-work UX must make it obvious when two Sessions operate on:

- the same working directory;
- different branches/worktrees of the same repository;
- similar Projects on different machines;
- unrelated directories that merely share a display name.

## 9. Reliability rules

Release-critical behavior:

- prompt reaches the intended Native Session exactly once;
- Native Session creation is not duplicated on retry/reconnect;
- no duplicate/empty user turns;
- no duplicate assistant turns;
- streamed output converges to the complete final answer;
- reasoning/tools stay attached to the correct turn;
- Activity becomes live as soon as the harness starts working;
- finished turns return to the correct terminal state;
- pending questions/permissions remain visible until resolved;
- Stop reaches the native harness;
- model selection is machine/harness/Session correct;
- navigation and paging preserve Native Session identity;
- old Sessions remain readable;
- reconnect does not overwrite a later valid completion;
- observation does not silently acquire writer ownership;
- listeners/subscriptions/cache state remain bounded;
- typing and scrolling remain responsive in long Sessions;
- offline machines remain visible as offline rather than disappearing;
- background/foreground mobile transitions do not lose authoritative Session state.

A feature that weakens these invariants is not ready to ship even if its isolated tests pass.

## 10. Supported harnesses

The current 3.x line supports:

- OpenCode;
- Codex CLI;
- Claude Code;
- Oh My Pi (OMP);
- PI.

Capability differences are preserved rather than flattened into invented common behavior. `V3_HARNESS_CAPABILITY_MATRIX.md` is the explicit contract for implemented/advertised/verified behavior.

New harnesses are a P3 concern (#372), not a reason to destabilize the existing adapters.

## 11. Current product surface

Harness Remote currently provides:

- Native Session navigation and product model;
- Native Session discovery/read/create/continue;
- multi-machine Session creation;
- same-machine cross-harness continuation with durable lineage;
- stable Session list UX;
- transcript paging and scroll preservation;
- live event-driven freshness with polling as recovery/fallback;
- model lifecycle and harness-specific reconciliation fixes;
- desktop/web regression coverage;
- Linux/macOS/Windows bridge coverage;
- Chromium product smokes;
- Android APK production in CI;
- diagnostics for lifecycle/model/event investigation.

The product has also removed substantial unreachable 2.x/TaskDesk code and obsolete style/test surface. Continue that cleanup incrementally under #330; do not start a broad rewrite.

## 12. Ongoing release standard

Every release must validate the product against real installed harnesses and on mobile devices. At a minimum, verify:

1. connect to an existing machine;
2. switch between machines if more than one is configured;
3. open existing Sessions from each available harness;
4. create a new Session with explicit machine, Project, harness and model;
5. run several consecutive turns;
6. verify live Activity and complete final responses;
7. answer a supported question/permission when available;
8. background/foreground the app during a working turn;
9. interrupt/recover the network connection;
10. verify keyboard/composer behavior;
11. load older history;
12. Stop a real turn;
13. switch away and back without losing Session/model state;
14. restart the daemon and reconcile/resume;
15. verify no obvious layout/navigation regression in portrait;
16. prove listener/request/cache/subscription counts plateau during a soak test.

Fixes found by real-device validation must pass the complete automated suite again before release. Real behavior wins over a green test if they disagree.

## 13. Execution roadmap

The roadmap is ordered by **gates**, not by excitement or implementation convenience. Later work may be researched in parallel, but it must not force earlier reliability compromises.

### P0 — Release safety and zero-friction startup — #368

Goal: make the existing product hard to regress and make normal HR3 startup consistent for one or many installed harnesses.

Primary work:

- complete CI/browser-smoke cleanup (#366, including PR #370);
- enforce required pre-merge checks before removing post-merge safety duplication (#367);
- converge generic regression execution behind one canonical CI contract;
- complete single-harness Machine-endpoint correctness (#356/#357) from current `main`;
- simplify launcher output and onboarding so normal users do not need to understand daemon/bridge topology;
- run the full real-harness/mobile reliability gate.

**Do not start aggressive feature expansion until the P0 exit criteria in #368 are satisfied.**

### P1 — Remote-first UX — #369

Goal: make supervision from another device feel native rather than like manual remote administration.

Primary work:

- guided machine pairing, preferably QR/short-lived pairing data;
- LAN discovery where safe/useful while preserving manual setup;
- clear machine health/reconnect UX;
- global Attention Inbox across machines/harnesses;
- meaningful completion/failure/needs-attention notifications with deep links;
- optional E2EE relay investigation without making a hosted service mandatory;
- define an iOS delivery path after pairing/notification contracts are stable.

P1 must preserve local/VPN-only use as a first-class mode.

### P2 — Native Session Federation and cross-machine continuity — #371

Goal: turn the Session-first architecture into the product's clearest competitive advantage.

Primary work:

- federated Session index across machines, Projects and harnesses;
- Active / Needs attention / Failed / Recently completed operational views;
- search and filters without loading every transcript;
- clearer machine/Project/harness/native-ID identity and handoff lineage;
- complete cross-machine continuation (#347) with exactly-once creation, crash-safe recovery and explicit offline semantics;
- define attachment transfer and Project/repository identity before claiming seamless cross-machine continuity;
- focused outcome/review surface: files changed, diff, branch/worktree, checks and next action.

Do not turn this phase into a full IDE or generic project-management product.

### P3 — ACP Provider Kit and harness ecosystem — #372

Goal: make provider expansion cheap and safe without erasing provider-specific capabilities.

Primary work:

- extract reusable ACP lifecycle primitives and adapter contract tests;
- continue deterministic harness-specific reconciliation cleanup under #330;
- keep capability declarations explicit and runtime-driven;
- make standards-compatible ACP integration primarily a profile/adapter exercise rather than generic UI churn;
- expand only after existing adapters keep passing real-harness gates.

Preferred investigation/integration order unless protocol reality changes:

1. GitHub Copilot CLI / ACP;
2. Cursor CLI / ACP;
3. Google Antigravity CLI if a stable control/session surface is suitable;
4. generic/community ACP integrations such as Kimi Code CLI;
5. additional community agents after the provider-kit path is proven.

Explicit parallel/worktree execution may be added after federation semantics are stable, never as a hidden default.

### Continuous maintainability — #330

Architecture simplification continues alongside the roadmap as small reviewable slices:

- isolate deterministic harness-specific reconciliation rules;
- split large React controllers into controller/state and presentation components;
- consolidate scoped styles/design tokens;
- remove legacy Task-backed compatibility only when current reachability proves it unused;
- replace brittle source-text assertions with behavioral contract tests;
- keep per-harness capability differences out of generic UI conditionals.

No broad rewrite, transcript semantic rewrite or resurrection of pre-release draft branches.

## 14. Product sequencing rules

When choosing between two pieces of work, prefer the one that improves, in order:

1. correctness / data integrity;
2. observability and recovery;
3. onboarding / connection success;
4. needs-attention visibility;
5. mobile supervision;
6. Native Session federation/continuity;
7. adapter scalability;
8. new harness count;
9. optional power-user automation.

This intentionally places scheduling, heartbeat automation, generic SDK/MCP control-plane features, voice control and broad IDE-like features after the core federation experience is trustworthy.

## 15. What Harness Remote should not become

Avoid product drift into:

- another coding agent with its own hidden Session semantics;
- a cloud workspace that requires repository upload;
- a lowest-common-denominator provider abstraction;
- a Kanban/task manager as the primary product model;
- a full IDE/file manager/terminal replacement;
- a system that silently creates hidden worktrees for normal work;
- a hosted relay/account dependency for users who prefer LAN/VPN access;
- a feature-count race that sacrifices Session correctness.

Integrations may expose terminal/editor/PR actions where they help finish agent work, but those should remain focused control-plane actions.

## 16. Recovery and compatibility

Keep stable branches and known-good release tags available as recovery points. Compatibility code may protect existing installations, but it must not determine the product experience or reintroduce retired user-facing abstractions.

Normal new work starts from current `main`. Historical checkpoint/archive branches are evidence and recovery material only.

## 17. Success criterion

Harness Remote succeeds when a user can open the app and immediately understand all important coding-agent work across their connected machines, recognize the real Native Sessions they already use, safely observe or continue them remotely, and hand work to a better agent without losing Project identity or hiding what actually happened.

The product has failed if the user has to ask:

- Where is the Session I already started?
- Is this the real Native Session or a Harness Remote copy?
- Which machine/repository is this actually modifying?
- Is the agent really working or is the UI stale?
- Does anything need my permission or attention?
- Why is the transcript duplicated or incomplete?
- Why did the reply appear only after navigation?
- Why did the selected model change by itself?
- Why did Stop not reach the harness?
- Why did the app lose my Session after switching machine or backgrounding?
- Did a retry accidentally create another target Session?
- What files changed and what should I do next?

The long-term product identity is simple:

> **Start anywhere. See everything. Continue anywhere. Keep every agent native.**
