# OpenCode reliability contract

This document is a non-regression contract for Harness Remote's native OpenCode Session path.

OpenCode has had several independent lifecycle failure modes that can look similar in the UI: a reply can be persisted without the final live event, a transient provider/interruption envelope can recover later, a terminal provider failure can arrive while Session status is incomplete, a silent accepted turn can produce no assistant signal, and a permission/question can intentionally leave the harness waiting for the user. Fixing one of those cases must never weaken another.

## Product invariants

The following are release-blocking invariants for OpenCode.

1. **One prompt, one native dispatch.** Recovery, foregrounding, event loss, permission resolution and Session reopen must never resend an accepted prompt.
2. **Persisted assistant output wins.** If the final assistant output is durable in the native transcript, the already-mounted Session must eventually show it even when the final live event is lost or `/session/status` is unavailable.
3. **No navigation recovery requirement.** Leaving a Session and opening it again may refresh state, but it must never be required to reveal a durable reply or settle Working/Activity.
4. **Transient interruption is not terminal.** Intermediate tool/error envelopes or short idle edges must not become a permanent red `Response interrupted` when OpenCode continues the same turn.
5. **Real terminal interruption remains visible.** If OpenCode truly stops without a final answer, Harness Remote must not fabricate success or hide the interruption.
6. **Provider failures settle without getting stuck Working.** Durable terminal errors remain visible and the mounted Session converges without navigation.
7. **Accepted-but-silent turns fail visibly.** A prompt that OpenCode accepted but that produces neither assistant output nor usable lifecycle evidence must not spin forever.
8. **Pending authorization/input is a waiting state, not a terminal state.** `permission.asked` / `question.asked` can refresh request detail and transcript, but cannot by themselves terminalize the turn or create `Response interrupted`.
9. **Attention is authoritative while a request is unresolved.** Opening, selecting or rereading a Session cannot consume a pending permission/question.
10. **Permission replies are fail-closed.** `Deny` maps exactly to OpenCode `reject`; `Allow once` maps to `once`; `Always allow` maps to `always`. The native reply must succeed before Harness Remote records observational approval metadata or treats the request as resolved.
11. **Failed permission replies stay visible.** A failed reply POST must not optimistically filter/remove the request or clear Attention locally.
12. **Permission resolution converges in place.** After OpenCode acknowledges a decision, the mounted Session must refresh durable transcript/lifecycle state without reload or navigation.
13. **Foreground recovery is read/reconcile only.** Returning from background may reread durable state, but must never resend prompts or permission decisions.
14. **OpenCode authority stays native.** Harness Remote does not invent a second permission engine, transcript, or Session lifecycle.

## Required blocking browser coverage

The PR Chromium gate must continue to execute all three scripts:

- `web/scripts/native-opencode-browser-smoke.mjs`
- `web/scripts/native-opencode-real-regression-smoke.mjs`
- `web/scripts/native-opencode-permission-regression-smoke.mjs`

The first two preserve the historical interruption/retry/provider-error/lost-final-event/mounted-convergence cases. The permission regression additionally drives a long-pending native permission through normal reconciliation ticks, verifies Attention survives opening the Session, sends exact `reject` and `once` replies, and requires the mounted Session to settle without a reload.

`web/src/taskdesk-live-event-routing.test.mjs` intentionally checks that these scripts remain wired into the required PR workflow. Removing a historical OpenCode regression from CI is itself a test failure.

## Historical fixes this contract protects

Important OpenCode reliability work includes, among others:

- #304 / #306 / #337 — Session-first transcript convergence and shared conversation stabilization.
- #351 — transient interruption, late recovery and true terminal interruption semantics.
- #355 — terminal provider errors settling without a stuck Working state.
- #391 — accepted silent OpenCode turns becoming visible failures instead of indefinite Working.
- #421 / #422 — persisted replies recovered when final events/status are lost, including already-mounted Sessions.
- #425 — port of the released 3.0.2 OpenCode persisted-reply stability into the development integration line.
- #451 — unresolved native OpenCode permission/question remains in the global Attention index.
- #452 — permission lifecycle reconciliation, false-interruption prevention and production-browser permission regression coverage.

A future refactor must preserve the behavior represented by those regressions even if implementation structure changes.

## Native permission boundary and upstream OpenCode behavior

Harness Remote can only deny a native OpenCode permission request that OpenCode actually emits before the protected action executes.

A known upstream OpenCode issue (`anomalyco/opencode#32628`) describes shell redirect targets such as `echo value > /outside/file` bypassing the `external_directory` check. In that situation the shell side effect can occur before any permission request reaches Harness Remote; a later permission for a different operation cannot retroactively undo it.

Do not "fix" this in Harness Remote by fabricating a second sandbox/authorization layer or by claiming that a later Deny blocked an earlier un-gated native action. Track upstream behavior separately while keeping Harness Remote's own permission reply path strictly fail-closed and observable.

## Merge/release rule

Changes touching OpenCode Session projection, live-event routing, transcript reconciliation, Attention, permissions/questions, foreground recovery, or native prompt dispatch are not considered safe merely because type-check/unit tests pass. The historical OpenCode browser matrix above must be green on the exact candidate SHA before integration or release.
