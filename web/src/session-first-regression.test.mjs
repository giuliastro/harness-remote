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
const sessionActions = readFileSync(new URL('./components/native-session-actions.tsx', import.meta.url), 'utf8')
const workThread = readFileSync(new URL('./components/work-thread-conversation.tsx', import.meta.url), 'utf8')
const liveRefresh = readFileSync(new URL('./taskdesk-session-live-refresh.ts', import.meta.url), 'utf8')
const timeline = readFileSync(new URL('./work-thread-timeline.ts', import.meta.url), 'utf8')
const conversation = readFileSync(new URL('./components/taskdesk-conversation.tsx', import.meta.url), 'utf8')
const messageContent = readFileSync(new URL('./components/taskdesk-message-content.tsx', import.meta.url), 'utf8')
const continueWith = readFileSync(new URL('./native-session-continue-with-agent.ts', import.meta.url), 'utf8')
const titleEditor = readFileSync(new URL('./components/native-session-title-editor.tsx', import.meta.url), 'utf8')
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
assert.ok(home.includes('t("sf.newSession")'), 'Session Home must expose New Session')
assert.ok(home.includes('createNativeSessionTarget'), 'Session Home must create a real native Session rather than a Task')
assert.ok(home.includes('canCreateNativeSession'), 'Session Home must expose only harness transports that passed native create parity')
assert.ok(home.includes('t("sf.filterByMachine")') && home.includes('sf.allMachinesCount'), 'multi-machine navigation must offer an explicit All/single-machine filter')
// Rename lives on the title, delete in the actions row; both mutate the real native Session
// through the harness that owns it. See the rename section further down.
assert.ok(titleEditor.includes('api.renameSession(target.config, target.sessionID'), 'a native rename must be routed to the harness that owns the open Session')
assert.ok(sessionActions.includes('api.deleteSession(target.config, target.sessionID'), 'and so must a delete')
assert.ok(sessionActions.includes('sf.keepSession') && sessionActions.includes('sf.deleteSession'), 'native deletion must use an inline confirmation instead of a blocking browser dialog')
assert.ok(titleEditor.includes('target.renameSupported'), 'the title must stay read-only for a harness that cannot rename')
assert.ok(sessionActions.includes('target.deleteSupported'), 'and Delete must stay hidden for one that cannot delete')
assert.equal(home.includes('api.renameSession(') || home.includes('api.deleteSession('), false, 'the Session list must not own a second rename/delete path')
assert.ok(standalone.includes('<NativeSessionActions target={selected}'), 'Rename/Delete must act on the Session open in the chat header')
assert.ok(standalone.includes('refreshToken={listRevision}'), 'a native rename/delete must refresh the Session list instead of waiting for its own cycle')
assert.equal(home.includes('sf.refreshSessions') || home.includes('aria-label="Refresh Sessions"'), false, 'the Session list must not duplicate the workspace refresh control')
assert.ok(home.includes('toggleMachineCollapsed'), 'machine groups in the Session list must be collapsible')
assert.ok(home.includes('aria-expanded={!machineCollapsed}'), 'a collapsible machine group must announce its state')
// The brand mark is the real app artwork, at the small size the 32px mark actually needs: the
// 593KB app-icon.png was downscaled by the browser on every load for no visible gain.
assert.ok(standalone.includes('icon-192.png'), 'the workspace brand mark must be the real app icon')
assert.ok(!standalone.includes('>H<'), 'the letter placeholder must not remain as the brand mark')

// UI/UX polish guards for the Session-first chrome. Each of these was a real defect in the first
// pass of these controls, so they are asserted rather than left to a later visual review.
const workbenchCss = readFileSync(new URL('./session-first-workbench.css', import.meta.url), 'utf8')
assert.ok(sessionActions.includes('hr-session-action-backdrop'), 'a Tab-trapping aria-modal panel must render the scrim its modality claims')
assert.ok(workbenchCss.includes('.hr-session-actions > .tdw-icon-button { width: 44px; height: 44px; }'), 'the only phone-reachable Session mutations must meet the platform touch target')
assert.ok(workbenchCss.includes('.hr-native-machine-heading:active'), 'the machine collapse control must give pressed feedback')
assert.ok(workbenchCss.includes('.hr-native-machine-heading:focus-visible'), 'the machine collapse control must show keyboard focus')
assert.match(workbenchCss, /prefers-reduced-motion: reduce\)\s*\{[^}]*hr-native-machine-chevron/, 'the collapse chevron must honour reduced motion')

// Measured proportions (scripts/measure-session-first-layout.mjs, viewport 1875px). Each number
// here was a defect: a 390px rail carrying 10-11.5px type, a 900px row that left 585px of the pane
// unused and never grew, and a table that shrank to 391px - narrower than the prose above it.
assert.match(workbenchCss, /--hrsf-rail-width: clamp\(300px, 22vw, 356px\)/, 'the Session rail must stay proportionate to its own type')
// One column, sized between the two clients this is measured against: ChatGPT's reading column is
// 96 characters, Claude Code's 132, and 880px at 15px prose is 112. Prose, code, tables and the
// composer all share it, so nothing beside the paragraph is wider than the paragraph.
assert.match(workbenchCss, /--hrsf-content-width: min\(880px, 100%\)/, 'the column must stay sized to the reference clients')
assert.match(workbenchCss, /\.hr-native-session-observer \.tdw-work-thread-conversation \{\s*--hr-chat-measure: 100%/, 'prose must not carry a cap narrower than the column it sits in')
assert.match(workbenchCss, /\.hr-native-session-observer \.uw-markdown \{\s*font-size: 15px/, 'prose type must match the size the reference clients set')
// `ch` is the advance of "0" in the resolved font, and Inter is used here only when installed, so a
// `ch` measure is a different width on every machine. Two people measuring one build disagreed.
assert.doesNotMatch(workbenchCss, /--hr-chat-measure:[^;]*ch\b/, 'the reading measure must not be expressed in ch')
assert.ok(workbenchCss.includes('.hr-native-session-observer .uw-markdown > table {'), 'a table must take the row width rather than shrink to fit')
assert.match(workbenchCss, /\.hr-native-session-observer \.uw-markdown > table \{[^}]*overflow-x: auto/, 'a wide table must scroll in its own container, never the page body')
assert.ok(workbenchCss.includes('.hr-native-session-observer .uw-markdown > table th'), 'the v3 renderer had no table styling at all; the header row must be styled')
// The rail's smallest label was 10px. Nothing in the rail may go back below 11px.
for (const rule of [/\.hr-native-session-copy strong \{\s*font-size: 13px/, /\.hr-native-session-copy small \{[^}]*font-size: 11px/, /\.hr-native-machine-heading strong \{[^}]*font-size: 13px/]) {
  assert.match(workbenchCss, rule, `rail type step regressed: ${rule}`)
}
// The composer shares the transcript's inset, so its edges land on the message rows' edges.
assert.match(workbenchCss, /\.hr-native-session-observer \.uw-composer-shell \{[^}]*calc\(100% - 2 \* clamp\(18px, 3vw, 34px\)\)/, 'the composer must align to the transcript column')

// U+2304 rendered only where the resolved font carried it, so on Windows without Inter the collapse
// controls had no visible marker at all. Both rail headings and the model picker use a real icon.
for (const [file, source] of [["native-session-home.tsx", home], ["model-picker.tsx", readFileSync(new URL('./components/model-picker.tsx', import.meta.url), 'utf8')]]) {
  assert.ok(source.includes('<ChevronDownIcon'), `${file} must use a real chevron icon`)
  assert.equal(source.includes('\u2304'), false, `${file} must not use a text glyph as a control affordance`)
}

// Session-first truth: the native Session is the whole thread, so no native turn may be dropped
// because no Run prompt claimed it, and the harness's own title may not leak a transport envelope.
assert.ok(observer.includes('nativeSessionTruth'), 'the native Session surface must render every native turn')
assert.ok(timeline.includes('unmatchedNativeTurnEntries'), 'the timeline must be able to render native turns no Run matched')
assert.ok(discovery.includes('corroboratedSessionStatus'), 'a reported working status must be corroborated by real Session activity')
assert.ok(discovery.includes('nativeSessionDisplayTitle'), 'a Session titled with a handoff packet must be shown by its instruction')

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
assert.ok(adapter.includes('sendNativeSessionPrompt(entry.target, prompt, model, body.attachments ?? [])'), 'the v3 controller adapter must preserve native prompt idempotency and carry its images')
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
  './native-session-handoff.css',
  './components/native-session-handoff-control.tsx'
]) {
  assert.equal(existsSync(new URL(retiredPath, import.meta.url)), false, `${retiredPath} must not return as a parallel Session-first chat path`)
}

// Cross-agent continuation is asserted in the E3 section below; it is now the header's agent
// selector rather than a button of its own.
assert.ok(standalone.includes('<NativeSessionObserver'), 'integrated Sessions workspace must still open native Sessions')
assert.ok(standalone.includes('<NativeSessionHome'), 'Session-first navigation must remain native discovery based')
assert.ok(standalone.includes('onDeleted={handleSessionDeleted}'), 'deleting the selected native Session must clear its detail surface')

console.log('session-first v3-first architecture guards passed')

// --- B1: the Session-first surface speaks every language the picker offers --------------------
// The picker offered four languages and only the page it lived on used them, so choosing one
// changed a handful of labels and left the product in English.
const i18nSource = readFileSync(new URL('./i18n.ts', import.meta.url), 'utf8')
const translator = readFileSync(new URL('./useTranslator.ts', import.meta.url), 'utf8')

assert.ok(translator.includes('APP_PREFERENCES_CHANGED_EVENT'), 'the translator hook must follow the persisted language live')
for (const [name, source] of [
  ["native-session-home.tsx", home],
  ["standalone-universal-workspace.tsx", standalone],
  ["native-session-actions.tsx", sessionActions],
  ["work-thread-conversation.tsx", workThread],
  ["taskdesk-conversation.tsx", conversation]
]) {
  assert.ok(source.includes('useTranslator'), `${name} must render through the translator`)
}

// Every language carries every Session-first key: a missing one silently falls back to English,
// which is the failure this section exists to prevent.
const sfKeys = [...i18nSource.matchAll(/^  \| '(sf\.[^']+)'$/gm)].map((match) => match[1])
assert.ok(sfKeys.length > 100, `expected the Session-first key set, found ${sfKeys.length}`)
for (const language of ['en', 'it', "'zh-TW'", "'zh-CN'"]) {
  const marker = language.startsWith("'") ? `\n  ${language}: {` : `\n  ${language}: {`
  const start = i18nSource.indexOf(marker)
  assert.ok(start > 0, `dictionary ${language} not found`)
  const block = i18nSource.slice(start, i18nSource.indexOf('\n  }', start))
  const missing = sfKeys.filter((key) => !block.includes(`'${key}':`))
  assert.equal(missing.length, 0, `${language} is missing ${missing.length} Session-first keys: ${missing.slice(0, 5)}`)
}

// Strings that used to be hard-coded in the rail and the chat must not come back.
for (const [name, source] of [["native-session-home.tsx", home], ["standalone-universal-workspace.tsx", standalone]]) {
  for (const literal of ['"Search sessions"', '"New Session"', '"All harnesses"', '"Machine offline"']) {
    assert.equal(source.includes(literal), false, `${name} still hard-codes ${literal}`)
  }
}

// --- E3: continuing with another coding agent -------------------------------------------------
// A native Session belongs to one harness, so continuing elsewhere means creating a real Session on
// the target and carrying the conversation into its first prompt.
//
// This was a "Continue with another agent" button in the chat header, and the button was the
// problem: it named an operation without saying when it applied, and it duplicated a choice the
// header already presents next to the model. It is now what the header's agent selector does.
assert.equal(existsSync(new URL('./components/native-session-handoff-control.tsx', import.meta.url)), false,
  'the separate handoff button must not come back: the header selector is the entry point')
assert.equal(standalone.includes('NativeSessionHandoffControl'), false, 'and the shell must not mount it')
assert.equal(workbenchCss.includes('.hr-session-handoff'), false, 'nor style it')

assert.ok(continueWith.includes('handoffNativeSession('), 'continuing must call the real daemon handoff')
assert.ok(continueWith.includes('handoffContextPending'), 'the target must know it still owes its context packet')
assert.ok(continueWith.includes('sourceHistory'), 'the source transcript must travel with the continuation')
assert.ok(continueWith.includes('writerOwned: true'), 'a Session this bridge just created must not ask for a second claim')
// The user already wrote the message. A continuation that lands on an empty Session is
// indistinguishable from having lost it.
assert.match(continueWith, /sendNativeSessionPrompt\(target, prompt, model, attachments\)/,
  'the message must travel with the continuation, not wait to be retyped')

// The selector only offers harnesses that could actually host the conversation, and only the next
// message acts on the choice - nothing happens when it changes.
assert.ok(observer.includes('continuationCandidates'), 'the observer must offer the machine\'s other harnesses')
assert.match(observer, /agents=\{conversationAgents\}/, 'and pass them to the chat header')
assert.match(observer, /onContinueWithAgent=\{candidates\.length \? continueWithAgent : undefined\}/,
  'with nowhere to continue to, the selector must not appear at all')
assert.ok(workThread.includes('agents.length > 1 ?'), 'the agent select must render only where there is a real choice')
assert.match(workThread, /if \(continueElsewhere && targetAgentID !== currentAgentID\)/,
  'sending with another agent selected must continue there instead of prompting this Session')
assert.ok(workThread.includes('sf.continuesInNewSession'),
  'the selector must say that the next message lands on a new Session, which the button never explained')
assert.ok(workThread.includes('aria-describedby={continuingElsewhere ? "tdw-continue-elsewhere" : undefined}'),
  'and that explanation must be reachable from the control it belongs to')
const observerCss = readFileSync(new URL('./native-session-observer.css', import.meta.url), 'utf8')
assert.doesNotMatch(
  observerCss,
  /\.hr-native-session-observer \.tdw-agent-control > label:first-child \{\s*display: none/,
  'a phantom control must be removed rather than hidden'
)
// The label carried the container's own class, which constrained both and collapsed the toolbar to
// "Co…" and "Harn…" while every behavioural check still passed.
assert.equal(workThread.includes('<label className="tdw-agent-control">'), false,
  'the agent label must not reuse the toolbar container class it lives inside')

// --- Renaming happens on the title ------------------------------------------------------------
// A modal with a heading, a subtitle, a labelled field and two buttons, to change one line of text,
// anchored to an icon button in the corner - which is how its input came to overflow the panel.
assert.ok(titleEditor.includes('api.renameSession'), 'the title itself must perform the rename')
assert.match(titleEditor, /if \(event\.key === "Enter"\)/, 'Enter commits')
assert.match(titleEditor, /else if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); cancel\(\) \}/, 'Escape abandons')
assert.match(titleEditor, /onBlur=\{\(\) => void commit\(\)\}/, 'and leaving the field commits rather than losing the edit')
assert.ok(titleEditor.includes('abandonRef'), 'Escape must not then commit through the blur it causes')
assert.ok(titleEditor.includes('aria-describedby={error ? "hr-session-title-error" : undefined}'),
  'a rename that fails must say so next to the field, not somewhere else')
assert.ok(standalone.includes('<NativeSessionTitleEditor'), 'the header must mount the editable title')
assert.equal(standalone.includes('<h1>{selected.title}</h1>'), false, 'and not a read-only heading beside a pencil')
// Delete keeps its confirmation. It is the one action in this header that cannot be undone.
assert.equal(sessionActions.includes('renameSession'), false, 'rename must have left the actions row entirely')
assert.equal(sessionActions.includes('PencilIcon'), false, 'including its trigger')
assert.ok(sessionActions.includes('sf.deleteSessionTitle'), 'deleting still asks first')
assert.match(workbenchCss, /\.hr-session-title-input \{[^}]*font-size: inherit/s,
  'the field must be the size of the heading it replaces, or the edit is not in place')

// --- D1 / D3 / D4 -----------------------------------------------------------------------------
// D1: the 2.x shell persisted a draggable sidebar width and this one had a fixed rail.
assert.ok(standalone.includes('RAIL_WIDTH_STORAGE_KEY'), 'the Session rail width must persist')
assert.ok(standalone.includes('role="separator"') && standalone.includes('tabIndex={0}'),
  'the rail divider must be a real separator, operable without a pointer')
assert.match(standalone, /onKeyDown=\{\(event\) => \{[^}]*ArrowLeft/s, 'arrow keys must resize the rail')
assert.ok(workbenchCss.includes('.hr-rail-resizer'), 'the rail divider needs its grab area and focus ring')

// D3: `--td3-shadow-panel` and `--td3-scrim` have light-mode variants; a hardcoded black does not.
assert.equal(workbenchCss.includes('rgba(0, 0, 0'), false, 'shadows and scrims must come from the theme tokens')

// D4: with the chat full-screen on a phone the rail cannot show that a Session needs input.
assert.ok(standalone.includes('hr-mobile-nav-badge'), 'the mobile Sessions tab must carry the attention count')
assert.ok(home.includes('onAttentionCountChange'), 'the rail must report the count it already computes')

// --- E2: an unreachable machine keeps its Sessions, marked as a cache -------------------------
// The group used to empty to "This machine is unavailable" while the last successful discovery was
// still in memory, so on an intermittent network the list vanished and returned by itself.
assert.ok(home.includes('lastKnownRef'), 'the rail must remember the last successful read per machine')
assert.ok(home.includes('cached: true'), 'Sessions served from that memory must be marked as a cache')
assert.ok(home.includes('sf.showingCached'), 'an offline machine must say its list is a cache, not live truth')
assert.ok(workbenchCss.includes('.hr-native-session-row.cached'), 'a cached row must not read as live state')
// A rename or delete cannot land on an unreachable machine; offering it produces a network error
// where an explanation belongs.
assert.ok(sessionActions.includes('machineOnline'), 'mutations must be withdrawn while the machine is unreachable')
assert.ok(standalone.includes('machineOnline={selectedRuntime?.state === "online"}'), 'the shell must pass the machine reachability through')

// The empty state is a centred column, not copy centred by inheritance with a stray icon at the
// block's left edge. Geometry is asserted by `EMPTY_CHECK=1 npm run measure:session-first`, which
// requires the icon, the heading and the block to share one centre.
assert.match(workbenchCss, /\.hr-native-startup \{[^}]*display: grid;[^}]*justify-items: center/s,
  'the empty state must centre its own children rather than inherit text-align')
assert.match(workbenchCss, /\.hr-native-startup \{[^}]*width: min\(var\(--hrsf-content-width\)/s,
  'the empty state must occupy the column a transcript will')

// The column stops dead-centring itself on a wide pane: an 880px column centred in a 1440px pane
// leaves 280px between the Session list and the first character, which reads as text pushed right.
// Width is unchanged - longer lines are not the fix - only where the column sits.
assert.match(workbenchCss, /--hrsf-column-inset: clamp\(0px, 6vw, 88px\)/, 'the column needs a bounded leading inset')
for (const selector of ['uw-message', 'uw-composer-shell', 'uw-history-loader']) {
  assert.ok(workbenchCss.includes('var(--hrsf-column-inset)'), `${selector} must share the column's inset`)
}

// Older transcript pages: a real part of the conversation, not a ghost button in the left margin.
assert.ok(workbenchCss.includes('.hr-native-session-observer .uw-history-loader'),
  'the history loader must be laid out inside the conversation column')
assert.match(workbenchCss, /\.uw-history-loader::before[\s\S]{0,200}flex: 1/, 'it must read as a divider across the column')
assert.ok(conversation.includes('t("sf.loadOlder")'), 'the history loader must speak the chosen language')

// Older pages always loaded and were always inserted in the right place - under the button, above
// what was there. What was wrong twice over was where the view ended up. Anchoring the reading
// position exactly is right for infinite scroll and wrong for a button: the press looks like nothing
// happened. Landing on the junction between old and new is worse - it scrolls the reader towards the
// *end* of the conversation, which is the opposite of "show me what came before".
assert.ok(conversation.includes('useLayoutEffect'), 'the reposition must run after the commit that rendered the page')
assert.ok(conversation.includes('pendingOlderRef'), 'the measurements must be handed to that effect, not captured in a frame callback')
assert.match(conversation, /if \(messages\.length <= pending\.previousCount\) return/,
  'the effect must wait for the render that added the page, keyed on the count rather than a height that settles late')
assert.match(conversation, /nearBottomRef\.current = false[\s\S]{0,200}refreshJumpAffordances/,
  'reading history must leave follow-to-bottom, or it immediately undoes the reposition')
assert.match(conversation, /element\.scrollTop = 0/, 'the view must land at the top, where the revealed history begins')
assert.doesNotMatch(conversation, /OLDER_JUNCTION_OVERLAP/, 'and never below what it just revealed')
// A 400ms release lost the race against a parent that fetches and then re-renders, and
// follow-to-bottom then took the transcript to the end - the "it only scrolls" report.
assert.match(conversation, /OLDER_GUARD_TIMEOUT_MS = 20_000/, 'the guard must outlast a slow older page')
// Geometry is asserted by `PAGING_CHECK=1 OLDER=1 VH=520 npm run measure:session-first`, from the
// position that exposes both failures: scrolled to the end of a transcript taller than the viewport.

// --- The Activity section of a finished turn ---------------------------------------------------
// It said "Working" on conversations that had ended days ago. Both rules that make an Activity group
// running read progress off part metadata - a tool state that never reached a terminal value, a
// reasoning part with a start and no end - and on a finished turn that metadata is not progress, it
// is a gap in what the harness wrote. Claude leaves exactly that gap: a thought is closed by the
// next part in the same message, so a turn whose last part is a thought never closes it.
const parts = readFileSync(new URL('./conversation-parts.ts', import.meta.url), 'utf8')
assert.match(parts, /turnCompleted\?: boolean/, 'grouping must be able to know the turn is over')
assert.match(parts, /if \(turnCompleted\) return "completed"/, 'nothing can still be running inside a turn that ended')
assert.match(messageContent, /turnCompleted: message\.info\.role === "assistant" && !liveAssistant/,
  'only the active Run\'s message is live; every other assistant turn is over whatever its parts claim')
// And the bridge stops producing the gap, so new transcripts do not depend on the client healing them.
const acpService = readFileSync(new URL('../../bridge/src/acp-service.js', import.meta.url), 'utf8')
assert.match(acpService, /#closeOpenReasoning\(sessionID\)/, 'a turn that ends must close the thought it ended on')
assert.match(acpService, /#replaying\.delete\(sessionID\)\s*\n\s*\/\/[\s\S]{0,200}#closeOpenReasoning/,
  'a replayed Session was never active here, so nothing else would ever close its thoughts')

// --- A2: images in the composer ---------------------------------------------------------------
// The bridge server already validated and forwarded attachments, and `attachments.ts` already
// converted files. What was missing: the composer had no picker, the native prompt body had no
// parts, and the daemon passed a hardcoded empty array to the ACP service - so a capability that
// existed end to end could never be reached.
assert.ok(conversation.includes('fileToAttachment'), 'the composer must convert picked files')
assert.ok(conversation.includes('onPaste') && conversation.includes('onDrop'),
  'an image usually arrives by paste or drop, not through a file dialog')
assert.match(conversation, /canSend = Boolean\(\(draft\.trim\(\) \|\| attachments\.length\)/,
  'an image with no words is a prompt')
assert.ok(workThread.includes('attachmentsSupported'), 'the picker must be offered only where the harness accepts images')
assert.match(workThread, /if \(staged\.length\) setAttachments/, 'a failed send must give the images back')
const nativePrompt = readFileSync(new URL('./native-session-prompt.ts', import.meta.url), 'utf8')
assert.match(nativePrompt, /\.\.\.\(parts\.length \? \{ parts \} : \{\}\)/, 'the native prompt body must carry the parts')
assert.ok(!nativePrompt.includes('attachments: pending'), 'megabytes of base64 must not go into the pending-prompt store')
const daemon2 = readFileSync(new URL('../../bridge/src/machine-daemon.js', import.meta.url), 'utf8')
assert.match(daemon2, /service\.prompt\(sessionID, text, modelWireName\(resolvedModel\), attachments/,
  'the daemon must forward the attachments instead of a hardcoded empty array')
assert.match(daemon2, /attachments: Boolean\(entry\.host\?\.promptCapabilities\?\.image\)/,
  'attachment support is what the live adapter negotiated, not a declared profile flag')

// --- B3: command palette and keyboard navigation ----------------------------------------------
// A project collapses to five rows with a "show more", so on a machine with hundreds of Sessions
// most of them are reachable only by expanding and scrolling. `CommandPalette` already existed in
// `shell.tsx` with its stylesheet, imported by nothing the product mounts. Cmd/Ctrl+K now opens it
// over the Session-first shell with every visible Session in it.
assert.ok(standalone.includes('import { CommandPalette, type PaletteCommand } from "./shell"'),
  'the shell must mount the palette that already existed rather than grow a second one')
assert.match(standalone, /event\.key\.toLowerCase\(\) !== "k" \|\| !\(event\.metaKey \|\| event\.ctrlKey\)/,
  'the palette must answer to Cmd+K and Ctrl+K, not one of the two')
assert.match(standalone, /run: \(\) => openSession\(entry\.target\)/,
  'a palette entry must open the real native Session, not a reconstructed target')
assert.ok(standalone.includes('onSessionsChange={setDirectory}'),
  'the palette must list what the rail discovered instead of running a second discovery pass')
assert.ok(home.includes('export type SessionDirectoryEntry'), 'the rail must publish what it found')
assert.match(home, /onSessionsChange\?\: \(entries: SessionDirectoryEntry\[\]\) => void/,
  'reporting the visible Sessions must be optional, so the rail still works unwired')
// The reported entries have to be built from the same helpers the rows use, or the palette shows a
// handoff envelope where the row shows a title.
assert.match(home, /onSessionsChange\(groups\.flatMap[\s\S]{0,600}nativeSessionDisplayTitle/,
  'palette labels must go through the same title normaliser as the rows')
assert.match(home, /onSessionsChange\(groups\.flatMap[\s\S]{0,600}nativeSessionSurfaceTarget/,
  'palette entries must carry a real surface target')
// Up/Down in the rail move real DOM focus, so assistive technology follows the selection.
assert.match(standalone, /if \(event\.key !== "ArrowDown" && event\.key !== "ArrowUp"\) return/,
  'the rail must handle vertical arrows itself')
assert.match(standalone, /rows\[next\]\.focus\(\)[\s\S]{0,120}scrollIntoView\(\{ block: "nearest" \}\)/,
  'arrowing must move focus and keep the focused row on screen')
for (const key of ['sf.palettePlaceholder', 'sf.paletteEmpty', 'sf.paletteNavigate', 'sf.paletteRun', 'sf.paletteClose']) {
  assert.ok(sfKeys.includes(key), `${key} must be declared so all four languages carry it`)
}
// Behaviour is asserted by `PALETTE_CHECK=1 npm run measure:session-first`, which presses Ctrl+K,
// types a title that only exists behind the rail's "show more", presses Enter, and requires the
// detail pane to show that exact Session - then Escape to close, and ArrowDown/ArrowUp to move
// focus between rows.

// --- A4: search that reaches the transcripts ---------------------------------------------------
// The rail's query matched titles, projects and machines - never a word that was said. Searching by
// asking each harness to replay its Sessions is not an option: replay is a single-writer operation,
// so it would contend for the lock that decides who owns a Session, and one query over a few hundred
// Sessions would be hundreds of `session/load` calls. Every harness already writes its own JSONL
// journal, and that file is readable without touching the agent.
const transcriptSearch = readFileSync(new URL('../../bridge/src/session-transcript-search.js', import.meta.url), 'utf8')
const bridgeServer = readFileSync(new URL('../../bridge/src/server.js', import.meta.url), 'utf8')
const profiles = readFileSync(new URL('../../bridge/src/harness-profiles.js', import.meta.url), 'utf8')
const clientSearch = readFileSync(new URL('./native-session-search.ts', import.meta.url), 'utf8')
const apiClient = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')

// Asserted on its imports rather than its prose: a searcher that can only reach `node:fs` cannot
// reach an agent, whatever a future edit adds to the body.
assert.deepEqual(
  [...transcriptSearch.matchAll(/^import .* from "([^"]+)"$/gm)].map((match) => match[1]).sort(),
  ['node:fs', 'node:fs/promises', 'node:path', 'node:readline'],
  'transcript search must reach the journal the harness wrote and nothing else - never the agent')
assert.ok(profiles.includes('export function transcriptRoot'), 'each harness must declare where its journals live')
// The env overrides are not decoration: on a configured machine the journals are not under $HOME.
for (const variable of ['PI_CODING_AGENT_SESSION_DIR', 'PI_CODING_AGENT_DIR', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME']) {
  assert.ok(profiles.includes(variable), `${variable} must be honoured or a configured machine searches the wrong directory`)
}
// Claude Code has no `historyLoader` - its transcript comes from an ACP replay - but it writes the
// same kind of journal, so it must be searchable on the same terms as the other three.
assert.match(profiles, /case "claude":[\s\S]{0,200}"projects"/, 'Claude Sessions must be searchable from disk too')

// A search that silently covers part of the history teaches the user that a phrase was never said.
for (const field of ['unsearched', 'truncated', 'scanned']) {
  assert.ok(transcriptSearch.includes(field), `the searcher must report ${field} so coverage is never implied`)
  assert.ok(bridgeServer.includes(field), `the route must pass ${field} through`)
  assert.ok(clientSearch.includes(field), `the client must keep ${field}`)
  assert.ok(home.includes(`transcriptSearch.${field}`) || home.includes(field), `the rail must state ${field}`)
}
assert.ok(home.includes('sf.transcriptCoveragePartial'), 'a partial search must say so in the rail, not look complete')

// A match has to be something that was said. Searching for a project name once matched every line of
// every journal through `cwd`, and a base64 screenshot matched almost any short query by coincidence.
assert.ok(transcriptSearch.includes('NOISE_KEYS'), 'machine identity must not be searchable text')
assert.match(transcriptSearch, /const match = matchFromLine\(line, needle\)\s*\n\s*if \(!match\) continue\s*\n\s*count \+= 1/,
  'a line that cannot produce a snippet is not a match, so it must not be counted as one either')
assert.ok(transcriptSearch.includes('looksLikeBlob'), 'an encoded blob is not prose')
assert.ok(transcriptSearch.includes('skipFragment'), 'reading a tail starts mid-record; that fragment is not a match')

// The route is a literal in the same namespace as `/session/<id>`, whose pattern accepts any segment.
assert.ok(bridgeServer.indexOf('/session/search') < bridgeServer.indexOf('const sessionMatch'),
  'the literal search route must be matched before the Session-id route that would swallow it')
assert.ok(apiClient.includes('searchTranscripts'), 'the client needs the route')
assert.match(clientSearch, /TRANSCRIPT_SEARCH_MIN_CHARS = 3/, 'two characters is a keystroke, not a query')
assert.match(home, /TRANSCRIPT_SEARCH_DEBOUNCE_MS/, 'one journal read per Session must not be paid for every character typed')
// One machine asleep, or one daemon too old to know the route, must not take the whole result down.
assert.match(clientSearch, /\.catch\(\(\) => null\)/, 'a failed agent contributes nothing rather than failing the search')
assert.match(clientSearch, /if \(!outcome\) \{ truncated = true; continue \}/, 'and it is counted as missing coverage')

// The point of the feature: a Session whose title says nothing about the query is still in the list.
assert.ok(home.includes('return transcriptHits.has(recordKey(item))'), 'a transcript match must pass the rail filter')
assert.ok(home.includes('hr-native-session-snippet'), 'the row must show why it is in the list')
assert.match(workbenchCss, /\.hr-native-session-snippet \{[^}]*line-clamp: 2/s, 'the snippet is two lines, not a transcript in the rail')
assert.match(workbenchCss, /\.hr-native-session-snippet \{[^}]*white-space: normal/s,
  'the rail keeps one line per row; the snippet is the one thing that wraps, or it is unrecognisable')
// Behaviour is asserted by `SEARCH_CHECK=1 npm run measure:session-first`, which types a phrase that
// exists only inside two transcripts and requires both Sessions to appear with their snippets, the
// coverage line to state what could not be read, and clearing the field to restore the full list.

// --- The lifecycle notice sits on the message column ------------------------------------------
// "Model changed to ... · continuing with ..." centred itself with `margin: auto` in the whole
// transcript, but the messages occupy an 880px column that is not centred in that pane - so on a wide
// screen the notice sat visibly right of the bubbles above and below it.
assert.match(workbenchCss, /\.hr-native-session-observer \.tdw-conversation-event \{[^}]*margin-inline: var\(--hrsf-column-inset\) auto/s,
  'the notice must occupy the same column as the messages')
assert.match(workbenchCss, /\.hr-native-session-observer \.tdw-conversation-event \{[^}]*justify-content: center/s,
  'and centre its pill inside that column')
assert.match(workbenchCss, /\.hr-native-session-observer \.tdw-conversation-event > span::before/,
  'the leading dot must move into the pill, or the centring makes room for it outside the border')
assert.match(workbenchCss, /\.hr-native-session-observer \.tdw-conversation-event::before \{\s*display: none/,
  'and the control plane\'s dot outside the pill must be withdrawn')
// Geometry is asserted by `NOTICE_CHECK=1 npm run measure:session-first`, which requires the pill's
// centre to be the message column's centre, the dot to be inside the pill, and the pill to stay
// narrower than the column.
