import assert from "node:assert/strict"
import test from "node:test"
import { WorkThreadController } from "../src/work-thread-controller.js"

function clone(value) {
  return structuredClone(value)
}

class FakeStore {
  constructor(task) {
    this.tasks = [clone(task)]
    this.stateDirectory = "/tmp/taskdesk-test"
  }

  async load() {}
  async persist() {}
  async list() { return clone(this.tasks) }
  async get(id) { return clone(this.tasks.find((task) => task.id === id)) }

  async setRunState(id, { status, run, error = null, expectedRunId }) {
    const index = this.tasks.findIndex((task) => task.id === id)
    const current = this.tasks[index]
    if (expectedRunId !== undefined && current.run?.id !== expectedRunId) return clone(current)
    const nextRun = run ? { ...clone(run), status } : current.run
    if ((status === "completed" || status === "failed") && nextRun && !nextRun.finishedAt) {
      nextRun.finishedAt = "2026-08-21T13:00:00.000Z"
    }
    const runs = Array.isArray(current.runs)
      ? current.runs.map((entry) => entry.id === nextRun?.id ? nextRun : entry)
      : nextRun ? [nextRun] : []
    this.tasks[index] = {
      ...current,
      status,
      run: nextRun,
      runs,
      error: error ? { message: error instanceof Error ? error.message : String(error) } : null,
      updatedAt: "2026-08-21T13:00:00.000Z"
    }
    return clone(this.tasks[index])
  }
}

function activeTask(overrides = {}) {
  return {
    id: "thread-1",
    agentId: "codex",
    prompt: "Keep fixing the app",
    status: "running",
    project: { kind: "git", path: "/repo" },
    workspace: { mode: "worktree", path: "/worktree" },
    run: {
      id: "run-1",
      agentId: "codex",
      sessionId: "session-1",
      transport: "acp",
      startedAt: "2026-08-21T12:00:00.000Z"
    },
    runs: [{
      id: "run-1",
      agentId: "codex",
      sessionId: "session-1",
      transport: "acp",
      startedAt: "2026-08-21T12:00:00.000Z"
    }],
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    ...overrides
  }
}

const checkpointManager = {
  async create() { return null },
  async restore() { throw new Error("not used") }
}

test("ACP Work Thread stuck as running is reconciled to completed when native Session is idle", async () => {
  const store = new FakeStore(activeTask())
  const controller = new WorkThreadController({
    taskStore: store,
    taskRunController: {
      acpService: () => ({ status: () => ({ type: "idle" }) }),
      taskLauncher: { inspectRun: async () => "unknown" }
    },
    checkpointManager
  })

  const thread = await controller.get("thread-1")
  assert.equal(thread.status, "completed")
  assert.equal(thread.run.status, "completed")
  assert.ok(thread.run.finishedAt)
})

test("HTTP Work Thread stuck as running is reconciled to completed from native session status", async () => {
  const task = activeTask({
    agentId: "opencode",
    run: {
      id: "run-http",
      agentId: "opencode",
      sessionId: "session-http",
      transport: "http",
      startedAt: "2026-08-21T12:00:00.000Z"
    },
    runs: [{
      id: "run-http",
      agentId: "opencode",
      sessionId: "session-http",
      transport: "http",
      startedAt: "2026-08-21T12:00:00.000Z"
    }]
  })
  const store = new FakeStore(task)
  const controller = new WorkThreadController({
    taskStore: store,
    taskRunController: {
      acpService: () => null,
      taskLauncher: { inspectRun: async () => "completed" }
    },
    checkpointManager
  })

  const thread = await controller.get("thread-1")
  assert.equal(thread.status, "completed")
  assert.equal(thread.run.status, "completed")
})

test("Stop never persists cancelled if the real native abort fails", async () => {
  const store = new FakeStore(activeTask())
  const controller = new WorkThreadController({
    taskStore: store,
    taskRunController: {
      acpService: () => ({
        async abort() { throw new Error("native abort failed") }
      }),
      taskLauncher: { inspectRun: async () => "running" }
    },
    checkpointManager
  })

  await assert.rejects(() => controller.markCancelled("thread-1"), /native abort failed/)
  const thread = await store.get("thread-1")
  assert.equal(thread.status, "running")
  assert.equal(thread.run.status, undefined)
})