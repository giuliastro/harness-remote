import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('./api.ts', import.meta.url), 'utf8')
const icons = readFileSync(new URL('./Icons.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

assert.ok(api.includes('const body = await response.text()'), 'failed HTTP responses must consume their body only once')
assert.equal(api.includes('const text = await response.text()'), false, 'error handling must not try to read an already consumed response stream')

const refreshButton = app.match(/<button onClick=\{refreshSessionsWithIndicator\}[\s\S]*?\{t\('sessions\.refresh'\)\}[\s\S]*?<\/button>/)
assert.ok(refreshButton, 'sessions refresh button should call refreshSessionsWithIndicator')
assert.ok(refreshButton[0].includes('RefreshIcon'), 'idle sessions refresh button should render a non-spinning RefreshIcon')
assert.ok(refreshButton[0].includes('refreshingSessions ? <LoadingIcon'), 'refresh button should spin only during an active manual refresh')
assert.match(styles, /\.session-card-main\s*\{[\s\S]*?min-width:\s*0;/, 'session card content should be allowed to shrink inside narrow layouts')
// The invariant is that a long title cannot widen its card, not how that is achieved. Asserting the
// nowrap/ellipsis spelling instead pinned a truncation the mobile cards never had: their titles wrap,
// and the README screenshots show it. Breaking the word contains the overflow and keeps the wrapping.
// Anchored to line start, and each match kept inside one rule block with [^}]: an unanchored
// `.session-card h3` also matches the tail of `.sidebar-sessions .session-card h3`, which made the
// negative assertion below fire on the sidebar's deliberate nowrap.
assert.match(styles, /^\.session-card h3\s*\{[^}]*overflow-wrap:\s*(break-word|anywhere);/m, 'a long session title must break rather than widen its card')
assert.ok(
  !/^\.session-card h3\s*\{[^}]*white-space:\s*nowrap/m.test(styles),
  'the mobile session card title must stay free to wrap; only the compact desktop sidebar row truncates it'
)
assert.match(styles, /^\.sidebar-sessions \.session-card h3\s*\{[^}]*white-space:\s*nowrap;/m, 'the desktop sidebar row keeps its single-line ellipsised title')

assert.ok(app.includes('messageScrollSignature'), 'conversation auto-scroll should react to message content changes, not only message count')
assert.ok(
  /if \(!stickToBottomRef\.current\) return[\s\S]*?scrollMessagesToBottom\("auto"\)/.test(app),
  'content-driven auto-scroll must be gated on the user already being pinned to the bottom, so background refreshes cannot force the conversation to scroll while the user has scrolled away'
)
assert.ok(app.includes('}, [view, selectedID])'), 'auto-scroll should run only when opening a selected session')
assert.ok(app.includes('scrollMessagesToBottom("smooth")'), 'focusing the composer should scroll to the bottom')
assert.ok(app.includes('messagesEndRef'), 'auto-scroll should target a bottom sentinel marker')
assert.ok(app.includes('scrollTo({ top: container.scrollHeight'), 'auto-scroll should set the messages container scrollTop to its max scrollHeight')
assert.ok(app.includes('scrollIntoView'), 'auto-scroll should scroll the sentinel into view as a fallback')
assert.ok(app.includes('composerRef'), 'auto-scroll should know the sticky composer height so the latest message is not hidden behind input controls')
assert.ok(app.includes('syncChatBottomClearance'), 'detail view should update chat bottom clearance from the rendered composer size')
assert.ok(app.includes('scrollBy({ top: coveredByComposer'), 'page-level auto-scroll should compensate when the sentinel is covered by the sticky composer')
assert.ok(/\.messages[\s\S]*?padding-bottom:\s*var\(--chat-bottom-clearance/.test(styles), 'messages pane should reserve bottom space for the sticky composer')
assert.ok(/\.messages-end[\s\S]*?scroll-margin-bottom:\s*var\(--chat-bottom-clearance/.test(styles), 'bottom sentinel should keep the latest output above the sticky composer')
assert.ok(/requestAnimationFrame\(\(\) => \{[\s\S]*?requestAnimationFrame\(\(\) => \{/.test(app), 'auto-scroll should wait for the next two frames so freshly rendered content is laid out before scrolling')
assert.ok(app.includes('session-card.active') && app.includes('scrollIntoView({ block: "center" })'), 'returning to sessions should center the active session card instead of restoring a stale scroll coordinate')
assert.ok(app.includes('typing-bubble'), 'detail view should render a temporary typing bubble while waiting for OpenCode output')
assert.ok(app.includes('typing-dot'), 'typing bubble should show animated dots')
assert.ok(app.includes('awaitingAssistantReply'), 'typing bubble should stay visible after the send request returns and until a new assistant message arrives')
assert.ok(app.includes('assistantResponseSignature'), 'typing bubble should be replaced by the next assistant response')
assert.ok(app.includes('optimisticUserMessages'), 'sent user messages should render immediately before the network round trip returns')
assert.ok(app.includes('createOptimisticUserMessage'), 'send flow should create an optimistic user message envelope')
assert.ok(app.includes('setOptimisticUserMessages((current) => [...current, optimisticMessage])'), 'send flow should append the optimistic user bubble before awaiting OpenCode')
assert.ok(app.includes('isWaitingForOpenCodeReply = awaitingAssistantReply || busySending || isSessionRunning'), 'send button/waiting state should stay active until OpenCode assistant output arrives')
assert.ok(app.includes('completionShouldPlayRef.current = true'), 'completion sound should be armed when a real assistant reply is expected')
assert.ok(app.includes('wasAwaitingAssistantReplyRef.current && !awaitingAssistantReply && completionShouldPlayRef.current'), 'completion sound should play only when assistant waiting ends, not when the user bubble renders')
assert.ok(app.includes('loadSelectedRequestRef'), 'session message refreshes should ignore stale overlapping polling responses')
assert.ok(app.includes('if (requestID !== loadSelectedRequestRef.current) return'), 'older loadSelected requests must not overwrite newer assistant output')
assert.ok(app.includes('loadedSessionID'), 'the message pane should track whether the selected session history has loaded')
assert.ok(app.includes('loadedSessionID !== selectedID'), 'an unloaded selected session must render the loading state instead of an empty transcript')
assert.ok(app.includes('setLoadedSessionID(sessionID)'), 'a successful selected-session snapshot should unlock the empty transcript state')
// The desktop layout renders the chat pane with no session selected, which mobile never does: both
// load checks compare against selectedID, so a null one satisfied them and spun "loading" forever.
assert.ok(
  /selectedID === null \?[\s\S]*?t\('detail\.selectSession'\)[\s\S]*?loadingSessionID === selectedID/.test(app),
  'no selected session must render its own empty state, ahead of and separate from the loading state'
)
assert.ok(app.includes('reconcileStreamedPart'), 'message refresh should not regress streamed assistant output back to a leaner snapshot')
assert.ok(
  /function reconcileStreamedPart[\s\S]*?incomingText\.length >= previousText\.length \? incoming/.test(app),
  'a snapshot with shorter text than what is already shown must keep the longer text'
)
assert.ok(
  !/assistantPayloadLength\(current\) <= assistantPayloadLength\(msg\)/.test(app),
  'a leaner snapshot must not be rejected wholesale: the optimistic user bubble is cleared against that same snapshot, so dropping it makes a just-sent message vanish and latches every later message out of the transcript until the session is reopened'
)
assert.ok(app.includes('SendIcon') && app.includes('<SendIcon size={18} />'), 'composer send button should use the clear paper-plane SendIcon')
assert.ok(app.includes('StopCircleIcon') && app.includes('<StopCircleIcon size={18} />'), 'composer waiting button should use a clear stop-task icon')
assert.match(icons, /export const StopCircleIcon/, 'StopCircleIcon should exist in the shared SVG icon set')
assert.ok(app.includes('api.loadDiff(config, sessionID, directory)'), 'detail view should load /session/:id/diff for changed-file details')
assert.ok(app.includes('diffFiles.length > 0'), 'changed-file panel should be hidden when there are no changed files')
assert.ok(app.includes('activeDetailSheet === "details"'), 'VCS and file status should be consolidated into the details bottom sheet')
assert.ok(app.includes('diffFiles.length > 0 ? t(\'detail.filesCount\''), 'details sheet should summarize changed files when diff data exists')
assert.ok(!app.includes('className={selectedDiff?.file === file.file ? "diff-file active" : "diff-file"}'), 'changed-file details should no longer render a separate selectable file list')
assert.ok(!app.includes('mini-diff-card'), 'separate mini diff card should stay removed from the streamlined details sheet')
assert.ok(app.includes('api.loadProjectCurrent(config, directory)'), 'project dashboard should use /project/current')
assert.ok(app.includes('api.loadVcs(config, directory)'), 'project dashboard should use /vcs')
assert.ok(app.includes('api.loadFileStatus(config, directory)'), 'project dashboard should use /file/status')
assert.ok(/\.project-dashboard[\s\S]*?grid-template-columns:\s*repeat\(3/.test(styles), 'project dashboard should render as compact cards on wide screens')
assert.ok(/@media \(max-width: 780px\)[\s\S]*?\.project-dashboard[\s\S]*?grid-template-columns:\s*1fr/.test(styles), 'project dashboard should stack on mobile')
assert.ok(app.includes('connectionState'), 'sessions view should track connection state separately from one-off runtime errors')
assert.ok(app.includes('backgroundFailureCountRef.current += 1'), 'background refresh should count failures before showing persistent offline errors')
assert.ok(app.includes('connection-pending'), 'initial slow connection should show an explicit loading state instead of an empty sessions list')
assert.ok(app.includes("t('connection.reconnecting')"), 'slow reconnecting state should be translated and shown quietly')
assert.ok(styles.includes('.connection-status'), 'connection status should have a dedicated non-error visual treatment')
assert.ok(app.includes('createFetchOpenCodeEventSubscription'), 'app should use an authenticated fetch-based event stream')
assert.ok(app.includes('api.eventStream(config)'), 'app should derive the event stream URL and auth headers from server config')
assert.ok(app.includes('setEventStreamState("live")'), 'app should expose live event-stream state in the UI')
assert.ok(app.includes('event-stream'), 'sessions header should visibly show the event stream state')
assert.ok(app.includes('isNativeEventTransport()'), 'Android should select the native SSE transport instead of WebView fetch streaming')
assert.ok(app.includes('createNativeOpenCodeEventSubscription'), 'Android should use the native event transport')
assert.match(styles, /\.connection-status\s*\{\s*display:\s*flex;/, 'connection and live-status rows should be stacked, not joined inline')
assert.ok(app.includes('eventType(event.data)'), 'app should unwrap the official global event envelope before filtering')
assert.ok(app.includes('type.startsWith("session.") || type.startsWith("message.") || type.startsWith("todo.")'), 'only session/message/todo events should schedule refreshes')
assert.ok(app.includes('setLiveEventCount((count) => count + 1)'), 'the UI should expose received application events as a counter')
assert.ok(app.includes('scheduleRefresh()'), 'relevant live events should schedule session/message refreshes')
assert.ok(api.includes('eventStream(config: ServerConfig)'), 'API should expose an authenticated global event-stream descriptor')
assert.ok(app.includes('NEW_SESSION_DIRECTORY_STORAGE_KEY'), 'last new-session folder should persist separately from connection settings')
assert.ok(app.includes('showNewSessionPicker'), 'New Session should open a per-session folder picker instead of applying one global folder')
assert.ok(app.includes('api.loadPath(config, selectedNewSessionDirectory)'), 'folder picker should start from OpenCode /path')
assert.ok(api.includes('listFiles(config: ServerConfig, path: string, directory?: string)'), 'API should expose OpenCode /file for directory browsing')
assert.ok(app.includes("t('sessions.projectDirectoryLabel')"), 'folder picker should be localized')
assert.ok(app.includes("api.createSession(config, t('sessions.remoteSessionTitle'), activeModel, directory)"), 'new sessions should pass the translated remote title and only the picked directory to OpenCode')
assert.ok(app.includes("t('sessions.projectDirectoryInvalid'"), 'picked folders should be validated before creating unusable global sessions')
assert.ok(app.includes('if (!isProjectDirectory(pathInfo))'), 'new session creation should reject folders that OpenCode resolves to the global project')
assert.ok(app.includes('if (current.some((session) => session.id === created.id)) return current'), 'newly created sessions should be inserted before any refresh')
assert.ok(app.includes('async function refreshSessions(silent = false, preserveSession?: SessionView)'), 'session refresh should accept a newly created session to preserve across stale React state')
assert.ok(app.includes('const toPreserve = preserveSession ?? selected'), 'session refresh should preserve an explicit created session, not only the previous selectedID')
assert.ok(app.includes('await refreshSessions(false, createdView)'), 'new-session flow must preserve the created session during the immediate post-create refresh')
assert.ok(api.includes('createSession(config: ServerConfig, title?: string, model?: ModelSelection, directory?: string)'), 'createSession API should accept a directory')
assert.ok(api.includes('withDirectory("/session", directory)'), 'new session creation should append ?directory= when set')
assert.ok(api.includes('loadTodo(config: ServerConfig, sessionID: string, directory?: string)'), 'todo requests should be directory-aware')
assert.ok(api.includes('loadDiff(config: ServerConfig, sessionID: string, directory?: string)'), 'diff requests should be directory-aware')
assert.ok(api.includes('abort(config: ServerConfig, sessionID: string, directory?: string)'), 'abort requests should be directory-aware')
assert.ok(api.includes('listGlobalSessions(config: ServerConfig)'), 'sessions view should use global session discovery when available')
assert.ok(api.includes('x-next-cursor'), 'global session discovery should page through all experimental session results')
assert.ok(app.includes('api.listSessions(config, directory).catch(() => [] as Session[])'), 'global sessions should be hydrated from scoped session lists for fresh timestamps and summaries')
assert.ok(api.includes('loadLatestMessage(config: ServerConfig, sessionID: string, directory?: string)'), 'API should expose a cheap latest-message request')
assert.ok(app.includes('function messageActivityTime'), 'sessions should display latest message activity instead of mutable session row timestamps')
assert.ok(app.includes('latestMessageTimesRef'), 'latest message activity lookups should be cached between refreshes')
assert.ok(app.includes('catch(() => null)'), 'failed latest-message lookups should not be cached as session row timestamps')

assert.ok(app.includes('THEME_STORAGE_KEY'), 'theme preference should persist separately from server settings')
assert.ok(app.includes('type ThemePreference = "system" | "light" | "dark"'), 'theme preference should support system, light, and dark')
assert.ok(app.includes('window.matchMedia("(prefers-color-scheme: dark)"'), 'system theme should follow prefers-color-scheme')
assert.ok(app.includes('document.documentElement.dataset.theme = resolvedTheme'), 'theme should be applied to the root element for CSS variables')
assert.ok(app.includes("t('settings.theme')"), 'settings should expose a localized theme picker')
assert.ok(styles.includes(':root[data-theme="dark"]'), 'dark mode should override design tokens through CSS variables')
assert.ok(styles.includes('--nav-bg'), 'theme-sensitive navigation background should use a variable')
assert.ok(styles.includes('--primary-border'), 'theme-sensitive active borders should use a variable')
assert.ok(styles.includes('--focus-ring'), 'theme-sensitive focus ring should use a variable')

assert.ok(app.includes('ReactMarkdown'), 'messages should use a maintained Markdown renderer')
assert.ok(app.includes('remarkGfm'), 'messages should support GitHub-flavored Markdown')
assert.ok(/\.message-content pre[\s\S]*?overflow-x:\s*auto/.test(styles), 'fenced code blocks should render as scrollable blocks')

assert.match(icons, /export const RefreshIcon/, 'RefreshIcon should exist for idle refresh UI')

// Android back button: dismiss the topmost layer, then fall back to the session list.
const backStart = app.indexOf('CapacitorApp.addListener("backButton"')
assert.notEqual(backStart, -1, 'the Android back button should be handled')
const backHandler = app.slice(backStart, app.indexOf('}, [])', backStart))
assert.equal(
  /setView\(\(current\)/.test(backHandler),
  false,
  'exitApp must not run inside a state updater, which React may invoke more than once'
)
assert.ok(backHandler.includes('backStateRef.current'), 'the handler is registered once, so it must read state through a ref')
assert.ok(backHandler.includes('if (removed) void registered.remove()'), 'a listener registered after teardown must still be removed')
for (const layer of ['sessionToDelete', 'renamingSessionID', 'activeDetailSheet']) {
  assert.ok(backHandler.includes(layer), `back should dismiss ${layer} before leaving the view`)
}
assert.ok(
  backHandler.indexOf('exitApp') > backHandler.indexOf('setView("sessions")'),
  'the app should only exit from the session list'
)

assert.ok(app.includes('api.capabilities(config).then(setCapabilities)'), 'bridge capabilities must be loaded from the selected harness')
for (const capability of ['agents', 'models', 'todos', 'diff', 'questions', 'sessionRename', 'sessionDelete']) {
  assert.ok(app.includes(`capabilities.${capability}`), `${capability} UI must be capability-driven`)
}

// A follow-up prompt can be queued while the agent is still working.
assert.ok(app.includes('const showStopAction = isWorking && !composer.trim()'), 'stop should be offered only when there is nothing to send')
assert.equal(app.includes('disabled={!selectedSession || isWorking}'), false, 'the composer must stay usable while the agent works')
// External OMP history must replace stale cached ordering even when the corrected payload is shorter.
// This no longer needs its own escape hatch: every fetched snapshot is now applied, and only same-id
// same-type text is held back from shrinking, so a corrected external history replaces the cache.
assert.ok(app.includes("if (!messagesHaveSameContent(current, msg)) {"), "a fetched snapshot must be applied whenever it differs from what is on screen")
// The marker moved from below the messages, where the sticky composer cut it in half, into the
// header. What matters is that an external session is still marked and still explained, not where.
assert.ok(app.includes("selectedSession.external && ("), "a session from another client must be marked as such")
assert.ok(
  app.includes("t('detail.externalSession')") && !app.includes("externalShort"),
  "the marker must read as a sentence, not a one-word tag that needs a tooltip touch cannot show"
)
assert.equal(app.includes("disabled={!selectedSession || selectedSession.external}"), false, "external sessions must remain writable")
assert.ok(app.includes('onClick={showStopAction ? abortSession : send}'), 'the action button should send a queued follow-up instead of only stopping')

// A run bubble merges action groups that a message boundary split apart. Consecutive replies with
// nothing groupable in them must stay separate, or two answers to two queued prompts render as one.
const groupRenderer = app.slice(app.indexOf('function groupRenderedMessages'), app.indexOf('function ConversationRunView'))
assert.ok(groupRenderer, 'consecutive assistant messages should be grouped for rendering')
assert.ok(
  groupRenderer.includes('!buffer.some((message) => message.parts.some((part) => ACTION_GROUP_TYPES.has(part.type)))'),
  'a run must only form when the buffered messages actually contain groupable parts'
)
assert.ok(
  groupRenderer.includes('for (const message of buffer) groups.push({ kind: "message", message })'),
  'text-only replies must each keep their own bubble'
)

// A model list that never arrived used to render as "loading" forever, which reads as a slow
// server rather than a failure — the reason a misconfigured server looked like a broken feature.
// Asserted on the failure branch alone: the label now has three states, and pinning the whole
// expression would break again the next time one is added.
assert.ok(
  app.includes("modelLoadError ? t('detail.modelUnavailable') : t('detail.modelLoading')"),
  'a failed model fetch must be named, not shown as still loading'
)
assert.ok(
  app.includes('activeModelOption?.modelName') && app.includes('const modelStatusLabel'),
  'a model already known must keep showing, even if a later refresh fails'
)
assert.equal(
  app.includes("activeModelOption?.modelName ?? t('detail.modelLoading')"),
  false,
  'every model label should go through modelStatusLabel so the failure state cannot be missed'
)
assert.ok(app.includes('chip-warning'), 'the context chip should mark the failure visually')

// The harness in use decides what the app can do, so it is named in the header.
assert.ok(app.includes('className={`harness-badge harness-${config.backend}`}'), 'the header should badge the active harness')
assert.ok(app.includes('{backendDisplayName(config.backend)}'), 'the badge should show the harness display name')
for (const cls of ['.harness-badge', '.harness-omp', '.harness-pi', '.brand-server']) {
  assert.ok(styles.includes(cls), `${cls} should be styled`)
}
assert.match(styles, /\.brand-server[\s\S]*?text-overflow: ellipsis/, 'a long address must truncate rather than push the badge off screen')

// Mobile keyboard: an address is not a sentence, a port is a number, and Enter sends.
assert.ok(app.includes('inputMode="url"') && app.includes('autoCapitalize="none"'), 'the host field must not be autocapitalised or autocorrected')
assert.ok(app.includes('inputMode="numeric"'), 'the port field should raise a numeric keypad')
assert.ok(app.includes('autoComplete="username"') && app.includes('autoComplete="current-password"'), 'credentials should be offerable by a password manager')
assert.ok(app.includes('enterKeyHint="send"'), "the composer's action key should say send")

// A session card showed a full absolute path over three lines, a third of its height.
assert.ok(app.includes('function shortDirectory'), 'the card should shorten the directory it shows')
assert.ok(app.includes('<p title={session.directory}>{shortDirectory(session.directory)}</p>'), 'the full path should stay available as a title')
assert.equal(app.includes("t('sessions.noFileChanges')"), false, 'absence of changes needs no line of its own on a phone')

// Hover is not a state a finger can produce.
// The defect was a control left at 60% opacity until hovered, a state a finger cannot produce.
// What must hold is that hover-dependent styling is behind a hover query, and that nothing
// interactive is dimmed by default. Disabled controls and the typing animation are not that.
assert.ok(styles.includes('@media (hover: hover)'), 'hover-dependent styling must be behind a hover query')
const dimmedOutsideHover = styles
  .split('@media (hover: hover)')[0]
  .match(/opacity: 0\.\d+/g)
  ?.filter((rule) => rule !== 'opacity: 0.45' && rule !== 'opacity: 0.35') ?? []
assert.deepEqual(dimmedOutsideHover, [], 'no interactive control should start dimmed on a touch device')
assert.ok(styles.includes('-webkit-tap-highlight-color: transparent'), 'the platform tap flash should not fight the pressed state')
assert.ok(styles.includes('overscroll-behavior: contain'), 'scrolling to the end of a list should not drag the page')
assert.match(styles, /button\.compact \{[\s\S]*?min-height: 44px/, 'a compact button is still a thumb target')

// A phone returning from standby can miss a couple of polls while Wi-Fi and the server wake up.
// Keep the last valid UI and show a quiet reconnect state before presenting the offline screen.
assert.ok(app.includes('const isOffline = connectionState === "offline"'), 'offline should be one named state')
assert.ok(
  app.includes('if (backgroundFailureCountRef.current < 3)'),
  'background refreshes should retry twice before declaring the server offline'
)
assert.ok(app.includes('eventStreamText = isOffline'), 'the event stream must not claim to be reconnecting while the connection is down')
assert.ok(
  app.includes('runtimeError && !(isOffline && filteredSessions.length === 0)'),
  'the offline state explains itself; the raw transport error must not repeat it'
)
assert.ok(app.includes("t('sessions.retry')"), 'an offline state should offer a way out')
assert.ok(app.includes('disabled={creatingSession || isOffline}'), 'an action that cannot succeed offline must not be offered')
assert.ok(styles.includes('.empty-state-actions'), 'the offline actions should be styled')

// The question tool's own parameter schema has no `custom` field at all, so a question always
// arrives with it undefined and the documented default of `true` applies. Testing it for
// truthiness therefore hid the free-text answer on every question ever asked.
assert.ok(
  app.includes('question.custom !== false'),
  'the free-text answer must be offered unless a question opts out of it explicitly'
)
assert.equal(
  /question\.custom &&/.test(app),
  false,
  'a missing `custom` flag means enabled, so it must never be read as a boolean'
)
assert.match(
  app,
  /if \(!multiple\) \{[\s\S]*?setCustomValues\(/,
  'choosing an option in a single-answer question must clear the typed answer, so only one of the two is submitted'
)

// A backend is reachable only if every layer knows it. Declaring a `BackendKind` and wiring the
// bridge profile, capabilities and storage key is not enough: without an <option> in the Settings
// picker there is no way to select it, and the README ends up documenting a backend the app cannot
// open. Derived from the union rather than hard-coded, so adding a harness fails here until the
// picker, the display name and the persisted-value guards all accept it.
const types = readFileSync(new URL('./types.ts', import.meta.url), 'utf8')
const backendKinds = (types.match(/export type BackendKind =([^\n]+)/)?.[1] ?? '')
  .split('|')
  .map((kind) => kind.trim().replace(/"/g, ''))
  .filter(Boolean)
assert.ok(backendKinds.length >= 3, `BackendKind should parse into its members, got ${JSON.stringify(backendKinds)}`)
for (const kind of backendKinds) {
  assert.ok(
    app.includes(`<option value="${kind}">`),
    `backend "${kind}" is declared in BackendKind but has no option in the Settings picker, so it cannot be selected`
  )
  assert.ok(
    app.includes(`=== "${kind}"`),
    `backend "${kind}" is declared in BackendKind but never compared against in App.tsx, so stored values and display names will not accept it`
  )
}

// `loadModels` returns early when the harness exposes no model list, so anything that reports
// progress has to distinguish "nothing to load" from "still loading" or it sits on the loading text
// forever. The Claude Code backend did exactly that: `models: false`, and an AI panel that claimed
// to be loading for the life of the session.
// Matched with \s+ rather than a literal newline: these sources are checked out with CRLF endings.
assert.match(
  app,
  /\?\?\s*\(!capabilities\.models\s+\?\s*t\('detail\.modelNotSupported'\)/,
  'the model status label must say a harness has no model selection rather than claiming to load'
)
assert.match(
  app,
  /\{!capabilities\.models\s+\?\s*t\('detail\.modelNotSupported'\)/,
  'the AI panel must say a harness has no model selection rather than claiming to load'
)

// The harness names a model "Sonnet" and puts which Sonnet in the description. Showing the provider
// there instead was fine when it distinguished anything; with one synthesised provider it read as
// "claude" on all five rows while the version stayed invisible.
assert.match(
  app,
  /\[option\.description \?\? option\.providerName, option\.variant\]/,
  "the model picker's secondary line must prefer the harness description, falling back to the provider"
)

// A tool event is created before its streamed arguments arrive. Calling that action complete (or
// exposing its empty `{}` payload) falsely signals that the tool has already run.
assert.match(
  app,
  /const isPreparing = \(status === "pending" \|\| status === "running"\) && Object\.keys\(input\)\.length === 0/,
  'an active tool with no streamed input must remain in its preparing state'
)
assert.match(
  app,
  /const displayLabel = isPreparing \? t\('action\.preparingTool', \{ tool: part\.tool \|\| t\('action\.actionsFallback'\) \}\) : label/,
  'preparing tools must identify the pending tool instead of presenting an empty call as complete'
)
assert.ok(app.includes('>{displayLabel}</span>'), 'the tool summary must show the preparing label')


assert.match(app, /onContextMenu=\{\(event\) => \{\s*event\.preventDefault\(\)\s*open\(event\.clientX, event\.clientY, window\.matchMedia/, 'right-clicking a message must open its action menu')
assert.match(app, /event\.pointerType !== "touch"/, 'touch messages must support long-press actions')
assert.match(app, /navigator\.clipboard\?\.writeText/, 'message actions must copy to the system clipboard')
assert.match(app, /markdown \? normalizeMessageMarkdown\(text\) : text/, 'the menu must distinguish plain-text and markdown copies')
assert.match(styles, /\.message-context-menu\s*\{[\s\S]*?position:\s*fixed/, 'message actions must render above the scrolling transcript')
assert.match(app, /window\.matchMedia\("\(pointer: coarse\)"\)\.matches/, 'a touch context-menu event must keep the mobile menu layout')
assert.match(app, /Math\.hypot\(movedX, movedY\) > 10/, 'moving to scroll must cancel the pending long-press menu')
assert.match(styles, /\.message-context-menu--touch\s*\{[\s\S]*?bottom:\s*max\(/, 'the touch menu must render as a reachable bottom sheet')
assert.match(styles, /@media \(pointer: coarse\)\s*\{[\s\S]*?\.message\s*\{[\s\S]*?user-select:\s*none/, 'mobile long-press must not also select message text')
// A menu that only closes on its own items is a menu that stacks: the state is per bubble, so a
// right-click on a second message left the first one hanging over the transcript.
assert.match(app, /window\.addEventListener\("pointerdown", dismiss\)/, 'pressing outside an open message menu must dismiss it')
assert.match(app, /if \(event\.key === "Escape"\) dismiss\(\)/, 'Escape must dismiss an open message menu')
assert.match(app, /window\.addEventListener\("scroll", dismiss, true\)/, 'a fixed menu must not stay behind while the transcript scrolls under it')
assert.match(app, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/, 'choosing an item must not count as pressing outside, or the menu unmounts before the click lands')
// The Clipboard API needs a secure context, and the app is reachable over plain http on a LAN,
// where `navigator.clipboard` is undefined and reaching into it throws past any `.catch()`.
assert.match(app, /document\.execCommand\("copy"\)/, 'copying must still work where the Clipboard API is unavailable')
// Both copy options did nothing on any bubble whose parts carry no text — a run ending on a tool
// call, an agent turn that only worked and never spoke. The menu was handed the run's last message,
// and `extractText` returns "" for those, so the copy wrote an empty string: the paste came back
// empty and whatever the user had in the clipboard was gone with it.
assert.match(
  app,
  /const runText = \[\.\.\.messagesByID\.values\(\)\]\.map\(\(message\) => message\.text\)\.filter\(Boolean\)\.join\("\\n\\n"\)/,
  'a run bubble must copy every message it shows, not just the last one'
)
assert.match(app, /<MessageContextMenu\s+text=\{runText\}/, 'the run bubble must hand the menu the whole run text')
assert.ok(
  !/<MessageContextMenu message=/.test(app),
  'the menu takes the text to copy: passing a message let a bubble that shows several, or none, claim one'
)
assert.match(app, /if \(!text && actions\.length === 0\) return <article className=\{className\}>\{children\}<\/article>/, 'a bubble with neither copy nor harness actions must not offer the menu')
assert.match(app, /if \(!text\) return\s*\n\s*try \{/, 'an empty copy must not replace what the user already had in the clipboard')
assert.match(app, /selection\.addRange\(previousRange\)/, 'the fallback carrier must give the selection back after stealing it')
assert.match(app, /supported\.has\("undo"\)/, 'Undo must appear only when the connected harness exposes the command')
assert.match(app, /supported\.has\("redo"\)/, 'Redo must appear only when the connected harness exposes the command')
assert.match(app, /api\.revertMessage\(config, selectedSession\.id, messageID/, 'OpenCode message actions must use its targeted revert endpoint')
assert.match(app, /message\.info\.id < revertMessageID/, 'a staged OpenCode revert must hide messages from its boundary onward')
assert.match(app, /const hasRedo = config\.backend === "opencode" \? !!revertMessageID : redoAction \? redoAction\.enabled : true/, 'OpenCode Redo must only appear while a revert is staged and extension Redo must follow session state')
assert.match(app, /const supportsRedo = config\.backend === "opencode" \|\| !!redoAction \|\| supported\.has\("redo"\)/, 'OpenCode native history actions must not depend on the server command list')
assert.match(app, /message-context-menu__separator/, 'harness actions must be visually separated from copy actions')
assert.match(styles, /\.message-context-menu button\s*\{[\s\S]*?justify-content:\s*flex-start[\s\S]*?text-align:\s*left/, 'message action labels must align to the menu edge')
// The rule was written for a field that no longer exists, but the class outlived it: dropping the
// declaration with its original caller left the server name silently back in half a row.
if (app.includes('className="field-row-span"')) {
  assert.match(
    styles,
    /\.field-row-span\s*\{[^}]*grid-column:\s*1 \/ -1;/,
    'a field asking for the whole settings row needs the rule that grants it'
  )
}

assert.match(
  app,
  /function isSessionWorking\(status: string\): boolean \{\s*return status === "busy" \|\| status === "retry" \|\| status === "waiting"/,
  'waiting sessions must remain working sessions rather than becoming idle'
)
assert.match(styles, /\.pill\.waiting\s*\{[^}]*background:\s*var\(--primary-soft\)/, 'waiting sessions need a distinct status pill')
assert.match(styles, /\.session-card\.waiting::before\s*\{[\s\S]*?animation-name:\s*session-waiting-sweep/, 'desktop waiting sessions need their own animation')

// The waiting marker first shipped naming two colours the palette never declared, and the
// assertions above could not tell: they read the rule as text. A `var()` with no fallback pointing
// at nothing is invalid at computed-value time, so the browser drops the whole declaration and the
// marker paints nothing at all. Checked over the sheet rather than that one rule, since any other
// token typo fails exactly as quietly.
const declaredTokens = new Set([...styles.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]))
const undeclaredTokens = [...new Set(
  [...styles.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)]
    .map((match) => match[1])
    .filter((token) => !declaredTokens.has(token))
)]
assert.deepEqual(undeclaredTokens, [], 'a custom property used without a fallback must be declared')
// Declared in one theme only fails just as silently, and half of it is invisible to whoever is not
// using that theme. The dark block overrides `:root`, so every name it carries has to exist there.
const themeTokens = (block) => new Set([...block.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)].map((match) => match[1]))
const rootTokens = themeTokens(styles.match(/^:root \{([\s\S]*?)^\}/m)[1])
const darkOnlyTokens = [...themeTokens(styles.match(/color-scheme: dark;([\s\S]*?)^\}/m)[1])].filter((token) => !rootTokens.has(token))
assert.deepEqual(darkOnlyTokens, [], 'a custom property overridden for dark mode must have a light-mode value too')

assert.ok(api.includes('`/session/${sessionID}/action`'), 'session action discovery should use the generic bridge endpoint')
assert.ok(api.includes('`/session/${sessionID}/action/${encodeURIComponent(actionID)}`'), 'action execution should use a structured endpoint rather than a chat prompt')
assert.ok(app.includes('capabilities.actions ? api.listActions'), 'the selected session should discover actions only when the bridge supports them')
assert.ok(app.includes('api.invokeAction(config, selectedSession.id, command, selectedSession.directory)'), 'OMP Undo/Redo should execute through the action API')
assert.ok(app.includes('replaceMessages ? msg : mergeFetchedMessages(prev, msg)'), 'a successful Undo must be allowed to shrink the rendered conversation')
assert.ok(app.includes('setExtensionActions(result.actions)'), 'action execution should apply the returned session-specific enabled state immediately')
assert.ok(app.includes("if (result.applied === false)"), 'only an authoritative no-op result should show no-op feedback')
assert.ok(app.includes('result.applied !== false'), 'unknown results should still refresh the active ACP context without being called no-ops')
assert.ok(app.includes("command === \"undo\" ? 'detail.nothingToUndo' : 'detail.nothingToRedo'"), 'the no-op message should describe the attempted action')
assert.ok(app.includes('{actionNotice && <div className=\"notice info fade-in\">'), 'no-op action feedback should render as visible information rather than an error')

// Session actions in the header (issue #104): Undo can strip the transcript to nothing, leaving
// Redo enabled but unreachable through the message context menu, which needs a bubble to exist.
// A header ⋯ menu must therefore render the harness actions independently of transcript contents.
assert.ok(app.includes('function SessionActionsMenu'), 'session actions should have their own header menu component')
assert.ok(app.includes('<MoreVerticalIcon'), 'the session actions menu should open from a ⋯ control in the conversation header')
assert.match(app, /sessionHeaderActions\.length > 0 && \(/, 'the header actions menu should appear only when the harness offers actions')
assert.match(app, /session-actions-menu/, 'the header actions menu should render harness actions as menu items')
assert.match(app, /aria-haspopup="menu"/, 'the session actions toggle should announce that it opens a menu')
assert.match(app, /aria-expanded=\{open\}/, 'the session actions toggle should reflect the menu open state for assistive tech')
assert.ok(app.includes('detail.sessionActions'), 'the session actions toggle should have a translated accessible label')
assert.match(
  app,
  /const hasRedo = config\.backend === "opencode" \? !!revertMessageID : redoAction \? redoAction\.enabled : supported\.has\("redo"\)/,
  'the header menu must follow harness/extension availability instead of gating Redo on transcript contents'
)
assert.match(app, /session-actions-menu/, 'the header actions menu should have its own styles')
assert.match(styles, /\.session-actions-menu\s*\{[\s\S]*?position:\s*absolute/, 'the header actions menu must overlay the conversation rather than push its layout')
assert.match(styles, /\.session-actions-menu\s*\{[\s\S]*?z-index:\s*20/, 'the header actions menu must stack above the message list')

console.log('ui regression tests passed')
