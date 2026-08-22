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

test("Harness Remote boots directly into the conversation control plane", () => {
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
  const machineStorage = readFileSync(new URL("./workspaceMachines.ts", import.meta.url), "utf8")
  const standalone = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")

  assert.match(main, /function HarnessRemoteBoundary\(\)/)
  assert.match(main, /loadWorkspaceMachines/)
  assert.doesNotMatch(main, /<App key=/)
  assert.doesNotMatch(main, /ConnectServerWizard/)
  assert.match(machineStorage, /harness-remote\.workspace\.machines\.v1/)
  assert.match(standalone, /import \{ ConversationWorkspace \} from "\.\/conversation-workspace"/)
  assert.match(standalone, /<ConversationWorkspace/)
  assert.doesNotMatch(standalone, /TaskDeskWorkspace/)
  assert.doesNotMatch(standalone, /legacyView/)
})

test("primary product surface is Project -> Conversation -> native Sessions", () => {
  const shell = readFileSync(new URL("./components/conversation-workspace.tsx", import.meta.url), "utf8")
  const detail = readFileSync(new URL("./components/conversation-detail.tsx", import.meta.url), "utf8")
  const conversation = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")

  assert.match(shell, /<span className="tdw-workspace-label">Projects<\/span>/)
  assert.match(shell, /<h2>Conversations <strong className="tdw-task-drawer-count">\{visibleConversations\.length\}<\/strong><\/h2>/)
  assert.match(shell, />New conversation</)
  assert.match(shell, /<ConversationDetail/)
  assert.doesNotMatch(shell, /Advanced: Native Sessions/)
  assert.doesNotMatch(shell, /Classic Harness Remote/)
  assert.match(detail, />Chat</)
  assert.match(detail, />Sessions /)
  assert.match(detail, />Changes</)
  assert.doesNotMatch(detail, />Result</)
  assert.doesNotMatch(detail, />History/)
  assert.match(detail, /nativeSessions\(conversation\)/)
  assert.match(detail, /runSessionID/)
  assert.match(conversation, /buildWorkThreadTimeline/)
  assert.match(conversation, /<TaskDeskConversation/)
})

test("Workspace keeps machines projects coding agents filters models and settings", () => {
  const shell = readFileSync(new URL("./components/conversation-workspace.tsx", import.meta.url), "utf8")
  const standalone = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")
  const picker = readFileSync(new URL("./components/model-picker.tsx", import.meta.url), "utf8")

  assert.match(shell, /selectedMachineID/)
  assert.match(shell, /tdw-machine-section/)
  assert.match(shell, /tdw-project-section/)
  assert.match(shell, /tdw-harness-section/)
  assert.match(shell, /tdw-filter-section/)
  assert.match(shell, /Conversation filters/)
  assert.match(shell, /ConversationSettingsModal/)
  assert.match(shell, /persistThemePreference/)
  assert.match(shell, /persistLanguage/)
  assert.match(shell, /<ModelPicker models=\{models\}/)
  assert.match(picker, /Search model, provider, variant/)
  assert.match(standalone, /MachineManager/)
  assert.match(standalone, /discoverMachine/)
})

test("new conversations use the real project directory and never create a hidden worktree", () => {
  const shell = readFileSync(new URL("./components/conversation-workspace.tsx", import.meta.url), "utf8")
  const store = readFileSync(new URL("../../bridge/src/task-store.js", import.meta.url), "utf8")
  const controller = readFileSync(new URL("../../bridge/src/task-run-controller.js", import.meta.url), "utf8")

  assert.match(shell, /taskClient\.createTask/)
  assert.match(shell, /taskClient\.launch/)
  assert.doesNotMatch(shell, /prepareWorktree/)
  assert.doesNotMatch(shell, /createCheckpoint/)
  assert.match(shell, /No hidden worktree is created/)
  assert.match(store, /workspace: \{ mode: "project", path: project\.path \}/)
  assert.match(controller, /directory: task\.workspace\.path/)
})

test("one Conversation can continue through another agent and model", () => {
  const source = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
  const timeline = readFileSync(new URL("./work-thread-timeline.ts", import.meta.url), "utf8")
  const controller = readFileSync(new URL("../../bridge/src/task-run-controller.js", import.meta.url), "utf8")

  assert.match(source, /taskClient\.continueTask\(baseConfig, task\.id, \{/)
  assert.match(source, /agentId: targetAgentID/)
  assert.match(source, /providerID: selectedModel\.providerID/)
  assert.match(source, /modelID: selectedModel\.modelID/)
  assert.match(source, /<ModelPicker compact/)
  assert.match(timeline, /Continued with \$\{label\}/)
  assert.match(timeline, /Model changed to \$\{model\}/)
  assert.match(controller, /formatTaskHandoff/)
  assert.match(controller, /latestRunForAgent/)
  assert.match(controller, /resumeSession/)
  assert.match(controller, /createSession/)
})

test("native Sessions are linked, inspectable and not replaced by a second Session page", () => {
  const detail = readFileSync(new URL("./components/conversation-detail.tsx", import.meta.url), "utf8")
  const standalone = readFileSync(new URL("./components/standalone-universal-workspace.tsx", import.meta.url), "utf8")

  assert.match(detail, /Native continuity/)
  assert.match(detail, /native Session/)
  assert.match(detail, /Continued with/)
  assert.match(detail, /Session ID/)
  assert.match(detail, /Working directory/)
  assert.doesNotMatch(standalone, /<UniversalWorkspace/)
  assert.doesNotMatch(standalone, /Advanced/)
  assert.doesNotMatch(standalone, /Classic/)
})

test("conversation chat keeps bounded paging live events attention Stop and startup feedback", () => {
  const conversation = readFileSync(new URL("./components/work-thread-conversation.tsx", import.meta.url), "utf8")
  const shared = readFileSync(new URL("./components/taskdesk-conversation.tsx", import.meta.url), "utf8")
  const parts = readFileSync(new URL("./conversation-parts.ts", import.meta.url), "utf8")
  const overrides = readFileSync(new URL("./conversation-control-plane-overrides.css", import.meta.url), "utf8")
  const abort = readFileSync(new URL("../../bridge/src/work-thread-abort.js", import.meta.url), "utf8")

  assert.match(conversation, /INITIAL_PAGE_SIZE = 200/)
  assert.match(conversation, /OLDER_PAGE_SIZE = 500/)
  assert.match(conversation, /ACTIVE_RECONCILE_MS = 5_000/)
  assert.match(conversation, /startTaskDeskSessionLiveRefresh/)
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
  assert.match(overrides, /content: "Working"/)
  assert.match(abort, /service\.abort\(sessionID\)/)
})

test("Changes stay grounded in the project workspace and current native Session", () => {
  const detail = readFileSync(new URL("./components/conversation-detail.tsx", import.meta.url), "utf8")
  assert.match(detail, /taskClient\.inspectWorkspace/)
  assert.match(detail, /api\.loadDiff/)
  assert.match(detail, /Project workspace/)
  assert.match(detail, /No project changes/)
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
