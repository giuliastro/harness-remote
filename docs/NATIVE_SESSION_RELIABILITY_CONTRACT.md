# Native Session reliability contract

Harness Remote treats each coding harness as the authority for its own Native Sessions. The UI, daemon, transcript cache and live-event streams are projections of that native truth; none of them may become a competing session authority.

This contract generalizes the OpenCode reliability contract to the shared Session-first surface without erasing provider-specific behavior. OpenCode, Codex, Claude Code, OMP and PI may expose different lifecycle and persistence mechanisms, but the user-visible Native Session invariants below are common release requirements.

## Core invariant

A Native Session that is already mounted must converge to the harness's authoritative state without requiring navigation away/reopen or an app remount.

That convergence requirement applies to:

- normal completion;
- provider/model failure;
- harness retry;
- Stop/cancel;
- silent or delayed transcript persistence;
- a lost or delayed live event;
- permission/question waiting where the harness supports it;
- reconnect and foreground recovery;
- create, resume and reopen.

A provider-specific implementation may need a different readback or settle policy, but it must not create a second user-visible lifecycle with weaker guarantees.

## Shared invariants

### 1. Native identity stays authoritative

A Session is identified by machine + harness + native Session id. Opening, resuming, stopping or continuing it must act on that exact native Session. A normal continuation must not silently create a replacement Session.

### 2. Prompt dispatch is exactly once

Every user mutation carries durable identity. Ambiguous HTTP/network outcomes may be reconciled or retried, but must not duplicate the native prompt or create duplicate visible turns.

### 3. Readback can repair missed live events

SSE/ACP/live events are an acceleration path, not the only source of truth. If the harness persisted a prompt, reply, error or terminal state and the final live event was lost, a bounded authoritative readback must make the mounted Session converge.

### 4. Waiting is not terminal

A permission request, question, retry decision or other harness-owned waiting state is not equivalent to turn completion. Waiting must remain visible/actionable where supported and must not manufacture `Response interrupted` merely because generation paused.

### 5. Terminal errors actually terminate

A real provider/model error must eventually move the mounted Session out of Activity/Working and preserve the visible failure. If that harness can automatically retry, the implementation may use a bounded recovery window, but an old failed turn must not keep the Session permanently Working.

### 6. Stop converges and remains usable

Stop/cancel acts on the exact native Session and current mutation boundary. After cancellation settles, the Session must no longer look Working and must remain usable for a later continuation unless the harness itself made it unusable.

### 7. Model continuity follows native truth

The displayed current model/variant must come from the selected Session's native metadata/catalog rather than a stale UI default or another harness's catalog. Reopen and delayed persistence must not silently regress a concrete model to `Harness default`.

### 8. Create/resume preserves the first turn

Creating a Session and sending its first prompt must not lose, duplicate or reorder that prompt if the native transcript becomes durable later than the lifecycle/status edge.

### 9. Foreground/reconnect revalidates state

A client that reconnects or returns to the foreground must revalidate mounted/native state and converge without requiring the user to navigate away and back.

### 10. Resource growth is bounded

Listeners, subscriptions, mutation ledgers, transcript caches and recovery watches must have explicit cleanup/bounds. Reliability fixes must not replace one stuck-state bug with permanent polling, unbounded listeners or unbounded cache growth.

## Provider-specific rules remain explicit

The shared contract defines outcomes, not one universal provider algorithm.

- **OpenCode** keeps its explicit transcript/status/live-event reconciliation, permission/question semantics, fail-closed permission boundary and bounded retry/silent-turn recovery. See `OPENCODE_RELIABILITY_CONTRACT.md`.
- **OMP** keeps native active-branch authority and its journal/live reconciliation rules. It must not infer an abandoned sibling when authoritative branch state is required.
- **PI** keeps live-to-journal identity stabilization so persisted history replaces, rather than duplicates, the transient ACP representation.
- **Codex** keeps its own native transcript/model/session-history semantics and delayed persistence handling.
- **Claude Code** keeps its stream/session semantics and provider-specific bridge tests.

Do not move these differences into generic UI conditionals simply to make implementations look uniform. Share only invariants that are genuinely common.

## Automated regression layers

No single test layer is sufficient. The release-safety contract is intentionally layered.

### Web/unit and deterministic projection tests

`web/package.json` `test:ci:full` is the canonical web regression tier. It must continue to cover Session-first architecture, discovery/continuation, lifecycle/model reconciliation, live-event routing, native responses, OMP projection/multiturn behavior and observer/controller behavior.

### Production-browser smoke

The blocking Chromium job builds the production web app and drives realistic fake daemons. It protects mounted-session behavior that source assertions cannot prove, including transcript/composer convergence, PI lifecycle/recovery paths, OpenCode event/retry/permission paths, model switching and Session outcome behavior.

### Bridge/provider behavior

`bridge` runs `node --test` in CI, so provider-specific bridge tests are auto-discovered. Critical coverage includes Claude, Codex, OMP, PI, OpenCode, capability contracts, native Session claim/model routing, idempotency, caches/bounds and the release-gate implementation itself.

### Real-harness release gate

Automated fixtures cannot prove compatibility with the installed versions of every harness. Before a release is called fully verified, run the traceable real-harness gate for OpenCode, Codex, Claude Code, OMP and PI. A control-plane-only pass is not equivalent to real inference evidence.

Physical Android background/foreground and real network-interruption checks remain separate release evidence where a real device boundary is required.

## CI wiring is itself a regression contract

`bridge/test/native-session-reliability-ci-contract.test.js` fails if critical Native Session web tests, provider tests or production-browser smokes are silently disconnected from the blocking PR workflow.

That guard does not replace behavioral tests. Its job is to make sure the behavioral tests continue to execute.

## Change rule

When a Native Session regression appears:

1. express the violated invariant first;
2. reproduce it with the strongest practical behavioral test;
3. fix the shared state transition when the bug is shared rather than adding an event-specific UI patch;
4. retain provider-specific logic only where the native harness semantics truly differ;
5. keep the blocking CI wiring intact;
6. do not declare a real-harness release requirement satisfied from fixture-only CI evidence.

The desired end state is not that every historical symptom has its own patch. It is that transcript, lifecycle/status, live events, permission/question state and background reconciliation all converge on one coherent mounted Native Session projection.
