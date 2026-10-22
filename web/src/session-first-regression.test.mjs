import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8')
const discovery = read('./native-session-discovery.ts')
const continuation = read('./native-session-continuation.ts')
const create = read('./native-session-create.ts')
const prompt = read('./native-session-prompt.ts')
const adapter = read('./native-session-v3-adapter.ts')
const conversationController = read('./conversation-controller.ts')
const observer = read('./components/native-session-observer.tsx')
const home = read('./components/native-session-home-base.tsx')
const actions = read('./components/native-session-actions.tsx')
const rename = read('./components/native-session-rename.tsx')
const workThread = read('./components/work-thread-conversation.tsx')
const liveRefresh = read('./taskdesk-session-live-refresh.ts')
const timeline = read('./work-thread-timeline.ts')
const conversation = read('./components/taskdesk-conversation.tsx')
const messageContent = read('./components/taskdesk-message-content.tsx')
const handoff = read('./native-session-handoff.ts')
const routing = read('./native-session-routing.ts')
const machineMigration = read('./native-session-machine-id-migration.ts')
const standalone = read('./components/standalone-universal-workspace.tsx')
const main = read('./main.tsx')
const api = read('./api.ts')
const daemon = read('../../bridge/src/machine-daemon.js')
const daemonCli = read('../../bridge/src/daemon-cli.js')

// Product identity is Machine -> Project -> real native Session. The failed Conversation-first UI
// is deliberately gone and these guards make its accidental reintroduction a regression.
assert.equal(existsSync(new URL('./components/conversation-workspace.tsx', import.meta.url)), false, 'retired Conversation workspace must stay deleted')
assert.equal(existsSync(new URL('./components/conversation-detail.tsx', import.meta.url)), false, 'retired Conversation detail must stay deleted')
assert.ok(discovery.includes('export type NativeSessionRef'), 'Session-first must keep native Session identity explicit')
assert.ok(discovery.includes('machineID: string') && discovery.includes('agentID: string') && discovery.includes('sessionID: string'), 'native identity must include machine, harness and native Session id')
assert.equal(discovery.includes('createTask('), false, 'discovery must not persist a Task')
assert.equal(discovery.includes('launch('), false, 'discovery must not launch work')

assert.ok(continuation.includes('client.claimSession(target.config, target.directory, target.sessionID)'), 'ACP mutation must still claim the exact native Session when ownership is needed')
assert.equal(continuation.includes('createSession('), false, 'same-Session continuation must not create a replacement Session')

assert.equal(create.includes('createTask('), false, 'native create must not create a Task')
assert.equal(create.includes('Conversation'), true, 'native create comments must explicitly document the no-Conversation boundary')
assert.ok(home.includes('canCreateNativeSession'), 'Session Home must expose only harness transports that passed native create parity')
assert.ok(home.includes('aria-label={t("sf.filterByMachine")}') && home.includes('t("sf.allMachinesCount"'), 'multi-machine navigation must offer an explicit All/single-machine filter')

// Rename/Delete act on the open native Session in its header, not on whichever row happens to be
// selected in the navigation rail. Rename is an inline edit of that header's heading; Delete keeps
// its confirmation panel, because it is not reversible.
assert.equal(home.includes('api.renameSession('), false, 'Session navigation must not own rename mutations')
assert.equal(home.includes('api.deleteSession('), false, 'Session navigation must not own delete mutations')
assert.ok(rename.includes('api.renameSession(target.config, target.sessionID'), 'open Session action must rename the real native Session')
assert.ok(rename.includes('target.renameSupported') && actions.includes('target.deleteSupported'), 'native metadata actions must follow harness capabilities')
assert.ok(actions.includes('t("sf.keepSession")') && actions.includes('t("sf.deleteSession")'), 'native deletion must use an inline translated confirmation')

assert.ok(observer.includes('import { WorkThreadConversation } from "./work-thread-conversation"'), 'native Session detail must mount the mature v3 controller')
assert.ok(observer.includes('<WorkThreadConversation'), 'native Session detail must render WorkThreadConversation directly')
assert.ok(observer.includes('registerNativeSessionV3Adapter'), 'observer must bind the native Session to the mature v3 controller')
assert.ok(observer.includes('controller={controller}'), 'observer must inject the Session-scoped I/O controller explicitly')
assert.ok(observer.includes('api.listCommands(target.config, target.sessionID)'), 'slash command discovery must stay a read scoped to the open native Session')
assert.ok(observer.includes('target.backend === "opencode" || target.backend === "codex"'), 'OpenCode/Codex list-level models must stay provisional until native turn metadata is recovered')
assert.equal(observer.includes('Continue this Session'), false, 'opening a Session must not require a visible writer-claim step')
assert.equal(observer.includes('probeNativeSessionContinuation'), false, 'opening a Session must stay read-only and must not claim ACP ownership')
assert.equal(observer.includes('TaskDeskConversation'), false, 'observer must not bypass the v3 controller and mount the renderer directly')
assert.equal(observer.includes('native-session-feed'), false, 'observer must not own a Session-first feed')
assert.equal(observer.includes('native-session-turns'), false, 'observer must not own a Session-first timeline')
assert.equal(observer.includes('sendNativeSessionPrompt'), false, 'observer must not own send lifecycle')
assert.equal(observer.includes('stopNativeSession'), false, 'observer must not own Stop lifecycle')
assert.equal(observer.includes('startTaskDeskSessionLiveRefresh'), false, 'observer must not own a second live-event controller')
assert.equal(observer.includes('TaskDeskMessageContent'), false, 'observer must not own a second renderer')

assert.ok(adapter.includes('function nativeConversationController(entry: NativeConversationEntry): ConversationController'), 'native Session behavior must be exposed through an explicit scoped controller')
assert.equal(adapter.includes('api.loadMessagePage ='), false, 'native Session mount must not monkey-patch global transcript reads')
assert.equal(adapter.includes('taskClient.getWorkThread ='), false, 'native Session mount must not monkey-patch global task reads')
assert.equal(adapter.includes('taskClient.continueTask ='), false, 'native Session mount must not monkey-patch global send behavior')
assert.equal(adapter.includes('taskClient.cancelWorkThread ='), false, 'native Session mount must not monkey-patch global Stop behavior')
assert.equal(adapter.includes('MachineTask'), false, 'native Session runtime must not depend on MachineTask')
assert.equal(adapter.includes('MachineTaskRun'), false, 'native Session runtime must not depend on MachineTaskRun')
assert.equal(adapter.includes('projectedTask'), false, 'native Session runtime must not synthesize Task projections')
assert.ok(adapter.includes('ConversationRuntime'), 'native Session runtime must expose the neutral conversation domain')
assert.ok(conversationController.includes('export type ConversationController'), 'the mature conversation must expose one explicit I/O contract')
assert.ok(conversationController.includes('taskConversationController'), 'Task-backed conversations must keep an explicit default controller')
assert.ok(adapter.includes('probeNativeSessionContinuation(entry.target)'), 'ACP writer claim must happen lazily at the mutation boundary')
assert.ok(adapter.includes('await ensureWriter(entry)'), 'native Send and Stop must acquire writer ownership transparently')
assert.ok(adapter.includes('sendNativeSessionPrompt(entry.target, prompt, model, body.attachments ?? [])'), 'the native conversation controller must preserve native prompt idempotency while carrying attachments')
assert.ok(adapter.includes('sendNativeSessionCommand(entry.target, body.command.name, body.command.arguments, model)'), 'slash command execution must remain inside the Session-first adapter mutation boundary')
assert.ok(adapter.includes('stopNativeSession(entry.target, operationToken)'), 'the v3 controller adapter must preserve native Stop idempotency')
assert.ok(adapter.includes('Cross-agent continuation is disabled until single-Session parity is validated'), 'single-Session validation must block cross-agent continuation')
assert.ok(adapter.includes('reconcileOpenCodeTranscriptStatus(entry, page, before)'), 'OpenCode completion must reconcile from the native transcript already consumed by v3')
assert.ok(adapter.includes('message.info.time?.completed'), 'OpenCode transcript completion must require native terminal metadata, not assistant-text heuristics')
assert.ok(adapter.includes('entry.forcedStatus !== "running" && !openCodeRecoveryWatchActive'), 'OpenCode ordinary idle/pre-Send reconciliation must not block on the legacy status endpoint outside a bounded recovery watch')
assert.ok(adapter.includes('openCodeAssistantProvesTurnCompleted') && adapter.includes('latestAssistant'), 'OpenCode must decide turn completion from the newest assistant envelope, not any intermediate completed step')
assert.ok(adapter.includes('OPENCODE_IDLE_CONFIRM_MS = 750') && adapter.includes('openCodeIdleObservedAt'), 'OpenCode ambiguous interruptions must require a stable idle state before becoming terminal')
assert.ok(adapter.includes('const terminalError = Boolean(latestAssistant.info.error)') && adapter.includes('if (!terminalError || entry.forcedStatus !== "running") return'), 'OpenCode terminal provider/model errors must have a transcript fallback when the legacy status endpoint omits the Session')
assert.ok(adapter.includes('terminalError ? now + OPENCODE_RECOVERY_WATCH_MS : 0'), 'OpenCode transcript-confirmed errors must retain the bounded late-retry recovery window')
assert.ok(adapter.includes('OPENCODE_RECOVERY_WATCH_MS') && adapter.includes('openCodeRecoveryWatchUntil'), 'OpenCode must retract a terminal-looking interruption when a bounded late retry becomes busy again')
assert.ok(adapter.includes('OPENCODE_SILENT_TURN_GRACE_MS = 15_000') && adapter.includes('armOpenCodeSilentTurnRecovery(entry, id)'), 'an accepted OpenCode prompt with no response must schedule a bounded orphan-turn recovery')
assert.ok(adapter.includes('api.listStatuses(entry.target.config, entry.target.directory)') && adapter.includes('OpenCode ended this request without a response'), 'OpenCode must surface a terminal no-response error only after an authoritative status/transcript check')
assert.ok(adapter.includes('const statuses = await api.listStatuses(entry.target.config)'), 'non-OpenCode projections must retain native status enrichment')
assert.equal(adapter.includes('WORKING_STATUS_GRACE_MS'), false, 'web adapter must not invent a generic stale-working timeout across harnesses')
assert.equal(adapter.includes('TaskDeskConversation'), false, 'adapter must not render chat')
assert.equal(adapter.includes('groupConversationParts'), false, 'adapter must not define reasoning/activity semantics')
assert.equal(adapter.includes('mergeLatestMessagePage'), false, 'adapter must not define a second message merge algorithm')

assert.ok(liveRefresh.includes('const LIFECYCLE_SETTLE_MS = 900'), 'live refresh must keep the completion settle retry bounded and explicit')
assert.ok(liveRefresh.includes('const settleAfterLifecycle = () =>'), 'lifecycle recovery must schedule a single coalesced settle pass')
assert.ok(liveRefresh.includes('onMessage()') && liveRefresh.includes('onIndex()'), 'the settle pass must reconcile transcript and projected lifecycle together')
assert.ok(liveRefresh.includes('if (lifecycleSettleTimer !== undefined) clearTimeout(lifecycleSettleTimer)'), 'multiple status edges must coalesce instead of creating a polling loop')
assert.ok(liveRefresh.includes('event.type === "session.error"') && liveRefresh.includes('target.config.backend === "opencode"') && liveRefresh.includes('settleAfterLifecycle()'), 'OpenCode session.error must trigger the bounded lifecycle settle path')

const handoffBlock = daemon.match(/const handoffSession = async[\s\S]*?const launcher =/)?.[0] || ''
assert.ok(handoffBlock.includes('await checkpoint(result)'), 'handoff target identity must be checkpointed as soon as session/new returns')
assert.ok(daemon.includes('const reconcileHandoff = async'), 'daemon must support read-only reconciliation for ambiguous Session creation')
assert.ok(daemon.includes('beforeSessionIDs'), 'handoff reconciliation must compare against a pre-create Session baseline')
assert.ok(daemonCli.includes('sessionRename: true') && daemonCli.includes('sessionDelete: true'), 'managed OpenCode must advertise its native rename/delete primitives')

assert.ok(workThread.includes('controller.loadMessagePage'), 'v3 WorkThreadConversation must remain transcript paging authority through its explicit I/O boundary')
assert.ok(workThread.includes('buildConversationTimeline'), 'v3 WorkThreadConversation must remain timeline authority')
assert.ok(workThread.includes('startTaskDeskSessionLiveRefresh'), 'v3 WorkThreadConversation must remain live-event authority')
assert.ok(workThread.includes('controller.continueConversation'), 'v3 WorkThreadConversation must remain send controller')
assert.ok(workThread.includes('pendingPrompt.attachments.map'), 'optimistic user turns must keep sent attachments visible immediately')
assert.ok(workThread.includes('command: slashCommand'), 'recognized slash commands must travel through the same conversation controller call')
assert.equal(workThread.includes('api.sendCommand('), false, 'slash commands must not bypass Session-first with the legacy mutation endpoint')
assert.ok(workThread.includes('controller.stopConversation'), 'v3 WorkThreadConversation must remain Stop controller')
assert.ok(workThread.includes('<TaskDeskConversation'), 'v3 WorkThreadConversation must remain the renderer owner')
assert.ok(workThread.includes('createCoalescedTailRefresh'), 'native Session tail refreshes must preserve a final authoritative read arriving during an in-flight read')
assert.ok(timeline.includes('Native user messages are the only conversation boundary'), 'mature v3 native turn boundary semantics must remain authoritative')
assert.ok(timeline.includes('attachmentParts = nativeUserParts.filter'), 'native attachment parts must survive the synthetic user-turn projection')
assert.ok(timeline.includes('part.type === "tool" && part.callID'), 'mature v3 tool update identity must remain authoritative')
assert.ok(timeline.includes('terminalNativeAssistantError'), 'a recovered OpenCode retry must be able to supersede a transient interrupted attempt in the same turn')

assert.equal(conversation.includes('MessageAgentMeta'), false, 'Session-first must not modify the mature shared renderer with alternate agent metadata')
assert.equal(messageContent.includes('conversation-turn-state'), false, 'Session-first must not replace mature v3 reasoning/error semantics')
assert.ok(messageContent.includes('hasTerminalAssistantText'), 'mature v3 assistant terminal-state semantics must remain intact')
assert.ok(messageContent.includes('messageErrorText'), 'mature v3 error rendering must remain intact')
assert.ok(messageContent.includes('AttachmentPartCard') && messageContent.includes('uw-message-attachments'), 'user turns must visibly render attached files/images')

for (const retiredPath of [
  './native-session-feed.ts',
  './native-session-feed.test.mjs',
  './native-session-turns.ts',
  './conversation-turn-state.ts',
  './conversation-turn-state.test.mjs',
  './components/model-selection-control.tsx',
  './components/native-session-handoff-control.tsx',
  './native-session-handoff.css'
]) {
  assert.equal(existsSync(new URL(retiredPath, import.meta.url)), false, `${retiredPath} must not return as a parallel Session-first chat path`)
}

assert.ok(routing.includes('handoffNativeSession(source, targetAgent.id, source.title, model)'), 'cross-agent continuation must use the idempotent native handoff primitive')
assert.ok(routing.includes('api.loadMessagePage(source.config, source.sessionID, source.directory, undefined, 100, false)'), 'handoff context reads must never force ACP history refresh or replay')
assert.ok(routing.includes('writerOwned: true') && routing.includes('requiresExplicitClaim: false'), 'a handoff-created native Session must remain owned without a redundant ACP claim')
assert.ok(observer.includes('canCreateNativeSession(candidate)'), 'handoff choices must follow the same validated native create capability gate')
assert.equal(routing.includes('createTask('), false, 'native handoff must not recreate the retired Task/Conversation path')
assert.equal(routing.includes('createRemoteSessionHandoff'), false, 'cross-machine Session creation must remain deferred until project mapping and recovery are designed')
assert.ok(routing.includes('targetMachine.machineID !== source.machineID'), 'routed continuation must enforce the same-machine boundary')
assert.equal(routing.includes('PENDING_ROUTE_TTL_MS'), false, 'a created target Session must never be forgotten by a blind route TTL')
assert.equal(handoff.includes('PENDING_HANDOFF_TTL_MS'), false, 'ambiguous resource creation must retain its original idempotency key until reconciled')
assert.ok(handoff.includes('acknowledgeNativeSessionHandoff') && !handoff.includes('if (parsed.status === "accepted" && parsed.result) clearPending(source)'), 'accepted creation must remain recoverable until the caller persists its target')
assert.ok(routing.includes('if (!persistPending(source, pending))') && routing.includes('acknowledgeNativeSessionHandoff(source)'), 'route target persistence must happen before creation-key acknowledgement')
assert.equal(routing.includes('loadPendingNativeSessionPrompt'), false, 'route recovery must not shadow the normal prompt pending/TTL semantics')
assert.ok(routing.includes('pending.agentID !== targetAgent.id'), 'a created target Session must keep routing bound to that exact target harness')
const routePendingShape = routing.match(/type PendingRouteContinue = \{[\s\S]*?\n\}/)?.[0] || ''
assert.equal(routePendingShape.includes('prompt:'), false, 'route persistence must own target identity, not duplicate prompt text')
assert.equal(routePendingShape.includes('model:'), false, 'route persistence must own target identity, not duplicate prompt model')
assert.ok(routing.includes('const persistedLink = await api.registerNativeSessionLink'), 'lineage/context persistence must be awaited before first prompt delivery')
assert.ok(routing.indexOf('const persistedLink = await api.registerNativeSessionLink') < routing.indexOf('const sent = await sendNativeSessionPrompt'), 'first routed prompt must wait for durable lineage/context persistence')
assert.ok(routing.includes('registerNativeSessionLink') && routing.includes('transferredContext'), 'same-machine lineage must durably retain transferred context')
assert.ok(routing.includes('sendNativeSessionPrompt'), 'destination change must become real only on Send')
assert.ok(workThread.includes('routing.onContinue') && workThread.includes('routeChanged'), 'mature composer must own send-time harness switching')
assert.equal(workThread.includes('<span>Machine</span>'), false, 'composer must not expose cross-machine handoff selection')
assert.ok(workThread.includes('routeBlockedByAttachments'), 'attachments must block a harness handoff')
assert.equal(standalone.includes('<NativeSessionHandoffControl'), false, 'separate handoff button must stay removed')
assert.ok(standalone.includes('openLinkedSession') && standalone.includes('selectedTransferredContext'), 'linked Sessions must expose lineage/context after reopen')
assert.ok(api.includes('Array.isArray(links) ? links as NativeSessionLinkRecord[] : []'), 'malformed lineage responses must normalize safely')
assert.ok(home.includes('snapshot.machine.id'), 'native Session identity must use daemon machine id')
assert.ok(standalone.includes('migrateNativeSessionMachineStorage(machine.id, snapshot.machine.id)'), 'legacy browser state must migrate to canonical machine id')
for (const prefix of ['native-session-prompt.v1', 'native-session-command.v1', 'native-session-handoff.v1', 'native-session-handoff-context.v1', 'taskdesk.draft.native-session-v3']) {
  assert.ok(machineMigration.includes(prefix), `machine-id migration must preserve ${prefix}`)
}
assert.ok(standalone.includes('<NativeSessionObserver'), 'integrated Sessions workspace must still open native Sessions')
assert.ok(standalone.includes('<NativeSessionHome'), 'Session-first navigation must remain native discovery based')
assert.ok(standalone.includes('<NativeSessionTitle target={selected} onRenamed={handleSessionRenamed} />'), 'open Session header must own rename as an inline edit of its own heading')
assert.ok(standalone.includes('<CommandPalette') && standalone.includes('event.key.toLowerCase() === "k"'), 'Session-first must restore the Ctrl/Cmd+K command palette')
assert.ok(conversation.includes('uw-command-suggestions') && conversation.includes('chooseCommand'), 'the shared composer must restore keyboard-friendly slash command discovery')

// The open Session header carries one identity, not two. Machine and Project already live in the
// top-bar context path, so the eyebrow above the title keeps only the harness identity instead of
// repeating them beside the title.
const eyebrow = standalone.match(/<div className="hr-native-session-eyebrow">[\s\S]*?<\/div>/)?.[0] || ''
assert.ok(eyebrow.includes('selected.agentLabel') && eyebrow.includes('selected.nativeAgent'), 'the Session eyebrow must keep the harness identity')
assert.equal(/selectedMachine|selectedProject/.test(eyebrow), false, 'machine and Project must not be repeated beside the title; the top bar owns them')
assert.ok(standalone.includes('selectedMachine?.name') && standalone.includes('selectedProject'), 'the top-bar context path must keep machine and Project identity')

// An empty machine list is not proof the user has none: desktop resolves its local runtime after the
// first paint. The manager must wait for that settlement, and the empty-list screen must not invite
// the user to add a machine that is already on its way.
assert.ok(standalone.includes('useState(machinesReady && machines.length === 0)'), 'the Machines manager must not auto-open before the machine list has settled')
const managerOpenLine = standalone.match(/const \[managerOpen, setManagerOpen\] = useState\([^\n]*\)/)?.[0] || ''
assert.ok(managerOpenLine.includes('machinesReady && machines.length === 0'), 'the manager initial state must require a settled machine list')
assert.ok(standalone.includes('const machinesLoading = !machinesReady && machines.length === 0'), 'the shell must distinguish a pending machine list from a truly empty one')
assert.ok(main.includes('machinesReady') && main.includes('machinesReady={machinesReady}'), 'the shell must be told when the machine list has settled')

// Re-entering an already-working Session must not re-read the "getting started" label of the Send the
// user watched in an earlier view. Opening the surface bumps a revision the conversation observes, so
// the label is retired even when the phone rail kept the same Session mounted instead of remounting it.
assert.ok(standalone.includes('const [sessionViewRevision, setSessionViewRevision] = useState(0)'), 'the workspace must track Session-surface views')
assert.ok(standalone.includes('setSessionViewRevision((value) => value + 1)'), 'opening a Session must begin a new view')
assert.ok(standalone.includes('surfaceViewRevision={sessionViewRevision}'), 'the opened Session must be told which view it is in')
assert.ok(observer.includes('surfaceViewRevision?: number') && observer.includes('<WorkThreadConversation') && observer.includes('surfaceViewRevision={surfaceViewRevision}'), 'the observer must forward the view revision to the conversation')

// Returning to the foreground may mean a phone slept through a turn's terminal edge. The stale
// streamed status is dropped and the rail is told to re-read the Session index immediately.
const foregroundHandler = standalone.match(/const onVisibility = \(\) => \{[\s\S]*?\n    \}/)?.[0] || ''
assert.ok(foregroundHandler.includes('document.visibilityState !== "visible"'), 'only the hidden-to-visible edge may trigger a resume reset')
assert.ok(foregroundHandler.includes('clearSessionIndexLiveStatuses()'), 'foregrounding must drop stale transient live statuses')
assert.ok(foregroundHandler.includes('setListRevision((value) => value + 1)'), 'foregrounding must force one Session-index re-read')

console.log('session-first v3-first architecture guards passed')