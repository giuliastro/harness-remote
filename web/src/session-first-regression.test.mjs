import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'

const discovery = readFileSync(new URL('./native-session-discovery.ts', import.meta.url), 'utf8')
const continuation = readFileSync(new URL('./native-session-continuation.ts', import.meta.url), 'utf8')
const create = readFileSync(new URL('./native-session-create.ts', import.meta.url), 'utf8')
const prompt = readFileSync(new URL('./native-session-prompt.ts', import.meta.url), 'utf8')
const stop = readFileSync(new URL('./native-session-stop.ts', import.meta.url), 'utf8')
const adapter = readFileSync(new URL('./native-session-v3-adapter.ts', import.meta.url), 'utf8')
const modelRecovery = readFileSync(new URL('./native-session-model.ts', import.meta.url), 'utf8')
const observer = readFileSync(new URL('./components/native-session-observer.tsx', import.meta.url), 'utf8')
const home = readFileSync(new URL('./components/native-session-home.tsx', import.meta.url), 'utf8')
const workThread = readFileSync(new URL('./components/work-thread-conversation.tsx', import.meta.url), 'utf8')
const liveRefresh = readFileSync(new URL('./taskdesk-session-live-refresh.ts', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('./work-thread-timeline.ts', import.meta.url), 'utf8')
const conversation = readFileSync(new URL('./components/taskdesk-conversation.tsx', import.meta.url), 'utf8')
const messageContent = readFileSync(new URL('./components/taskdesk-message-content.tsx', import.meta.url), 'utf8')
const handoff = readFileSync(new URL('./components/native-session-handoff-control.tsx', import.meta.url), 'utf8')
const standalone = readFileSync(new URL('./components/standalone-universal-workspace.tsx', import.meta.url), 'utf8')
const daemon = readFileSync(new URL('../../bridge/src/machine-daemon.js', import.meta.url), 'utf8')
const daemonCli = readFileSync(new URL('../../bridge/src/daemon-cli.js', import.meta.url), 'utf8')

assert.ok(discovery.includes('export type NativeSessionRef'), 'Session-first must keep native Session identity explicit')
assert.ok(discovery.includes('machineID: string') && discovery.includes('agentID: string') && discovery.includes('sessionID: string'), 'native identity must include machine, harness and native Session id')
assert.ok(discovery.includes('listGlobalSessions(config).catch(() => client.listSessions(config))'), 'native discovery must retain global-list fallback')
assert.ok(discovery.includes('renameSupported: agent.capabilities?.sessionRename === true'), 'native discovery must expose rename capability from the harness contract')
assert.ok(discovery.includes('deleteSupported: agent.capabilities?.sessionDelete === true'), 'native discovery must expose delete capability from the harness contract')
assert.equal(discovery.includes('createTask('), false, 'discovery must not persist a Task')
assert.equal(discovery.includes('launch('), false, 'discovery must not launch work')

assert.ok(continuation.includes('client.claimSession(target.config, target.directory, target.sessionID)'), 'ACP mutation must still claim the exact native Session when ownership is needed')
assert.equal(continuation.includes('createSession('), false, 'same-Session continuation must not create a replacement Session')

assert.ok(create.includes('api.createSession(config'), 'New Session must reuse the existing native /session create primitive')
assert.ok(create.includes('agent.backend === "pi" && agent.transport === "acp"'), 'PI native create must remain on its validated ACP transport')
assert.ok(create.includes('agent.backend === "opencode" && agent.transport === "http"'), 'OpenCode native create must remain on its validated managed HTTP transport')
assert.ok(create.includes('writerOwned: true'), 'a freshly created native Session must enter the v3 controller as already writable')
assert.equal(create.includes('createTask('), false, 'native create must not create a Task')
assert.equal(create.includes('Conversation'), true, 'native create comments must explicitly document the no-Conversation boundary')
assert.ok(home.includes('aria-label="New Session"'), 'Session Home must expose New Session')
assert.ok(home.includes('createNativeSessionTarget'), 'Session Home must create a real native Session rather than a Task')
assert.ok(home.includes('canCreateNativeSession'), 'Session Home must expose only harness transports that passed native create parity')
assert.ok(home.includes('aria-label="Filter by machine"') && home.includes('All machines ·'), 'multi-machine navigation must offer an explicit All/single-machine filter')
assert.ok(home.includes('api.renameSession(') && home.includes('api.deleteSession('), 'Session Home must mutate the real native Session for rename/delete')
assert.ok(home.includes('Keep Session') && home.includes('Delete Session'), 'native deletion must use an inline confirmation instead of a blocking browser dialog')

assert.ok(prompt.includes('clientRequestId'), 'native prompts must retain durable mutation identity')
assert.ok(prompt.includes('loadPendingNativeSessionPrompt'), 'lost-response retries must reuse the unresolved request id')
assert.ok(prompt.includes('`/session/${encodeURIComponent(target.sessionID)}/prompt`'), 'native prompt must use the idempotent daemon endpoint')
assert.ok(stop.includes('clientRequestId') && stop.includes('operationToken'), 'native Stop must retain durable per-turn mutation identity')

assert.ok(observer.includes('import { WorkThreadConversation } from "./work-thread-conversation"'), 'native Session detail must mount the mature v3 controller')
assert.ok(observer.includes('<WorkThreadConversation'), 'native Session detail must render WorkThreadConversation directly')
assert.ok(observer.includes('registerNativeSessionV3Adapter'), 'observer must limit Session-first behavior to a compatibility adapter')
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

assert.ok(modelRecovery.includes('info.model?.providerID') && modelRecovery.includes('info.model?.id'), 'OpenCode model recovery must accept the current nested assistant model envelope')
assert.ok(modelRecovery.includes('for (let index = messages.length - 1; index >= 0; index -= 1)'), 'model recovery must choose the newest model-bearing native message regardless of role')
assert.ok(modelRecovery.includes('PAGE_MODEL_BACKENDS = new Set(["omp", "pi", "codex"])'), 'journal-backed model recovery must remain explicit and scoped')

assert.ok(adapter.includes('api.loadMessagePage = async function patchedLoadMessagePage'), 'adapter must feed the existing v3 paging path rather than loading a parallel transcript')
assert.ok(adapter.includes('taskClient.continueTask = async function patchedContinueTask'), 'native continuation must enter the same v3 controller call site')
assert.ok(adapter.includes('taskClient.cancelWorkThread = async function patchedCancelWorkThread'), 'native Stop must enter the same v3 controller call site')
assert.ok(adapter.includes('probeNativeSessionContinuation(entry.target)'), 'ACP writer claim must happen lazily at the mutation boundary')
assert.ok(adapter.includes('await ensureWriter(entry)'), 'native Send and Stop must acquire writer ownership transparently')
assert.ok(adapter.includes('sendNativeSessionPrompt(entry.target, prompt, model)'), 'the v3 controller adapter must preserve native prompt idempotency')
assert.ok(adapter.includes('stopNativeSession(entry.target, operationToken)'), 'the v3 controller adapter must preserve native Stop idempotency')
assert.ok(adapter.includes('Cross-agent continuation is disabled until single-Session parity is validated'), 'single-Session validation must block cross-agent continuation')
assert.ok(adapter.includes('value === "retry"') && adapter.includes('value === "waiting"'), 'native retry and waiting states must remain working')
assert.ok(adapter.includes('reconcileOpenCodeTranscriptStatus(entry, page, before)'), 'OpenCode completion must reconcile from the native transcript already consumed by v3')
assert.ok(adapter.includes('message.info.time?.completed'), 'OpenCode transcript completion must require native terminal metadata, not assistant-text heuristics')
assert.ok(adapter.includes('if (entry.target.backend === "opencode") return'), 'OpenCode pre-Send reconciliation must not block on the legacy status endpoint')
assert.ok(adapter.includes('const statuses = await api.listStatuses(entry.target.config)'), 'non-OpenCode projections must retain the existing lightweight status enrichment')
assert.equal(adapter.includes('api.listStatuses(entry.target.config, entry.target.directory)'), false, 'OpenCode recovery must not reintroduce an unbounded directory-scoped status wait')
assert.equal(adapter.includes('TaskDeskConversation'), false, 'adapter must not render chat')
assert.equal(adapter.includes('groupConversationParts'), false, 'adapter must not define reasoning/activity semantics')
assert.equal(adapter.includes('mergeLatestMessagePage'), false, 'adapter must not define a second message merge algorithm')

assert.ok(liveRefresh.includes('const LIFECYCLE_SETTLE_MS = 900'), 'live refresh must keep the completion settle retry bounded and explicit')
assert.ok(liveRefresh.includes('const settleAfterLifecycle = () =>'), 'lifecycle recovery must schedule a single coalesced settle pass')
assert.ok(liveRefresh.includes('onMessage()') && liveRefresh.includes('onIndex()'), 'the settle pass must reconcile transcript and projected lifecycle together')
assert.ok(liveRefresh.includes('if (lifecycleSettleTimer !== undefined) clearTimeout(lifecycleSettleTimer)'), 'multiple status edges must coalesce instead of creating a polling loop')

assert.ok(daemon.includes('/prompt_async${query}'), 'managed OpenCode must keep its native asynchronous prompt endpoint')
assert.equal(daemon.includes('agent: agentID'), false, 'machine harness id must never be sent as an OpenCode internal agent id')
assert.ok(daemon.includes('await claimSession(agentID, sessionID)'), 'ACP Stop must transparently recover writer ownership when needed')
assert.ok(daemonCli.includes('sessionRename: true') && daemonCli.includes('sessionDelete: true'), 'managed OpenCode must advertise its native rename/delete primitives')

assert.ok(workThread.includes('api.loadMessagePage'), 'v3 WorkThreadConversation must remain transcript paging authority')
assert.ok(workThread.includes('buildWorkThreadTimeline'), 'v3 WorkThreadConversation must remain timeline authority')
assert.ok(workThread.includes('startTaskDeskSessionLiveRefresh'), 'v3 WorkThreadConversation must remain live-event authority')
assert.ok(workThread.includes('taskClient.continueTask'), 'v3 WorkThreadConversation must remain send controller')
assert.ok(workThread.includes('taskClient.cancelWorkThread'), 'v3 WorkThreadConversation must remain Stop controller')
assert.ok(workThread.includes('<TaskDeskConversation'), 'v3 WorkThreadConversation must remain the renderer owner')
assert.ok(timeline.includes('Native user messages are the only conversation boundary'), 'mature v3 native turn boundary semantics must remain authoritative')
assert.ok(timeline.includes('part.type === "tool" && part.callID'), 'mature v3 tool update identity must remain authoritative')
assert.ok(timeline.includes('terminalNativeAssistantError'), 'a recovered OpenCode retry must be able to supersede a transient interrupted attempt in the same turn')

assert.equal(conversation.includes('MessageAgentMeta'), false, 'Session-first must not modify the mature conversation renderer with alternate agent metadata')
assert.equal(messageContent.includes('conversation-turn-state'), false, 'Session-first must not replace mature v3 reasoning/error semantics')
assert.ok(messageContent.includes('hasTerminalAssistantText'), 'mature v3 assistant terminal-state semantics must remain intact')
assert.ok(messageContent.includes('messageErrorText'), 'mature v3 error rendering must remain intact')

for (const retiredPath of [
  './native-session-feed.ts',
  './native-session-feed.test.mjs',
  './native-session-turns.ts',
  './conversation-turn-state.ts',
  './conversation-turn-state.test.mjs',
  './components/model-selection-control.tsx',
  './native-session-handoff.css'
]) {
  assert.equal(existsSync(new URL(retiredPath, import.meta.url)), false, `${retiredPath} must not return as a parallel Session-first chat path`)
}

assert.match(handoff, /export function NativeSessionHandoffControl\(_props: Props\)\s*\{\s*return null\s*\}/, 'cross-agent handoff UI must remain disabled during single-Session stabilization')
assert.ok(standalone.includes('<NativeSessionObserver'), 'integrated Sessions workspace must still open native Sessions')
assert.ok(standalone.includes('<NativeSessionHome'), 'Session-first navigation must remain native discovery based')
assert.ok(standalone.includes('onDeleted={handleSessionDeleted}'), 'deleting the selected native Session must clear its detail surface')

console.log('session-first v3-first architecture guards passed')
