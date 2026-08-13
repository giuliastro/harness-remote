import assert from "node:assert/strict"
import test from "node:test"
import { TaskRunController } from "../src/task-run-controller.js"

function draft(overrides = {}) {
  return {
    id: "task-1",
    status: "draft",
    agentId: "codex",
    prompt: "Fix it",
    project: { kind: "git", path: "/repo" },
    workspace: { mode: "worktree", path: "/state/worktrees/task-1" },
    run: null,
    ...overrides
  }
}

test("launch persists run identity before starting the prompt and ends running", async () => {
  let current = draft()
  const calls = []
  const store = {
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      calls.push(["state", update.status, update.run.sessionId])
      current = { ...current, status: update.status, run: structuredClone(update.run) }
      return structuredClone(current)
    }
  }
  const launcher = {
    async createSession(task) {
      calls.push(["session", task.status])
      return { sessionId: "session-1", transport: "acp", directory: task.workspace.path }
    },
    async startPrompt(task, session) { calls.push(["prompt", task.status, session.sessionId]) }
  }
  const controller = new TaskRunController({ taskStore: store, taskLauncher: launcher, runIDFactory: () => "run-1", clock: () => "2026-08-13T18:00:00.000Z" })

  const result = await controller.launch("task-1")
  assert.equal(result.status, "running")
  assert.equal(result.run.id, "run-1")
  assert.equal(result.run.sessionId, "session-1")
  assert.deepEqual(calls, [
    ["state", "starting", null],
    ["session", "starting"],
    ["state", "starting", "session-1"],
    ["prompt", "starting", "session-1"],
    ["state", "running", "session-1"]
  ])
})

test("Git tasks cannot launch from the primary checkout", async () => {
  const controller = new TaskRunController({ taskStore: { async get() { return draft({ workspace: { mode: "project", path: "/repo" } }) } }, taskLauncher: {} })
  await assert.rejects(() => controller.launch("task-1"), /isolated worktree/)
})

test("launch failures persist failed state", async () => {
  let current = draft()
  const states = []
  const controller = new TaskRunController({
    taskStore: {
      async get() { return structuredClone(current) },
      async setRunState(_id, update) {
        states.push(update.status)
        current = { ...current, status: update.status, run: update.run, error: update.error }
        return structuredClone(current)
      }
    },
    taskLauncher: { async createSession() { throw new Error("agent unavailable") } },
    runIDFactory: () => "run-1"
  })
  await assert.rejects(() => controller.launch("task-1"), /agent unavailable/)
  assert.deepEqual(states, ["starting", "failed"])
})

test("asynchronous prompt failures mark the same running run failed", async () => {
  let current = draft()
  let rejectPrompt
  const store = {
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      current = { ...current, status: update.status, run: structuredClone(update.run), error: update.error }
      return structuredClone(current)
    }
  }
  const launcher = {
    async createSession(task) { return { sessionId: "session-1", transport: "acp", directory: task.workspace.path } },
    async startPrompt(_task, _session, onPromptFailed) { rejectPrompt = onPromptFailed }
  }
  const controller = new TaskRunController({ taskStore: store, taskLauncher: launcher, runIDFactory: () => "run-1" })
  const launched = await controller.launch("task-1")
  assert.equal(launched.status, "running")

  rejectPrompt(new Error("prompt failed"))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(current.status, "failed")
  assert.equal(current.run.id, "run-1")
})

test("reconciliation load failures stay isolated and surface as unavailable", async () => {
  const controller = new TaskRunController({
    taskStore: {
      async list() { throw new Error("permission denied") },
      async get() { throw new Error("should not read tasks after failed reconciliation") }
    },
    taskLauncher: {}
  })

  await controller.reconciliation
  await assert.rejects(
    () => controller.inspectWorkspace("task-1"),
    (error) => error.code === "agent_unavailable" && error.message === "Task state is unavailable"
  )
})
