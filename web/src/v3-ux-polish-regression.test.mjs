import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (name) => fs.readFileSync(path.join(here, name), "utf8")
const exists = (name) => fs.existsSync(path.join(here, name))

const machines = read("workspaceMachines.ts")
const main = read("main.tsx")
const standalone = read("components/standalone-universal-workspace.tsx")
const home = read("components/native-session-home.tsx")
const observer = read("components/native-session-observer.tsx")
const chat = read("components/work-thread-conversation.tsx")
const conversationSurface = read("components/taskdesk-conversation.tsx")
const overrides = read("conversation-control-plane-overrides.css")
const sessionWorkbench = read("session-first-workbench.css")
const mobileParity = read("v3-mobile-product-parity.css")
const nativeObserverCss = read("native-session-observer.css")
const nativeHomeUxCss = read("native-session-home-ux.css")
const machineClient = read("machineClient.ts")
const machineLiveRefresh = read("machine-live-refresh.ts")


// Workspace machine defaults: 3.0 boots from machines.
assert.match(machines, /port: 4097/)
assert.match(machines, /username: "harness"/)
assert.doesNotMatch(main, /loadServerProfiles/)
assert.match(main, /loadWorkspaceMachines/)
assert.match(main, /import "\.\/conversation-control-plane-overrides\.css"/)
assert.match(main, /import "\.\/v3-mobile-product-parity\.css"/)
assert.ok(main.indexOf("v3-mobile-product-parity.css") > main.indexOf("v3-mobile-a11y-fix.css"), "mobile parity overrides must load last")

// Session-first is the only product shell. The failed Conversation-first experiment stays deleted.
assert.equal(exists("components/conversation-workspace.tsx"), false)
assert.equal(exists("components/conversation-detail.tsx"), false)
assert.match(standalone, /<NativeSessionsWorkspace/)
assert.match(standalone, /<NativeSessionHome/)
assert.match(standalone, /<NativeSessionObserver/)
assert.match(standalone, /<NativeSessionActions/)
assert.doesNotMatch(standalone, /<NativeSessionHandoffControl/)
assert.match(standalone, /routes=\{routeMachines\}/)
assert.match(standalone, /hr-session-lineage/)
assert.doesNotMatch(standalone, /ConversationWorkspace/)
assert.doesNotMatch(standalone, /New conversation/i)
assert.doesNotMatch(standalone, />Conversations</)
assert.doesNotMatch(standalone, /TaskDeskWorkspace/)

// The navigation hierarchy remains Machine -> Project -> native Session.
assert.match(home, /hr-native-machine-group/)
assert.match(home, /hr-native-project-group/)
assert.match(home, /hr-native-session-row/)
assert.match(home, /sessionTreeRows/)
assert.match(home, /createNativeSessionTarget/)
assert.match(observer, /<WorkThreadConversation/)
assert.match(chat, /<TaskDeskConversation/)
assert.match(sessionWorkbench, /hr-native-workspace/)
assert.match(sessionWorkbench, /hr-native-workspace-list/)
assert.match(sessionWorkbench, /hr-native-workspace-detail/)

// Mobile remains a real app shell rather than deleting useful controls to make screenshots fit.
assert.match(mobileParity, /:has\(\.tdw-main\.mobile-open\) \.hr-mobile-nav[\s\S]*display: grid !important/)
assert.match(mobileParity, /\.hr-mobile-settings-group label:nth-of-type\(2\)[\s\S]*display: grid !important/)
assert.match(mobileParity, /\.uw-machine-harness-list[\s\S]*display: flex !important/)
assert.match(mobileParity, /\.uw-transcript-jumps[\s\S]*top: 50%[\s\S]*bottom: auto/)
assert.match(mobileParity, /@media \(pointer: coarse\) and \(max-width: 599px\) and \(max-height: 640px\)/)
assert.match(mobileParity, /@media \(pointer: coarse\) and \(min-width: 600px\) and \(max-height: 640px\)/)
assert.match(sessionWorkbench, /\.hr-native-workspace-session-header[\s\S]*display: grid;[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto;/)
assert.match(sessionWorkbench, /\.hr-native-workspace-session-actions > code[\s\S]*display: none;/)
assert.match(nativeObserverCss, /\.hr-native-session-observer \.tdw-conversation-toolbar[\s\S]*display: grid !important;[\s\S]*grid-template-columns: minmax\(0, 1fr\) auto !important;/)
assert.match(nativeObserverCss, /\.hr-control-plane \.hr-native-session-observer \.tdw-conversation-state[\s\S]*grid-column: 2 !important;/)
assert.match(nativeObserverCss, /\.tdw-connection-notice/)
assert.match(standalone, /MACHINE_RECONNECT_POLL_MS/)
assert.match(machineLiveRefresh, /MACHINE_RECONNECT_POLL_MS = 1_500/)
assert.match(machineClient, /allowCachedOnTransportFailure/)
assert.match(standalone, /allowCachedOnTransportFailure: false/)
assert.match(standalone, /selectedInteractionEnabled/)
assert.match(standalone, /selectedInteractionEnabled[\s\S]*!selectedRuntime\.error/)
assert.match(standalone, /startupPhase !== "ready"[\s\S]*sf\.loadingSessions/)

// A successful mobile delete remains visibly transitional until the native Session index confirms it.
assert.match(standalone, /deletingSessionKeys/)
assert.match(standalone, /setDeletingSessionKeys/)
assert.match(standalone, /deletingKeys=\{deletingSessionKeys\}/)
assert.match(home, /deletingKeys\?\.has\(targetKey\)/)
assert.match(home, /disabled=\{deleting\}/)
assert.match(home, /sf\.deleting/)
assert.match(home, /onDeletionSettled/)
assert.match(nativeHomeUxCss, /\.hr-native-session-row\.deleting/)
assert.match(nativeHomeUxCss, /cursor: progress/)

// A single mobile timeout must not turn a machine that was already proven online into a false disconnect.
assert.match(standalone, /MACHINE_OFFLINE_FAILURE_THRESHOLD = 3/)
assert.match(standalone, /discoverMachineWithRetry/)
assert.match(standalone, /previous\?\.snapshot && consecutiveFailures < MACHINE_OFFLINE_FAILURE_THRESHOLD/)

// An explicit Send gets one extra layout-settle frame so its optimistic user bubble cannot land below the composer.
assert.match(conversationSurface, /if \(startedSend && nearBottomRef\.current && !preservingOlderRef\.current\)/)
assert.match(conversationSurface, /followFrameRef\.current = window\.requestAnimationFrame\(\(\) => \{[\s\S]*followTail\(\)/)

// Native Session chat keeps the mature shared renderer without resurrecting the removed product UI.
assert.match(chat, /routing \? "Harness" : "Continue with"/)
assert.doesNotMatch(chat, /<span>Machine<\/span>/)
assert.match(nativeObserverCss, /\.hr-control-plane \.hr-native-session-observer \.tdw-conversation-state[\s\S]*display: inline-flex !important/)
assert.match(chat, /buildConversationTimeline/)
assert.match(overrides, /tdw-conversation-event::before/)
assert.match(overrides, /uw-activity-group\.uw-tool-running/)
assert.match(read("components/taskdesk-message-content.tsx"), /status === "running" \? "Working" : status/)
assert.match(overrides, /prefers-reduced-motion/)

// Model discovery is machine-scoped for native Sessions and must not restart on object identity churn.
assert.match(chat, /const scope = routing \? NATIVE_ROUTE_MODEL_SCOPE/)
assert.match(chat, /const catalogConfig = configForAgent\(destinationConfig, destinationAgents, targetAgentID\)/)
assert.match(chat, /taskClient\.listAgentModels\(catalogConfig, targetAgentID, scope\)/)
assert.match(chat, /routingSignature/)
assert.match(chat, /const modelScopeKey = modelScope \?/)
assert.match(observer, /const NATIVE_SESSION_MODEL_SCOPE: AgentModelScope = \{\}/)
assert.match(observer, /deferModelFallback/)
assert.doesNotMatch(
  read("native-session-v3-adapter.ts"),
  /taskClient\.listAgentModels\s*=/,
  "the native Session adapter must not reassign the shared model catalog client"
)

console.log("v3 Session-first UX polish regressions passed")
