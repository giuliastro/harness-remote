import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { TaskLauncher } from "../src/task-launcher.js"
import { TaskRunController } from "../src/task-run-controller.js"
import { TaskRunStore } from "../src/task-run-store.js"
import { WorkThreadController } from "../src/work-thread-controller.js"

function clone(value) {
  return structuredClone(value)
}

async function storeFor(task) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "work-thread-lifecycle-"))
  const store = new TaskRunStore({
    machineID: "machine-1",
    stateDirectory,
    clock: () => "2026-08-21T13:00:00.000Z"
  })
  await mkdir(stateDirectory, { recursive: true })
  await writeFile(store.file, JSON.stringify({
    version: 1,
    machineId: "machine-1",
    tasks: [clone(task)]
  }), "utf8")
  await store.load()
  return {
    store,
    cleanup: async () => { await rm(stateDirectory, { recursive: true, force: true }) }
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
  const { store, cleanup } = await storeFor(activeTask())
  try {
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
  } finally {
    await cleanup()
  }
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
  const { store, cleanup } = await storeFor(task)
  try {
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
  } finally {
    await cleanup()
  }
})

test("Stop preserves a persisted active task when its native session transport is missing", async () => {
  const task = activeTask()
  delete task.run.transport
  for (const run of task.runs) delete run.transport
  const { store, cleanup } = await storeFor(task)
  try {
    let abortCalls = 0
    const acpService = () => ({ async abort() { abortCalls += 1 } })
    const launcher = new TaskLauncher({
      daemon: { hostEntry: () => ({ kind: "acp" }) },
      acpService
    })
    const taskRunController = new TaskRunController({ taskStore: store, taskLauncher: launcher, acpService })
    await taskRunController.reconciliation
    const controller = new WorkThreadController({ taskStore: store, taskRunController, checkpointManager })
    const before = await store.get("thread-1")

    await assert.rejects(() => controller.markCancelled("thread-1"), /native session transport is missing/)
    assert.equal(abortCalls, 0)
    assert.deepEqual(await store.get("thread-1"), before)
  } finally {
    await cleanup()
  }
})

test("Stop never persists cancelled if the real native abort fails", async () => {
  const { store, cleanup } = await storeFor(activeTask())
  try {
    const launcher = new TaskLauncher({
      acpService: () => ({
        async abort() { throw new Error("native abort failed") }
      })
    })
    const taskRunController = new TaskRunController({
      taskStore: store,
      taskLauncher: launcher
    })
    const controller = new WorkThreadController({
      taskStore: store,
      taskRunController,
      checkpointManager
    })

    await assert.rejects(() => controller.markCancelled("thread-1"), /native abort failed/)
    const thread = await store.get("thread-1")
    assert.equal(thread.status, "running")
    assert.equal(thread.run.status, undefined)
  } finally {
    await cleanup()
  }
})

test("Stop persists cancelled when native abort succeeds", async () => {
  const { store, cleanup } = await storeFor(activeTask())
  try {
    let aborted = false
    const launcher = new TaskLauncher({
      acpService: () => ({
        async abort() { aborted = true }
      })
    })
    const taskRunController = new TaskRunController({
      taskStore: store,
      taskLauncher: launcher
    })
    const controller = new WorkThreadController({
      taskStore: store,
      taskRunController,
      checkpointManager
    })

    const thread = await controller.markCancelled("thread-1")
    assert.equal(aborted, true)
    assert.equal(thread.status, "cancelled")
    assert.equal(thread.run.status, "cancelled")
    assert.ok(thread.run.finishedAt)
  } finally {
    await cleanup()
  }
})
