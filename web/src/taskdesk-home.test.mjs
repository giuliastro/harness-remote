import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import {
  agentLabel,
  modelLabel,
  normalizeTaskStatus,
  sortTasksByActivity,
  taskStatusLabel,
  taskTitle
} from "./taskdeskHomeModel.ts"

function task(overrides = {}) {
  return {
    id: "task-1",
    machineId: "machine-1",
    projectId: "project-1",
    project: { name: "Harness Remote", path: "/repo", kind: "git" },
    agentId: "codex",
    prompt: "Fix the authentication regression\nMore context",
    model: { providerID: "openai", modelID: "gpt-test", variant: "high" },
    status: "running",
    workspace: { mode: "project", path: "/repo" },
    run: null,
    createdAt: "2026-08-18T10:00:00.000Z",
    updatedAt: "2026-08-18T11:00:00.000Z",
    ...overrides
  }
}

test("legacy persisted records remain readable while the product vocabulary changes", () => {
  assert.equal(normalizeTaskStatus("created"), "preparing")
  assert.equal(normalizeTaskStatus("pending"), "queued")
  assert.equal(normalizeTaskStatus("busy"), "running")
  assert.equal(normalizeTaskStatus("needs_attention"), "waiting")
  assert.equal(normalizeTaskStatus("succeeded"), "completed")
  assert.equal(normalizeTaskStatus("error"), "failed")
  assert.equal(normalizeTaskStatus("aborted"), "cancelled")
  assert.equal(normalizeTaskStatus("custom-state"), "unknown")
  assert.equal(taskStatusLabel("custom-state"), "custom-state")

  const value = task()
  assert.equal(taskTitle(value), "Fix the authentication regression")
  assert.equal(modelLabel(value), "gpt-test · high")
  assert.equal(agentLabel([
    { id: "codex", label: "Codex CLI", backend: "codex", transport: "acp", managed: false, state: "available", capabilities: {} }
  ], value.agentId), "Codex CLI")
  assert.deepEqual(sortTasksByActivity([
    task({ id: "older", updatedAt: "2026-08-18T09:00:00.000Z" }),
    task({ id: "newer", updatedAt: "2026-08-18T12:00:00.000Z" })
  ]).map((item) => item.id), ["newer", "older"])
})

test("Harness Remote boots directly into the Session-first control plane", () => {
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
  const machineStorage = readFileSync(new URL("./workspaceMachines.ts", import.meta.url), "utf8")
  const standalone = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")

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
})

test("primary product surface is Machine -> Project -> native Session", () => {
  const shell = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
  const home = readFileSync(new URL("./components/native-session-home.tsx", import.meta.url), "utf8")
  const observer = readFileSync(new URL("./components/native-session-observer.tsx", import.meta.url), "utf8")
  const conversation = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")

  assert.match(shell, /const \[runtimes, setRuntimes\]/)
  assert.match(shell, /state: "loading" \| "online" \| "offline"/)
  assert.match(shell, /<NativeSessionHome[\s\S]*?sources=\{runtimes\}/)
  assert.match(shell, /<NativeSessionObserver/)
  assert.match(home, /hr-native-machine-group/)
  assert.match(home, /hr-native-project-group/)
  assert.match(home, /hr-native-session-row/)
  assert.match(home, /sessionTreeRows/)
  assert.match(observer, /<WorkThreadConversation/)
  assert.match(conversation, /buildWorkThreadTimeline/)
  assert.match(conversation, /<TaskDeskConversation/)
  assert.doesNotMatch(shell, />New conversation</)
  assert.doesNotMatch(shell, />Conversations</)
})

test("Session-first workspace keeps machines projects harnesses models filters and settings", () => {
  const shell = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
  const home = readFileSync(new URL("./components/native-session-home.tsx", import.meta.url), "utf8")
  const observer = readFileSync(new URL("./components/native-session-observer.tsx", import.meta.url), "utf8")
  const conversation = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
  const picker = readFileSync(new URL("./components/model-picker.tsx", import.meta.url), "utf8")

  assert.match(shell, /MachineManager/)
  assert.match(shell, /discoverMachine/)
  assert.match(shell, /projectLabel/)
  assert.match(shell, /MobileSettingsPage/)
  assert.match(shell, /persistThemePreference/)
  assert.match(shell, /persistLanguage/)
  assert.match(home, /type SessionFilter = "all" \| "working" \| "attention"/)
  assert.match(home, /HARNESS_ICON_FILES/)
  assert.match(home, /projectGroups/)
  assert.match(home, /canCreateNativeSession/)
  assert.match(observer, /NATIVE_SESSION_MODEL_SCOPE/)
  assert.match(conversation, /<ModelPicker compact/)
  assert.match(picker, /Search model, provider, variant/)
})

test("Session-first control mutates the exact native Session without creating a hidden Task or worktree", () => {
  const shell = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
  const observer = readFileSync(new URL("./components/native-session-observer.tsx", import.meta.url), "utf8")
  const adapter = readFileSync(new URL("./native-session-v3-adapter.ts", import.meta.url), "utf8")

  assert.match(observer, /registerNativeSessionV3Adapter\(initialTarget/)
  assert.match(observer, /key=\{target\.key\}/)
  assert.match(adapter, /sendNativeSessionPrompt\(entry\.target, prompt, model\)/)
  assert.match(adapter, /stopNativeSession\(entry\.target, operationToken\)/)
  assert.match(adapter, /Cross-agent continuation is disabled until single-Session parity is validated/)
  assert.doesNotMatch(shell, /taskClient\.createTask/)
  assert.doesNotMatch(shell, /prepareWorktree/)
  assert.doesNotMatch(observer, /taskClient\.createTask/)
})

test("native Sessions are directly inspectable instead of being wrapped by a legacy detail page", () => {
  const shell = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
  const observer = readFileSync(new URL("./components/native-session-observer.tsx", import.meta.url), "utf8")

  assert.match(shell, /selected\.sessionID/)
  assert.match(shell, /selected\.directory/)
  assert.match(shell, /selected\.summary/)
  assert.match(shell, /selected\.nativeAgent/)
  assert.match(shell, /<NativeSessionActions/)
  assert.match(shell, /<NativeSessionHandoffControl/)
  assert.match(observer, /Thin Session-first adapter around the mature HR3 conversation controller/)
  assert.doesNotMatch(shell, /<UniversalWorkspace/)
  assert.doesNotMatch(shell, /Advanced/)
  assert.doesNotMatch(shell, /Classic/)
})

test("conversation chat keeps bounded paging live events attention Stop and startup feedback", () => {
  const conversation = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
  const shared = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
  const parts = readFileSync(new URL("./conversation-parts.ts", import.meta.url), "utf8")
  const overrides = readFileSync(new URL("./conversation-control-plane-overrides.css", import.meta.url), "utf8")
  const messageContent = readFileSync(new URL("./components/taskdesk-message-content.tsx", import.meta.url), "utf8")
  const abort = readFileSync(new URL("../../bridge/src/work-thread-abort.js", import.meta.url), "utf8")

  assert.match(conversation, /INITIAL_PAGE_SIZE = 200/)
  assert.match(conversation, /OLDER_PAGE_SIZE = 500/)
  assert.match(conversation, /ACTIVE_RECONCILE_MS = 5_000/)
  assert.match(conversation, /startTaskDeskSessionLiveRefresh/)
  assert.match(conversation, /createCoalescedTailRefresh/)
  assert.match(conversation, /currentRunHasAssistantSignal/)
  assert.match(conversation, /preparingReply/)
  assert.match(conversation, /api\.loadQuestions/)
  assert.match(conversation, /api\.loadPermissions/)
  assert.match(conversation, /onStop=\{working \? stop : undefined\}/)
  assert.match(shared, /ThinkingIndicator/)
  assert.match(shared, /sending \|\| \(waiting && showWaitingIndicator\)/)
  assert.match(parts, /if \(forceRunning\) return "running"/)
  assert.doesNotMatch(parts, /state\?\.status === "error"\)\) return "error"/)
  assert.match(overrides, /uw-activity-group\.uw-tool-running/)
  assert.match(messageContent, /status === "running" \? "Working" : status/)
  assert.match(abort, /service\.abort\(sessionID\)/)
})

test("conversation UI preserves stable autoscroll memoized rows and mobile keyboard behavior", () => {
  const source = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
  const mobileCss = readFileSync(new URL("./taskdesk-mobile-navigation.css", import.meta.url), "utf8")

  assert.match(source, /const MessageBubble = memo/)
  assert.match(source, /NEAR_BOTTOM_PX = 96/)
  assert.match(source, /previousHeight/)
  assert.match(source, /\[messages, loading, ready, sending\]/)
  assert.match(source, /window\.requestAnimationFrame/)
  assert.match(mobileCss, /env\(safe-area-inset-bottom/)
})
