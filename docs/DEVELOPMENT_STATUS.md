# Development status

> This file is the handoff point for ongoing development work that is not yet on `main`.
> Keep it short, current and safe to read at the start of a new coding-agent session.

## Branch policy

- Persistent integration branch: `codex/development-2026-09-11`.
- Never merge development work directly into `main`.
- Feature/fix PRs target `codex/development-2026-09-11` only.
- Merge into the integration branch only after relevant tests and CI are green.
- ACP, Native Session and harness-runtime changes require regression review against previously fixed failures before merge.

## Current integration baseline

- Integration head after PR #511: `4dc68d3969672c446b954b79c538e733c82a4839`.
- PR #468 added bounded recovery of the embedded desktop daemon and was validated on Zorin with a real `SIGSTOP` recovery test.
- PR #469 added bounded Git aggregate outcome evidence: tracked files, insertions, deletions and binary files, with no raw diff/hunks/source sent to the client.
- PR #470 fixed the Machines UX race: connection fields now appear only after an explicit **Add machine** action, including when Electron discovers its managed local machine asynchronously.
- PR #471 made cross-machine continuation planning/safety a blocking Chromium regression.
- PR #472 extended that blocking smoke through real execution: exact-workspace recovery after a blocked Project choice, exactly-once target Native Session creation, source+target lineage persistence, authority reset, exactly-once first prompt and opening the target Session after live model-catalog bootstrap.
- PR #474 replaced Machine discovery source-text assertions with an executable contract against the real `discoverMachine()` path.
- PR #475 replaced the attachment forwarding source-text assertion with an executable `api.sendPrompt()` transport contract covering directory, model, variant, agent and attachment payloads.
- PR #476 replaced model-picker source-text ordering guards with an executable `groupModels()` contract that treats variant labels as opaque and preserves the harness-advertised order.
- PR #477 replaced the remaining `api.listModels()` source-text guards with an executable transport/catalog contract covering directory + Session scope, harness defaults, capabilities/limits and exact harness variant order.
- PR #478 replaced the stale-model source guard around new Native Session creation with a real `createNativeSessionTarget()` contract covering selected-harness scope, Project/title forwarding, writer ownership, surfaced capabilities and fail-closed identity.
- PR #479 replaced Native Session model-recovery source guards with an executable `resolveNativeSessionTargetModel()` contract while reusing existing lifecycle coverage instead of duplicating it.
- PR #480 retired the remaining redundant model-reconciliation source guards and stabilized the cross-machine Chromium smoke by waiting for the settled Project/model catalog state already supported by production. No runtime behavior changed; the complete Chromium, desktop and signed Debug APK gates passed before integration.
- PR #481 added explicit per-harness `--inference-unavailable` evidence and made desktop Linux/macOS/Windows coverage automatic for every PR targeting `main` or the persistent integration branch.
- PR #482 added explicit known-working model selectors for real-harness validation, with fail-closed missing/ambiguous model resolution and selected-model-scoped variant coverage. Full Chromium, desktop and signed Debug APK gates passed before integration.
- PR #483 retired redundant `native-session-model.ts` source guards from the observer/controller regression after #479 supplied executable coverage. Its CI-contract wiring was corrected before merge and the full Chromium, desktop and signed Debug APK gates passed.
- PR #484 strengthened the executable native-create capability contract with fail-closed coverage for unsupported transports plus explicit `sessions=false` and `prompt=false`; it adds no runtime behavior and passed the full Chromium, desktop and signed Debug APK gates.
- PR #485 retired two redundant model-bootstrap source guards from `model-regression.test.mjs` in favor of the blocking Chromium model-switch smoke, which holds `/models` unresolved and proves the composer and Send stay gated until a verified catalog arrives. Full Chromium, desktop and signed Debug APK gates passed before integration.
- PR #486 retired the remaining duplicate model-bootstrap source guards from the observer/component regressions while preserving distinct reconnect and catalog-failure contracts. The full Chromium behavior smoke, desktop matrix and signed Debug APK gates passed before integration.
- PR #487 retired four redundant native-create source guards while preserving the architectural no-Task/no-Conversation boundary. Its first two Chromium attempts exposed one remaining premature Project-value read during legitimate same-target route revalidation; the smoke was aligned with #480 by waiting for settled Project/model state, then the complete Chromium, desktop and signed Debug APK gates passed.
- PR #488 strengthened the executable Native Session discovery contract with positive rename/delete capability propagation and retired the redundant source guards for global-list fallback and capability mapping. The complete Chromium, desktop and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #489 retired the last three `native-session-model.ts` source guards from the Session-first architecture monolith after confirming the existing lifecycle contract already proves nested `info.model.id`, newest cross-role model precedence and matching prior-user variant inheritance. Full Chromium, desktop and signed Debug APK gates passed before integration; no runtime code changed.
- PR #490 retired four model-catalog/routing implementation guards after the blocking Chromium model-switch contract proved real picker availability, per-harness catalog isolation, routed target-catalog selection and exact selected model/variant prompt delivery. Full Chromium, desktop and signed Debug APK gates passed before integration; no runtime code changed.
- PR #491 replaced the Model Picker search placeholder guards with the executable existing picker contract, covering model/provider/description/variant search and catalog-confirmed free filtering. Full Chromium, desktop and signed Debug APK gates passed before integration; filtering semantics were unchanged.
- PR #493 replaced two remaining adapter model-reconciliation source guards with executable adapter behavior: OpenCode tail-page model enrichment now proves newest native-message model projection through the real Session controller. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #495 replaced five PI live-ACP → journal identity source guards with executable Session-controller and fail-closed identity contracts covering current-tail convergence, ambiguity, terminal errors, older-page isolation and non-PI isolation. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #496 replaced the focused observer regression's `retry`/`waiting` working-state source assertion with executable coverage of `nativeSessionIsWorking()`, including all accepted aliases, normalization and representative terminal states. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #497 retired the redundant cross-machine model-catalog implementation guard after the blocking Chromium execution smoke proved target-machine catalog isolation, target model selection/revalidation and exact model delivery into target Session creation + first prompt. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #499 refreshed this handoff after #497 and recorded the current #494 review blockers; docs only, with no runtime/test behavior change.
- PR #498 retired the duplicate `retry`/`waiting` working-state assertion from the Session-first architecture monolith after #496 supplied executable coverage. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #500 retired two duplicate prompt-idempotency source guards after the existing lifecycle contract proved durable ambiguous-delivery identity, exact same-request retry, fail-closed conflicting mutation behavior, stale expiry, Session scoping and transcript-proven acceptance. Full CI passed before integration; production code stayed untouched.
- PR #501 extracted deterministic OpenCode assistant-envelope classification into `native-session-opencode-reconciliation.ts` and added executable coverage for intermediate tool finishes, provider-error retry ambiguity, completed timestamps, structural tail parts and empty/activity envelopes. The stateful #351 lifecycle remained in the adapter unchanged. The PR was rebased after concurrent #500 integration and the complete gate was rerun successfully: regressions, Chromium including OpenCode lifecycle/cross-machine coverage, desktop Ubuntu/macOS/Windows, signed Debug APK and artifact upload.
- PR #502 replaced three prompt/command implementation-text guards with executable transport behavior in the existing lifecycle test: exact harness-scoped encoded Session paths, wire request identity, directory, model/variant and slash-command normalization/arguments. It was rebuilt after #501 advanced integration and the full gate passed again on the rebased head before merge; production code stayed untouched.
- PR #505 replaced the remaining Native Session Stop mutation-identity source assertion with executable lifecycle coverage proving ambiguous-delivery retry reuses the same request id for the same operation token, exact encoded `/stop` transport and fresh identity for a later turn. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #506 retired three redundant managed-OpenCode daemon transport source assertions after required bridge tests proved the real `/prompt_async` and `/command` mutation paths, directory scoping, exact request bodies and absence of an invented internal agent field. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #507 retired one duplicate daemon ACP writer-recovery source assertion after required bridge coverage proved lazy claim on the first PI mutation and ownership reuse across later prompt, slash-command and Stop mutations. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #508 retired two duplicate ACP handoff-creation source assertions after required bridge coverage proved the target native Session is created bare with only its directory and model/variant configuration is deferred out of resource creation. Checkpoint/reconciliation guards remain. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration; production code stayed untouched.
- PR #509 retired three duplicate Native Session delete UI source guards after the required Chromium product smoke proved the real DOM confirmation, native DELETE transport and optimistic deletion/refresh lifecycle. Capability gating, rename behavior and production code stayed untouched. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration.
- PR #510 retired two duplicate New Session UI source guards after the required Chromium product smoke proved the translated accessible control, real native create surface, exactly-once native Session creation and opening of the resulting Session. The `canCreateNativeSession` fail-closed capability gate and production code stayed untouched. Full regressions, Chromium, desktop matrix and signed Debug APK gates passed before integration.
- PR #511 marked the 3.1.0 release-readiness boundary and advanced the integration head to `4dc68d3969672c446b954b79c538e733c82a4839`.
- #474-#480 and #483-#510 are behavior-preserving contract/CI-hardening slices under issue #330; #481-#482 are release-evidence hardening under #368. Production ACP/harness behavior was not changed by these slices.

## Current roadmap boundary

Active WIP branch: `codex/port-opencode-session-rail-live-state`.

A real OpenCode rail regression discovered on the released line is being ported into 3.1 before release. Stable-line PR #512 covers the case where Session A is left while `Working`, completes while Session B is selected, but remains visually `Working` in the Session rail until A is reopened. The integration port invalidates Session discovery directly from lifecycle events, keeps a bounded fresh streamed status ahead of a briefly stale native status read, and adds a blocking Chromium smoke for A Working → navigate to B → A Ready without reopening A. The port deliberately does not change prompt/Send routing, Stop, ACP writer ownership, transcript reconciliation, or polling cadence, and existing #351 regressions remain mandatory.

Validation also exposed an unrelated CI break: `android-actions/setup-android@v4` currently defaults to the retired Android SDK `tools` package. The candidate workflow skips that default package set and continues to install the exact Android 36 platform/build-tools explicitly. Do not merge the stable or integration fix until the complete respective CI, including signed Debug APK, is green.

The integration branch is now in release-candidate stabilization. Do not start another source-guard cleanup, P3 provider expansion or opportunistic runtime refactor before the next release.

The intended next release is **Harness Remote 3.1.0**, not 3.0.3: compared with 3.0.2, the integration line contains substantial user-facing P1/P2 work including pairing/onboarding, Attention semantics, desktop-owned local runtime/recovery, Project/outcome evidence and cross-machine Native Session continuity. Freeze a release-candidate ref only after this evidenced regression fix is integrated, then run the true-boundary evidence against that exact frozen commit.

Release publication remains blocked by true-boundary evidence, repository administration and the current evidenced OpenCode rail fix:

- strict `gate:real-harness` against the actually installed OpenCode/Codex/Claude/OMP/PI builds, using known-working models where available and recording unavailable inference explicitly;
- real daemon/adapter restart plus persisted-Session resume/claim on the same candidate build;
- physical Android foreground/background plus a real network interruption/reconnect check;
- `main` ruleset/branch protection requiring pull requests and the always-present release checks. The connected GitHub App cannot perform this administration write.

External PR #504 (`daemon: support custom ACP primaries with multiple detected CLIs`) has been retargeted from `main` to `codex/development-2026-09-11` and is blocked with `REQUEST_CHANGES`. Its new `resolveDaemonPlan()` unit test bypasses the real configuration boundary: `parseConfig()` still resolves `--backend` through `harnessProfile()` and rejects an unknown backend before the helper can run, while daemon startup later calls `harnessProfile(config.backend)` again. It is not part of the 3.1.0 candidate. Re-review only after the intended contract is made coherent end-to-end and executable coverage exercises the real parse/startup path rather than only the helper.

The post-#501 audit found that `opencode-recovery.test.mjs` directly proves how an already-selected OpenCode assistant envelope is classified, but it does **not** independently prove the adapter's current-turn occurrence matching for repeated prompts or its newest-assistant selection. Therefore the remaining architecture guard tying `latestAssistant` to `openCodeAssistantProvesTurnCompleted` must stay until equivalent executable adapter/controller coverage exists. Do not create production seams merely to delete that guard.

The remaining source-guard families around model fallback, adapter writer acquisition, projection disposal, OpenCode silent recovery, pending-prompt reconciliation and reply settle continue to protect critical semantics. Do not touch them during release-candidate stabilization.

External PR #494 was closed without merge after real validation showed that its central Mimocode product goal was not met when OpenCode and Mimocode were installed together: both CLIs were detected but only OpenCode was exposed as the managed backend. Its external-session behavior was also narrower than the PR description suggested. Do not revive or port #494 as part of 3.1.

### P0 — issue #368

Repository/fixture-side automation is exhausted for this release line. #368 stays open for the true-boundary release evidence listed above plus the `main` ruleset/admin action. Do not add synthetic coverage to substitute for those checks.

### P1 — issue #369

Repo-side pairing, Attention semantics, desktop-owned local runtime, packaged-runtime execution, PATH recovery, health/reconnect recovery and Machines simplification are implemented. Do not invent more P1 UI/runtime surface before 3.1.0 merely because #369 remains open; its remaining dependency is the P0 real-boundary evidence.

### P2 — issue #371

Do not restart federation or cross-machine continuity work already integrated:

- #411-#413: federated Native Session read model, operational buckets and machine/Project/harness/model/state scopes;
- later P2 slices: durable Project/native identity, lineage, portable handoff state and crash/retry-safe target creation/first prompt;
- #435/#436: recovered portable state plus source-authority invalidation / target fail-closed authorization acceptance;
- #437-#439/#469: bounded Project/outcome evidence, structured completion/attention/next action and Git aggregates;
- #471/#472: blocking Chromium planning and full execution coverage.

One deliberate non-claim remains: do not infer `checks run/failed` from transcript/tool prose. There is no provider-neutral structured source yet, so absence is safer than heuristic evidence.

#371 remains open at true-boundary evidence, not because another federation implementation is missing.

## Product direction

Continue from `docs/HARNESS_3_ROADMAP.md`, prioritizing correctness/recovery, onboarding, attention visibility and Native Session federation. Avoid turning Harness Remote into a generic IDE/task manager or reimplementing capabilities that belong to native harnesses.

Do not begin P3 provider-extension work merely to keep development moving while P0/P1/P2 true-boundary gates are unresolved. Prefer real validation or a clearly evidenced defect over speculative new surface area.
