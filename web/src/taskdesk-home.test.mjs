import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createTaskDeskTranslator } from "./taskdesk-i18n.ts"
import { loadWorkspaceMachines, persistWorkspaceMachines } from "./workspaceMachines.ts"
import { normalizeTaskStatus, sortTasksByActivity, taskTitle } from "./taskdeskHomeModel.ts"

function memoryStorage() {
  const data = new Map()
  return {
    getItem(key) { return data.has(key) ? data.get(key) : null },
    setItem(key, value) { data.set(key, String(value)) },
    removeItem(key) { data.delete(key) }
  }
}

test("TaskDesk normalizes backend lifecycle states for the Tasks view", () => {
  assert.equal(normalizeTaskStatus("running"), "running")
  assert.equal(normalizeTaskStatus("preparing"), "preparing")
  assert.equal(normalizeTaskStatus("queued"), "queued")
  assert.equal(normalizeTaskStatus("completed"), "completed")
  assert.equal(normalizeTaskStatus("failed"), "failed")
  assert.equal(normalizeTaskStatus("cancelled"), "cancelled")
  assert.equal(normalizeTaskStatus("mystery"), "draft")
})

test("TaskDesk derives stable task row labels without flattening Tasks into Sessions", () => {
  assert.equal(taskTitle({ id: "abc", prompt: "First line\nSecond line" }), "First line")
  assert.equal(taskTitle({ id: "abc", prompt: "" }), "Task abc")
})

test("TaskDesk sorts Tasks by durable task activity rather than session order", () => {
  const tasks = [
    { id: "a", updatedAt: "2026-08-01T10:00:00.000Z" },
    { id: "b", updatedAt: "2026-08-01T12:00:00.000Z" },
    { id: "c", updatedAt: "2026-08-01T11:00:00.000Z" }
  ]
  assert.deepEqual(sortTasksByActivity(tasks).map((task) => task.id), ["b", "c", "a"])
})

test("TaskDesk machine configuration remains independent from Classic profiles and activates the unified shell", () => {
  const storage = memoryStorage()
  globalThis.localStorage = storage
  persistWorkspaceMachines([{ id: "machine-a", name: "Machine A", config: { host: "127.0.0.1", port: 4097, username: "", password: "", backend: "codex" } }])
  assert.equal(loadWorkspaceMachines().length, 1)
  const main = readFileSync(new URL("./main.tsx", import.meta.url), "utf8")
  assert.match(main, /<StandaloneUniversalWorkspace/)
  assert.match(main, /loadWorkspaceMachines/)
})

test("TaskDesk v3 exposes Tasks as a separate durable product surface", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  assert.match(source, /type TaskDeskView = "overview" \| "tasks" \| "sessions"/)
  assert.match(source, /taskClient\.listTasks/)
  assert.match(source, /taskClient\.createTask/)
  assert.match(source, /taskClient\.launch/)
  assert.match(source, /taskClient\.inspectResult/)
  assert.match(source, /taskClient\.finish/)
})

test("TaskDesk v3 New Task uses real machine task APIs and explicit workspace choice", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  assert.match(source, /taskClient\.createTask/)
  assert.match(source, /taskClient\.prepareWorktree/)
  assert.match(source, /taskClient\.launch/)
  assert.match(source, /className="td3-workspace-choice td3-form-wide"/)
  assert.match(source, /project\?\.kind === "git"/)
})

test("TaskDesk v3 Task detail uses the native Run session and lifecycle APIs", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  assert.match(source, /runSessionID/)
  assert.match(source, /api\.loadMessages/)
  assert.match(source, /api\.loadDiff/)
  assert.match(source, /taskClient\.finish/)
  assert.match(source, /taskClient\.cleanupWorkspace/)
})

test("Task clicks explicitly open a closable review detail instead of silently changing selection", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  const css = readFileSync(new URL("./taskdesk-v3-unified.css", import.meta.url), "utf8")

  assert.match(source, /const \[detailOpen, setDetailOpen\] = useState\(false\)/)
  assert.match(source, /function openTask\(record: TaskRecord/)
  assert.match(source, /setDetailOpen\(true\)/)
  assert.match(source, /onClick=\{\(\) => openTask\(record\)\}/)
  assert.match(source, /aria-label=\{t\("detail\.close"\)\}/)
  assert.equal(createTaskDeskTranslator("en")("detail.close"), "Close Task detail")
  assert.match(source, /setDetailOpen\(false\)/)
  assert.match(css, /\.td3-tasks-layout-unified\.detail-open/)
  assert.match(css, /@keyframes td3-detail-enter/)
})

test("Sessions stays inside the persistent TaskDesk product shell without the old floating return button", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  const css = readFileSync(new URL("./taskdesk-v3-unified.css", import.meta.url), "utf8")

  assert.match(source, /<div className="td3-shell td3-shell-unified">[\s\S]*?\{nav\}[\s\S]*?\{topbar\}/)
  assert.match(source, /view === "sessions" \? <main className=\{`td3-sessions-embedded/)
  assert.match(source, /machineScope === "all" \? machines : machines\.filter/)
  assert.doesNotMatch(source, /td3-session-mode/)
  assert.doesNotMatch(source, /td3-return-button/)
  assert.match(css, /\.td3-sessions-embedded \.uw-brand,[\s\S]*?\.td3-sessions-embedded \.uw-top-actions[\s\S]*?display: none/)
  assert.match(css, /\.td3-sessions-embedded \.uw-shell/)
})

test("Open Session navigates from a Task or attention item to the exact native Session and Run harness", () => {
  const taskDesk = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  const workspace = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")

  assert.match(taskDesk, /type SessionFocusRequest = \{ sessionID: string; requestID: number; agentID\?: string \}/)
  assert.match(taskDesk, /function openNativeSession\(runtime: RuntimeMachine, sessionID: string, agentID\?: string\)/)
  assert.match(taskDesk, /setSessionFocusRequest\(\(current\) => \(\{ sessionID, agentID, requestID:/)
  assert.match(taskDesk, /focusSessionRequest=\{sessionFocusRequest\}/)
  assert.match(taskDesk, /openNativeSession\(selected\.runtime, selectedSessionID, selectedRunAgentID\)/)
  assert.match(workspace, /focusSessionRequest\?: \{ sessionID: string; requestID: number; agentID\?: string \} \| null/)
  assert.match(workspace, /item\.session\.id === pendingFocus\.sessionID && \(!pendingFocus\.agentID \|\| item\.agent\.id === pendingFocus\.agentID\)/)
  assert.match(workspace, /setMachineFilter\(target\.machineKey\)/)
  assert.match(workspace, /setProjectFilter\("all"\)/)
  assert.match(workspace, /setDetailTab\("conversation"\)/)
  assert.match(workspace, /setSelectedKey\(target\.key\)/)
})

test("TaskDesk distinguishes completed Runs awaiting review from explicitly finished Tasks", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  const finishServer = readFileSync(new URL("../../bridge/src/task-finish-server.js", import.meta.url), "utf8")

  assert.match(source, /if \(task\.finishedAt\) return "finished"/)
  assert.match(source, /if \(status === "completed"\) return "review"/)
  assert.match(source, /t\("action\.finishTask"\)/)
  assert.match(source, /t\("action\.cleanupWorkspace"\)/)
  assert.match(finishServer, /taskStore\.markFinished/)
})

test("TaskDesk unified styling keeps dense product text readable across Tasks and Sessions", () => {
  const css = readFileSync(new URL("./taskdesk-v3-unified.css", import.meta.url), "utf8")
  assert.match(css, /\.td3-sessions-embedded \.uw-markdown,[\s\S]*?font-size: 12\.5px/)
  assert.match(css, /\.td3-sessions-embedded \.uw-session-title-row strong[\s\S]*?font-size: 12\.5px/)
})

test("TaskDesk v3 protects Task detail from stale asynchronous responses", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  assert.match(source, /const detailGeneration = useRef\(0\)/)
  assert.match(source, /const generation = \+\+detailGeneration\.current/)
  assert.match(source, /if \(generation !== detailGeneration\.current\) return/)
})

test("TaskDesk v3 aggregates native questions and permissions into Needs You", () => {
  const source = readFileSync(new URL("./components/taskdesk-v3-unified.tsx", import.meta.url), "utf8")
  assert.match(source, /api\.loadQuestions/)
  assert.match(source, /api\.loadPermissions/)
  assert.match(source, /type: "permission"/)
  assert.match(source, /type: "question"/)
})

test("Session waiting indicator stays in transcript flow and follows autoscroll", () => {
  const source = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  assert.match(source, /sessionWaiting/)
  assert.match(source, /uw-session-typing/)
  assert.match(source, /transcriptRef\.current\.scrollTop = transcriptRef\.current\.scrollHeight/)
})

test("Session handoff reuses the exact workspace when switching harnesses on the same machine", () => {
  const source = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  assert.match(source, /const sameMachine = selected\?\.machine\.key === current\.machineKey/)
  assert.match(source, /const targetDirectory = sameMachine \? current\.session\.directory : discoveredTargetProject\?\.path/)
})

test("Universal workspace cannot starve initial loading with overlapping polls", () => {
  const source = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  assert.match(source, /if \(refreshInFlight\.current\) return/)
  assert.match(source, /refreshInFlight\.current = true/)
  assert.match(source, /refreshInFlight\.current = false/)
})

test("Universal workspace counts and projects follow the selected machine scope", () => {
  const source = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  assert.match(source, /machineScopedSessions/)
  assert.match(source, /machineFilter === "all" \|\| item\.machineKey === machineFilter/)
  assert.match(source, /const projects = useMemo/)
})

test("Universal workspace resolves and can change the model of the selected session", () => {
  const source = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  assert.match(source, /sessionModels/)
  assert.match(source, /sessionModelKey/)
  assert.match(source, /api\.listModels/)
})

test("Universal workspace gives supported harness replies their own local visual identity", () => {
  const source = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  assert.match(source, /HARNESS_ICON_FILES/)
  assert.match(source, /HarnessAvatar/)
})

test("Universal workspace never renders stale detail for a newly selected session", () => {
  const source = readFileSync(new URL("./components/universal-workspace.tsx", import.meta.url), "utf8")
  assert.match(source, /detailSessionKey/)
  assert.match(source, /detailReady/)
  assert.match(source, /selectedKeyRef/)
})
