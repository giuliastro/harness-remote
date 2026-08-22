# Harness Remote 3.0 Product & Architecture Roadmap

> **Canonical execution plan:** issue #197.
>
> This document explains the product direction and sequencing rationale. Issue #197 remains the release and implementation authority.

## 1. Vision

Harness Remote 3.0 is the **vendor-neutral, local-first control plane for coding-agent conversations**.

It does not try to become another coding agent, another task manager, or another implementation of features already owned by Codex, Claude Code, OpenCode, OMP, PI and future harnesses.

The product promise is:

> **Your projects. Any coding agent. One workspace.**

The user-facing model is deliberately small:

```text
Machine
  Project
    Conversation
      Native Session
      Native Session
      ...
```

A Conversation can begin with one coding agent and continue with another. The underlying Sessions remain real native Sessions owned by their harnesses.

## 2. Why this direction

Modern harnesses already provide strong Session history, compaction, memory, tools, permissions, Git workflows, background execution and increasingly good remote experiences.

Rebuilding those capabilities above every harness would create a weaker duplicate and force Harness Remote to chase each vendor indefinitely.

Harness Remote instead owns the layer no single vendor is naturally motivated to provide:

- one machine connection for several coding agents;
- one project surface across agents;
- one Conversation that can span several native Sessions;
- explicit continuation between vendors;
- one remote interface on desktop, web and Android;
- local execution with the user's existing repositories, credentials and subscriptions.

Harness count matters as coverage, not as the product vision. Reliable interoperability is the value.

## 3. Product boundary

### Harness Remote owns

- Machines and machine discovery;
- Projects and filesystem boundaries;
- coding-agent discovery and capability metadata;
- per-agent model catalogs;
- Conversation identity and title;
- ordered references to native Sessions;
- agent/model continuation and handoff;
- minimal cross-Session recovery metadata;
- remote supervision, attention and Stop controls;
- project Changes inspection;
- desktop, web and Android product experience.

### Native harnesses own

- Session history;
- native context and memory;
- compaction;
- reasoning and assistant output;
- tool execution;
- permissions and questions;
- model behavior;
- harness-specific Git features;
- native Session resume semantics.

Architecture rule:

> If a harness already owns a capability well, Harness Remote should orchestrate it rather than clone it.

## 4. Conversation continuity

A Conversation is intentionally thinner than the previous Task concept.

### Same coding agent

Resume the most recent compatible native Session when possible.

If the Session no longer exists, create a new native Session and transfer only the minimum useful continuity context.

### Different coding agent

Create or resume the target agent's native Session and pass an explicit handoff containing relevant state such as:

- current objective;
- important decisions;
- unresolved work;
- recent outcomes;
- project/workspace state;
- changed files;
- checks already run.

Harness Remote must never pretend that native memory from one vendor magically became native memory in another.

### Returning to a previous agent

Resume that agent's existing native Session when possible, then supply only the intervening context needed to catch it up.

## 5. Workspace model

The normal Conversation runs in the selected Project's real directory.

```text
Project /home/user/Software/harness-remote
  Conversation A -> native Session
  Conversation B -> native Session
```

A hidden daemon-managed worktree is **not** the default.

Worktree isolation remains useful for deliberate parallel work, but it must be an explicit user choice with visible branch, path and lifecycle.

## 6. Primary experience

```text
Workspace
  Machines
  Projects
  Coding agents

Project
  Conversations
    Chat
    Sessions
    Changes
```

### New conversation

Choose Machine, Project, coding agent, model and first message. Start in the real Project directory.

### Continue with

Inside a Conversation, change coding agent or model and send the next instruction. Harness Remote performs the native Session resume/create and continuity handoff.

### Sessions

Show the actual native Session chain, including agent changes and native Session IDs for inspection.

### Changes

Show the real Project workspace changes without inventing a separate source-control lifecycle.

### Mobile

Android uses a real app hierarchy with Conversations, Machines and Settings. Opening a Conversation becomes a focused chat page. Mobile is not a compressed desktop shell.

## 7. What 3.0 removes from the primary product

The following are no longer first-class concepts:

- visible Task versus Session choice;
- separate Classic mode;
- separate Advanced Native Sessions mode;
- automatic hidden worktree creation;
- a Task transcript competing with native Session truth;
- Run as something the user must understand;
- task-manager language such as queue/complete/archive unless a future feature genuinely requires it.

Existing Task/Run storage and compatibility code may remain internally during migration. Internal persistence names do not define product architecture.

## 8. Existing strengths we keep

Keep and harden:

- one-command machine launcher;
- Universal Daemon;
- multiple agent hosts behind one machine endpoint;
- machine identity;
- project discovery;
- model discovery;
- agent-scoped routing;
- native message paging;
- live event routing;
- permissions/questions;
- Stop;
- Android native HTTP transport;
- desktop request/event transport;
- theme and language preferences;
- long-conversation performance work;
- shared conversation rendering;
- restart reconciliation and missing-Session recovery where relevant.

## 9. Differentiation

Harness Remote should not compete with Codex by being a worse Codex UI or with Claude by being a worse Claude UI.

Its durable wedge is:

### Agent independence

A Project and its Conversations survive a change of coding agent or vendor.

### Local-first execution

Code, credentials, subscriptions and runtimes remain on the user's machines.

### Universal remote surface

The same Conversations can be supervised from desktop, web and Android.

### Multi-machine reach

One control plane can span the user's workstation, laptop, server or VM without centralizing source code or provider credentials.

## 10. Harness expansion strategy

Priority order:

1. make OpenCode, Codex, Claude, OMP and PI reliable;
2. make model/capability discovery accurate for each adapter;
3. make cross-agent continuation trustworthy;
4. make adapter contracts inexpensive to implement and test;
5. add high-demand harnesses and ACP-compatible agents;
6. never sacrifice fidelity merely to increase supported-agent count.

A long compatibility list is not a moat by itself. Reliable interoperability is.

## 11. Attention and supervision

Questions, permissions, failures and Stop remain important because remote supervision is a core use case.

The UI should normalize them only enough to make them actionable from one surface. It should not hide harness-specific meaning when that meaning matters.

## 12. Performance and backend reliability rules

Conversation fidelity and backend reliability are release blockers.

Required behavior:

- typing remains immediate in long conversations;
- native messages are not duplicated;
- reasoning/tools do not become duplicate assistant replies;
- streamed output does not cause excessive React/DOM churn;
- scroll position remains stable;
- old history loads explicitly and predictably;
- live events are primary, reconciliation is a bounded safety net;
- model catalog requests cannot race across agent changes;
- model catalogs are scoped correctly per machine and harness;
- subscriptions/listeners do not leak;
- transient transport loss does not falsely end a native turn that is still running;
- Stop reaches the real native Session;
- permissions/questions remain actionable;
- caches and retained transcript state remain bounded.

## 13. Security principles

- credentials remain on execution machines;
- source code does not need to be centralized;
- filesystem roots stay explicit;
- non-loopback exposure remains authenticated;
- machine identity/pairing must preserve or strengthen authentication;
- a future relay should not require plaintext access to source, prompts or output;
- LAN, VPN and self-hosted paths remain valid.

## 14. What not to optimize for

Do not prioritize:

- raw harness count as the main success metric;
- a generic task/kanban board;
- mandatory worktree-per-item execution;
- features already better implemented by native harnesses;
- automatic routing before continuation is reliable;
- a hosted cloud backend before local value is excellent;
- architectural abstractions that cannot be explained to a user in one sentence.

## 15. Current beta baseline

Current implementation path:

- branch: `feature/conversation-control-plane-rc1`;
- draft PR: #286;
- base: `v3/taskdesk`;
- canonical plan: issue #197.

The conversation-first interface is now a usable beta baseline with:

1. direct conversation-first boot;
2. no Classic/Advanced product modes;
3. machine/project/agent/model selection;
4. New conversation in the real Project directory;
5. native-oriented chat and Activity;
6. Continue with another agent/model;
7. native Session continuity view;
8. Changes view;
9. permissions/questions and Stop;
10. desktop/web/Android navigation;
11. retained Settings;
12. green automated builds/tests on the current validated beta code baseline.

This is **not yet an RC** because real testing has exposed backend and adapter reliability problems.

## 16. Next release gate: complete backend audit

Canonical backend audit: issue #287.

The next engineering phase must focus on evidence, diagnostics and real harness behavior rather than UI feature work.

### Priority symptoms

- Android/local-network conversations sometimes disconnect or show red server errors while the native harness may still be working.
- OMP and PI model catalogs do not look consistent with their configured access.
- PI often fails on first selection and recovers only after switching away and back.
- OpenCode exposes richer model options/variants than other harnesses, and it is unclear whether this reflects real capability differences or incomplete adapter discovery.
- OpenCode repeatedly logs `MaxListenersExceededWarning`.

### Audit scope

Audit the complete path:

```text
UI / Android transport
  -> machine daemon
  -> agent host
  -> harness adapter
  -> native Session
```

Validate:

- timeout policy by operation;
- accepted-prompt recovery;
- reconnect after network loss/background/sleep;
- event/SSE/ACP listener ownership and disposal;
- duplicate subscriptions and requests;
- cancellation and AbortController cleanup;
- harness lazy startup;
- per-harness model source;
- model/provider ID normalization;
- defaults and current model;
- variants/reasoning levels/options;
- cache keys, refresh and invalidation;
- stale picker state after agent changes;
- transcript/cache bounds and pagination;
- diagnostics and soak behavior.

Do not solve listener warnings by raising the listener limit.
Do not solve transport problems by blindly increasing timeouts.

## 17. Harness capability matrix

Before release promotion, document what Harness Remote can actually discover/control for:

- OpenCode;
- Codex;
- Claude;
- PI;
- OMP.

For each adapter record:

- Session create/resume/stop support;
- event/stream transport;
- model catalog source;
- default model behavior;
- model variants/reasoning levels and selectable capabilities;
- cache/refresh behavior;
- known limitations.

Preserve useful harness-specific metadata. Do not invent a common option that the harness does not expose.

## 18. Real-harness validation

For each available harness:

1. discover/start it;
2. load/refresh its model catalog;
3. create a Conversation;
4. run 10+ turns;
5. run a long reasoning/tool turn;
6. Stop a real turn;
7. background/foreground Android or introduce a short local-network interruption;
8. reconnect without losing configured workspace state;
9. switch away and back;
10. restart daemon/app and recover/resume;
11. repeat open/close/switch cycles and prove listener/subscription state remains bounded.

Cross-harness tests must include at least:

```text
OpenCode -> PI -> OpenCode
OpenCode -> Codex -> Claude
```

Verify target model, target native Session and continuity every time.

## 19. Promotion sequence

1. Keep PR #286 DRAFT and call the interface beta.
2. Complete backend audit #287 from reproducible evidence.
3. Add diagnostics before guessing at timeout/listener failures.
4. Produce the harness capability/model matrix.
5. Pass automated tests and the real-harness backend matrix.
6. Re-run the full mobile/conversation manual gate on one exact candidate SHA.
7. Only then mark #286 ready and merge into `v3/taskdesk`, never directly into `main`.
8. Revalidate `v3/taskdesk`.
9. Only after that prepare a dedicated 3.0 release PR toward `main`.

Superseded Task-first work is closed and kept only for reference: PRs #279, #281 and #283, plus old Task/Classic issues now replaced by #197/#287.

## 20. Success criterion

Harness Remote 3.0 succeeds when the user can say:

> **I open my project, start with the coding agent I want, and continue with another whenever I want without losing the work or learning the plumbing underneath.**

It has failed if the user has to ask:

- Why did the server disconnect while the agent was still working?
- Are these really all the models and options my harness exposes?
- Why did changing agent leave the model picker broken?
- Why are listeners accumulating in the backend?
- Why does Harness Remote show a different chat from my native Session?
- Where did my code go?
