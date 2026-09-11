import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const observer = readFileSync(new URL('./components/native-session-observer.tsx', import.meta.url), 'utf8')
const crossMachinePanel = readFileSync(new URL('./components/cross-machine-continue-panel.tsx', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('./native-session-v3-adapter.ts', import.meta.url), 'utf8')
const workThread = readFileSync(new URL('./components/work-thread-conversation.tsx', import.meta.url), 'utf8')
const nativeModel = readFileSync(new URL('./native-session-model.ts', import.meta.url), 'utf8')

assert.ok(observer.includes('import { WorkThreadConversation } from "./work-thread-conversation"'), 'native Session must mount the mature v3 conversation controller')
assert.ok(observer.includes('<WorkThreadConversation'), 'native Session must render the v3 controller directly')
assert.equal(observer.includes('MachineTask'), false, 'native Session observer must not project into MachineTask')
assert.ok(observer.includes('conversation={conversation}'), 'native Session observer must pass the neutral runtime directly')
assert.ok(observer.includes('registerNativeSessionV3Adapter'), 'native identity must be translated by the Session-scoped adapter')
assert.ok(observer.includes('controller={controller}'), 'native Session I/O must be injected explicitly into the mature controller')
assert.equal(observer.includes('Continue this Session'), false, 'opening a native Session must never require a visible Continue unlock step')
assert.equal(observer.includes('probeNativeSessionContinuation'), false, 'observer must not acquire ACP writer ownership while opening a Session')
assert.equal(observer.includes('TaskDeskConversation'), false, 'observer must not mount the chat renderer directly')
assert.equal(observer.includes('loadNativeSessionFeed'), false, 'observer must not own transcript loading or paging')
assert.equal(observer.includes('refreshNativeSessionFeed'), false, 'observer must not own a parallel tail refresh')
assert.equal(observer.includes('startTaskDeskSessionLiveRefresh'), false, 'observer must not own a parallel live-event controller')
assert.equal(observer.includes('sendNativeSessionPrompt'), false, 'observer must not own a parallel send controller')
assert.equal(observer.includes('stopNativeSession'), false, 'observer must not own a parallel Stop controller')
assert.equal(observer.includes('ModelSelectionControl'), false, 'observer must not own a parallel model picker')

// Cross-machine continuation is intentionally isolated from the mature same-machine composer. This
// protects normal Session sends while the newer route state machine gains browser/mobile coverage.
assert.ok(observer.includes('const sameMachineRoutes = useMemo'), 'same-machine routing must remain an explicit isolated set')
assert.ok(observer.includes('const crossMachineRoutes = useMemo'), 'cross-machine destinations must remain an explicit isolated set')
assert.ok(observer.includes('<CrossMachineContinuePanel'), 'cross-machine continuation must use its explicit safety surface')
assert.ok(observer.includes('routes={crossMachineRoutes}'), 'the cross-machine panel must never receive the source-machine route')
assert.ok(observer.includes('machines: sameMachineRoutes'), 'the mature composer must stay scoped to same-machine harness routing')
assert.equal(observer.includes('machines: routableRoutes'), false, 'cross-machine routes must not silently enter the mature composer yet')

assert.ok(crossMachinePanel.includes('loadCrossMachineProjectRoute'), 'cross-machine selection must resolve canonical machine-local Projects')
assert.ok(crossMachinePanel.includes('planCrossMachineContinuation'), 'cross-machine UI must preflight Project continuity before mutation')
assert.ok(crossMachinePanel.includes('continueNativeSessionAcrossMachine'), 'the final UI mutation must use the crash-safe orchestrator')
assert.ok(crossMachinePanel.includes('confirmedProjectContinuity: confirmationRequired && confirmed'), 'diverged workspaces must require explicit user confirmation')
assert.ok(crossMachinePanel.includes('plan?.disposition === "blocked"'), 'repository/history mismatch must be visibly blocked')
assert.ok(crossMachinePanel.includes('taskClient.listAgentModels'), 'target model choice must come from the selected harness current catalog')
assert.ok(crossMachinePanel.includes('attachments: []'), 'the first cross-machine UI must make its no-attachment boundary explicit')
assert.ok(crossMachinePanel.includes('Attachments and source permissions are not transferred.'), 'the authority and attachment boundary must be visible in the UI')
assert.ok(crossMachinePanel.indexOf('planCrossMachineContinuation') < crossMachinePanel.indexOf('continueNativeSessionAcrossMachine'), 'read-only planning must exist before the mutation path')

assert.ok(adapter.includes('async loadMessagePage(config, sessionID, directory, before, limit, refreshHistory)'), 'adapter must observe the pages requested by the v3 controller through its scoped boundary')
assert.equal(adapter.includes('api.loadMessagePage ='), false, 'native Session mounting must not mutate the shared API client')
assert.ok(adapter.includes('!entry.initialPageCaptured || Boolean(before)'), 'initial history and explicit older paging may create compatibility Run identities')
assert.ok(adapter.includes('if (!mayDiscoverRuns) return'), 'tail replay must not manufacture duplicate Runs from changed replay ids')
assert.ok(adapter.includes(':request:${clientRequestId}'), 'new native prompts must use durable client request identity for the compatibility Run')
assert.ok(adapter.includes('probeNativeSessionContinuation(entry.target)'), 'ACP writer acquisition must be deferred to the mutation boundary')
assert.ok(adapter.includes('await ensureWriter(entry)'), 'Send and Stop must acquire writer ownership transparently when needed')
assert.ok(adapter.includes('value === "retry"') && adapter.includes('value === "waiting"'), 'retry and waiting must remain working states')
assert.ok(adapter.includes('stabilizePiTailMessageIDs'), 'PI tail reads must stabilize live ACP ids when the journal later exposes the same reply under a persisted id')
assert.ok(adapter.includes('candidates?.length !== 1'), 'PI identity stabilization must refuse ambiguous repeated-answer matches')
assert.ok(adapter.includes('nextKeyCounts.get(key) !== 1'), 'PI identity stabilization must preserve legitimate repeated identical journal answers')
assert.ok(adapter.includes('entry.target.backend !== "pi" || before'), 'PI identity stabilization must stay scoped to current tail reads and never rewrite older-page history')
assert.ok(adapter.includes('message.info.error'), 'PI identity stabilization must keep interrupted/error turns outside text-only aliasing')
// Assert the disposal invariant rather than one exact formatting of it. Session teardown may need
// additional cleanup before the transient projection is removed from the map.
assert.ok(adapter.includes('entry?.listeners.delete(onConversationUpdate)'), 'leaving a Session must remove its projection listener')
assert.ok(adapter.includes('entry && entry.listeners.size === 0'), 'the final listener must trigger projection disposal')
assert.ok(adapter.includes('conversations.delete(id)'), 'leaving the final listener must dispose the transient projection so another Session starts cleanly')
assert.equal(adapter.includes('MAX_CACHED_PROJECTIONS'), false, 'Session runtimes must not survive navigation in a global cache')
assert.equal(adapter.includes('pruneInactiveProjections'), false, 'Session navigation must not retain inactive runtime state')
assert.ok(adapter.includes('reconcileNativeSessionModel(entry, page, before)'), 'every current tail page must refresh delayed OpenCode and Codex model metadata')
assert.ok(adapter.includes('lastNativeMessageModel(page.messages)'), 'OpenCode tail reconciliation must recover the newest native turn model')
assert.equal(adapter.includes('TaskDeskConversation'), false, 'adapter must not contain rendering')
assert.equal(adapter.includes('groupConversationParts'), false, 'adapter must not contain reasoning/activity semantics')

// Lost OpenCode completion events must be recoverable from the durable transcript without making
// /session/status an availability dependency for the mounted chat.
assert.ok(adapter.includes('transcriptListeners') && adapter.includes('notifyTranscript(entry)'), 'background OpenCode transcript recovery must request a mounted tail refresh')
assert.ok(adapter.includes('openCodeAssistantHasActivity') && adapter.includes('if (!completedByTranscript && !terminalError) {'), 'an empty OpenCode assistant envelope must not cancel silent-turn recovery')
assert.ok(adapter.indexOf('page = await api.loadMessagePage') < adapter.indexOf('statuses = await api.listStatuses'), 'OpenCode silent recovery must read the transcript before optional status enrichment')
assert.ok(observer.includes('transcriptRefreshToken') && observer.includes('handleTranscriptRefresh'), 'the mounted native Session observer must propagate background transcript refreshes')
assert.ok(workThread.includes('transcriptRefreshToken') && workThread.includes('void refreshCurrentTail()'), 'background transcript recovery must rehydrate the selected WorkThread feed')
assert.ok(workThread.includes('const tailRefresh = refreshCurrentTail(prior)') && workThread.includes('Promise.allSettled([tailRefresh, attentionRefresh])'), 'status reconciliation must not block the selected transcript tail')

assert.ok(nativeModel.includes('page.model ??'), 'native Session enrichment must consume a model supplied by a native journal page')
// Assert the invariant, not one spelling of it. Freezing the literal guard meant every legitimate
// change to which harnesses expose native model metadata - adding PI, Codex, Claude - broke this
// check while the behaviour it protects was still intact.
assert.ok(nativeModel.includes('PAGE_MODEL_BACKENDS'), 'model enrichment must scope itself with an explicit set of harnesses that expose native model metadata')
assert.match(nativeModel, /if \(target\.backend !== "opencode"[\s\S]{0,200}?\) return target/, 'read-only model enrichment must stay scoped to harnesses with verified native model metadata')
assert.ok(workThread.includes('observedConversationModelKeyRef'), 'the v3 picker must observe a model that arrives after the controller mounted')
assert.ok(workThread.includes('modelSelectionTouchedRef'), 'late native enrichment must not overwrite a model the user explicitly picked')
assert.ok(workThread.includes('currentConversationModelKey === previous'), 'the late-model sync must be edge-triggered rather than resetting the picker on every render')
assert.ok(observer.includes('deferModelFallback'), 'native Sessions must still defer catalog fallback when an existing Session may have native model authority')
assert.ok(workThread.includes('conversationHasUserPrompt'), 'the shared controller must distinguish a truly empty Session from an existing conversation')
assert.ok(workThread.includes('mayUseCatalogDefault = !deferModelFallback || routeChanged || !latestHasUserPrompt'), 'only empty Sessions and fresh handoffs may use a verified catalog default before native model metadata exists')
assert.equal(workThread.includes('routingSignature, routeChanged, conversationHasUserPrompt'), false, 'first-prompt discovery must not trigger a second catalog read')

assert.ok(workThread.includes('const sendInFlightRef = useRef(false)'), 'v3 send in-flight guard must remain authoritative')
assert.ok(workThread.includes('controller.loadMessagePage'), 'v3 transcript paging must remain authoritative')
assert.ok(workThread.includes('startTaskDeskSessionLiveRefresh'), 'v3 live routing must remain authoritative')
assert.ok(workThread.includes('buildConversationTimeline'), 'v3 logical timeline must remain authoritative')

assert.ok(workThread.includes('interactionEnabled'), 'native Session controls must have an explicit machine-connectivity gate')
assert.ok(observer.includes('if (!interactionEnabled) return'), 'model/capability enrichment must pause while the machine reconnects')
assert.ok(adapter.includes('reconcilePendingPromptFromTranscript'), 'a lost mobile POST response must be reconstructed from the authoritative native transcript')
assert.ok(adapter.includes('loadPendingNativeSessionPrompt'), 'transcript reconciliation must be scoped to an actual durable ambiguous prompt')
assert.ok(adapter.includes('markPendingNativeSessionPromptAccepted'), 'transcript-proven delivery must clear the durable request id without resending')
assert.ok(adapter.includes('nativeMessageID'), 'a reconciled request and the native user envelope must retain one logical turn identity')
assert.ok(adapter.includes('PENDING_TRANSCRIPT_CLOCK_SKEW_MS'), 'a remounted Session must not mistake an old repeated prompt for a newly ambiguous delivery')

assert.ok(workThread.includes('REPLY_SETTLE_RECONCILE_MS'), 'an accepted native turn must stay on fast reconciliation until its assistant reply is visible')
assert.ok(workThread.includes('modelBootstrapBlocked'), 'models-capable native Sessions must not become writable before catalog bootstrap settles')

console.log('native Session v3-controller tests passed')
