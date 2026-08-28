import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const read = (name) => readFileSync(new URL(name, import.meta.url), "utf8")

test("Harness Remote boots directly into the Session-first control plane", () => {
  const main = read("./main.tsx")
  const machineStorage = read("./workspaceMachines.ts")
  const standalone = read("./components/standalone-universal-workspace.tsx")

  assert.match(main, /function HarnessRemoteBoundary\(\)/)
  assert.match(main, /loadWorkspaceMachines/)
  assert.doesNotMatch(main, /<App key=/)
  assert.doesNotMatch(main, /ConnectServerWizard/)
  assert.match(machineStorage, /harness-remote\.workspace\.machines\.v1/)
  assert.match(standalone, /<NativeSessionsWorkspace/)
  assert.match(standalone, /<NativeSessionHome/)
  assert.match(standalone, /<NativeSessionObserver/)
  assert.doesNotMatch(standalone, /ConversationWorkspace/)
  assert.doesNotMatch(standalone, /TaskDeskWorkspace/)
  assert.doesNotMatch(standalone, /legacyView/)
  assert.doesNotMatch(standalone, />Conversations</)
})

test("the removed Conversation-first product UI stays deleted", () => {
  assert.equal(existsSync(new URL("./components/conversation-workspace.tsx", import.meta.url)), false)
  assert.equal(existsSync(new URL("./components/conversation-detail.tsx", import.meta.url)), false)
  assert.equal(existsSync(new URL("./v3-conversation-detail.test.mjs", import.meta.url)), false)

  const standalone = read("./components/standalone-universal-workspace.tsx")
  assert.doesNotMatch(standalone, /New conversation/i)
  assert.doesNotMatch(standalone, /Conversation filters/i)
  assert.doesNotMatch(standalone, /ConversationSettingsModal/)
})

test("primary product surface is Machine -> Project -> native Session", () => {
  const shell = read("./components/standalone-universal-workspace.tsx")
  const home = read("./components/native-session-home.tsx")
  const observer = read("./components/native-session-observer.tsx")
  const sharedChat = read("./components/work-thread-conversation.tsx")

  assert.match(shell, /const \[runtimes, setRuntimes\]/)
  assert.match(shell, /state: "loading" \| "online" \| "offline"/)
  assert.match(shell, /<NativeSessionHome[\s\S]*sources=\{runtimes\}/)
  assert.match(shell, /<NativeSessionObserver/)
  assert.match(home, /hr-native-machine-group/)
  assert.match(home, /hr-native-project-group/)
  assert.match(home, /hr-native-session-row/)
  assert.match(home, /sessionTreeRows/)
  assert.match(observer, /<WorkThreadConversation/)
  assert.match(sharedChat, /buildConversationTimeline/)
  assert.match(sharedChat, /<TaskDeskConversation/)
})

test("Session-first workspace keeps machines projects harness filters models and settings", () => {
  const standalone = read("./components/standalone-universal-workspace.tsx")
  const home = read("./components/native-session-home.tsx")
  const observer = read("./components/native-session-observer.tsx")
  const picker = read("./components/model-picker.tsx")

  assert.match(standalone, /MachineManager/)
  assert.match(standalone, /discoverMachine/)
  assert.match(standalone, /persistThemePreference/)
  assert.match(standalone, /persistLanguage/)
  assert.match(home, /machineFilter/)
  assert.match(home, /agentFilter/)
  assert.match(home, /createNativeSessionTarget/)
  assert.match(home, /New Session|sf\.newSession/)
  assert.match(observer, /NATIVE_SESSION_MODEL_SCOPE/)
  assert.match(observer, /deferModelFallback/)
  assert.match(picker, /Search model, provider, variant/)
})

test("native Session metadata actions belong to the open Session, not the navigation rail", () => {
  const standalone = read("./components/standalone-universal-workspace.tsx")
  const home = read("./components/native-session-home.tsx")
  const actions = read("./components/native-session-actions.tsx")
  const rename = read("./components/native-session-rename.tsx")

  assert.match(standalone, /<NativeSessionActions target=\{selected\}/)
  assert.match(actions, /api\.deleteSession/)
  assert.match(actions, /target\.deleteSupported/)
  // Rename edits the heading the header already shows, so it lives on that heading rather than in a
  // panel that covers it. It still writes through the owning harness, and still only when the
  // harness reports that it can.
  assert.match(standalone, /<NativeSessionTitle target=\{selected\}/)
  assert.match(rename, /api\.renameSession/)
  assert.match(rename, /target\.renameSupported/)
  assert.doesNotMatch(actions, /api\.renameSession/)
  assert.doesNotMatch(home, /api\.renameSession/)
  assert.doesNotMatch(home, /api\.deleteSession/)
})

test("new Session creates a real harness-owned Session in the selected Project", () => {
  const create = read("./native-session-create.ts")

  assert.match(create, /api\.createSession\(config, title\?\.trim\(\) \|\| undefined, undefined, directory\)/)
  assert.match(create, /writerOwned: true/)
  assert.doesNotMatch(create, /createTask/)
  assert.doesNotMatch(create, /createCheckpoint/)
  assert.doesNotMatch(create, /prepareWorktree/)
})

test("Session chat keeps bounded paging live events attention Stop and startup feedback", () => {
  const chat = read("./components/work-thread-conversation.tsx")
  const shared = read("./components/taskdesk-conversation.tsx")
  const parts = read("./conversation-parts.ts")
  const overrides = read("./conversation-control-plane-overrides.css")
  const messageContent = read("./components/taskdesk-message-content.tsx")

  assert.match(chat, /INITIAL_PAGE_SIZE = 200/)
  assert.match(chat, /OLDER_PAGE_SIZE = 500/)
  assert.match(chat, /ACTIVE_RECONCILE_MS = 5_000/)
  assert.match(chat, /startTaskDeskSessionLiveRefresh/)
  assert.match(chat, /currentTurnHasAssistantSignal/)
  assert.match(chat, /preparingReply/)
  assert.match(chat, /api\.loadQuestions/)
  assert.match(chat, /api\.loadPermissions/)
  assert.match(chat, /onStop=\{working \? stop : undefined\}/)
  assert.match(shared, /ThinkingIndicator/)
  assert.match(shared, /sending \|\| \(waiting && showWaitingIndicator\)/)
  assert.match(parts, /if \(forceRunning\) return "running"/)
  assert.doesNotMatch(parts, /state\?\.status === "error"\)\) return "error"/)
  assert.match(overrides, /uw-activity-group\.uw-tool-running/)
  assert.match(messageContent, /status === "running" \? "Working" : status/)
})

test("Session UI preserves stable autoscroll memoized rows and mobile keyboard behavior", () => {
  const source = read("./components/taskdesk-conversation.tsx")
  const mobileCss = read("./taskdesk-mobile-navigation.css")

  assert.match(source, /const MessageBubble = memo/)
  assert.match(source, /NEAR_BOTTOM_PX = 96/)
  assert.match(source, /nearBottomRef\.current = false/)
  assert.match(source, /window\.cancelAnimationFrame\(followFrameRef\.current\)/)
  assert.doesNotMatch(source, /previousHeight/)
  assert.match(source, /\[messages, loading, ready, sending\]/)
  assert.match(source, /window\.requestAnimationFrame/)
  assert.match(mobileCss, /env\(safe-area-inset-bottom/)
})
