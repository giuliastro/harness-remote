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
    runs: [],
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
    async startPrompt(task, session) { calls.push(["prompt", task.status, session.sessionId, task.prompt]) }
  }
  const controller = new TaskRunController({ taskStore: store, taskLauncher: launcher, runIDFactory: () => "run-1", clock: () => "2026-08-13T18:00:00.000Z" })

  const result = await controller.launch("task-1")
  assert.equal(result.status, "running")
  assert.equal(result.run.id, "run-1")
  assert.equal(result.run.sessionId, "session-1")
  assert.equal(result.run.agentId, "codex")
  assert.equal(result.run.role, "implement")
  assert.deepEqual(calls, [
    ["state", "starting", null],
    ["session", "starting"],
    ["state", "starting", "session-1"],
    ["state", "running", "session-1"],
    ["prompt", "running", "session-1", "Fix it"]
  ])
})

test("a synchronous prompt completion cannot race the starting to running transition", async () => {
  let current = draft()
  const store = {
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      if (update.status === "running" && current.status !== "starting") throw new Error("Task is not starting")
      if (["completed", "failed"].includes(update.status) && !["starting", "running"].includes(current.status)) throw new Error("Task is not active")
      current = { ...current, status: update.status, run: structuredClone(update.run), error: update.error }
      return structuredClone(current)
    }
  }
  const launcher = {
    async createSession(task) { return { sessionId: "session-1", transport: "acp", directory: task.workspace.path } },
    async startPrompt(_task, _session, callbacks) { callbacks.onCompleted() }
  }
  const controller = new TaskRunController({ taskStore: store, taskLauncher: launcher, runIDFactory: () => "run-1" })

  const launched = await controller.launch("task-1")
  assert.equal(launched.status, "running")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(current.status, "completed")
})

test("completed task outcomes are persisted with the corrected outcome version", async () => {
  let current = draft()
  const store = {
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      current = { ...current, status: update.status, run: structuredClone(update.run), error: update.error }
      return structuredClone(current)
    }
  }
  const launcher = {
    async createSession(task) { return { sessionId: "session-1", transport: "acp", directory: task.workspace.path } },
    async startPrompt(_task, _session, callbacks) { callbacks.onCompleted({ outcome: "Final answer" }) }
  }
  const controller = new TaskRunController({ taskStore: store, taskLauncher: launcher, runIDFactory: () => "run-1" })

  await controller.launch("task-1")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(current.status, "completed")
  assert.equal(current.run.outcome, "Final answer")
  assert.equal(current.run.outcomeVersion, 2)
})

test("Git tasks can intentionally launch from the project checkout", async () => {
  let current = draft({ workspace: { mode: "project", path: "/repo" } })
  const store = {
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      current = { ...current, status: update.status, run: structuredClone(update.run) }
      return structuredClone(current)
    }
  }
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: {
      async createSession(task) {
        assert.equal(task.workspace.mode, "project")
        assert.equal(task.workspace.path, "/repo")
        return { sessionId: "session-project", transport: "acp" }
      },
      async startPrompt() {}
    },
    runIDFactory: () => "run-project"
  })
  const launched = await controller.launch("task-1")
  assert.equal(launched.status, "running")
  assert.equal(launched.run.directory, "/repo")
})

test("same-harness Continue creates a new Run but reuses the native Session", async () => {
  let current = draft({
    status: "completed",
    run: { id: "run-1", sequence: 1, agentId: "codex", sessionId: "session-1", transport: "acp", directory: "/state/worktrees/task-1", prompt: "Fix it", finishedAt: "2026-08-13T18:00:00.000Z" },
    runs: [{ id: "run-1", sequence: 1, agentId: "codex", sessionId: "session-1", transport: "acp", directory: "/state/worktrees/task-1", prompt: "Fix it", finishedAt: "2026-08-13T18:00:00.000Z" }]
  })
  let resumed
  let sentPrompt
  const store = {
    async list() { return [] },
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      current = { ...current, status: update.status, run: structuredClone(update.run) }
      return structuredClone(current)
    }
  }
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: {
      async resumeSession(task, previousRun) {
        resumed = { task: structuredClone(task), previousRun: structuredClone(previousRun) }
        return { sessionId: previousRun.sessionId, transport: "acp", directory: task.workspace.path }
      },
      async createSession() { throw new Error("Continue should not create a new Session") },
      async startPrompt(task) { sentPrompt = task.prompt }
    },
    runIDFactory: () => "run-2"
  })

  const continued = await controller.continue("task-1", "Now add regression tests")
  assert.equal(continued.status, "running")
  assert.equal(continued.run.id, "run-2")
  assert.equal(continued.run.sessionId, "session-1")
  assert.equal(continued.run.agentId, "codex")
  assert.equal(continued.run.role, "continue")
  assert.equal(continued.run.prompt, "Now add regression tests")
  assert.equal(resumed.previousRun.sessionId, "session-1")
  assert.equal(sentPrompt, "Now add regression tests")
})

test("cross-harness Continue creates a new Session and sends explicit Task Context", async () => {
  let current = draft({
    status: "completed",
    context: { version: 1, revision: 1, taskId: "task-1", objective: "Fix it", currentState: "completed", latestOutcome: { status: "completed", agentId: "codex", role: "implement" }, runSummaries: [] },
    run: { id: "run-1", sequence: 1, agentId: "codex", sessionId: "session-1", transport: "acp", directory: "/state/worktrees/task-1", prompt: "Fix it", status: "completed", finishedAt: "2026-08-13T18:00:00.000Z" },
    runs: [{ id: "run-1", sequence: 1, agentId: "codex", sessionId: "session-1", transport: "acp", directory: "/state/worktrees/task-1", prompt: "Fix it", status: "completed", finishedAt: "2026-08-13T18:00:00.000Z" }]
  })
  let createPrompt
  let sentPrompt
  const store = {
    async list() { return [] },
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      current = { ...current, status: update.status, run: structuredClone(update.run) }
      return structuredClone(current)
    }
  }
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: {
      async createSession(task) {
        createPrompt = task.prompt
        assert.equal(task.agentId, "claude")
        return { sessionId: "claude-session", transport: "acp", directory: task.workspace.path }
      },
      async startPrompt(task) { sentPrompt = task.prompt }
    },
    worktreeManager: { async inspect() { return { managed: true, dirty: true, changeCount: 2, changedFiles: ["src/auth.js", "test/auth.test.js"] } } },
    runIDFactory: () => "run-2"
  })

  const continued = await controller.continue("task-1", {
    prompt: "Review the implementation and list security issues",
    agentId: "claude",
    model: { providerID: "anthropic", modelID: "claude-test" },
    role: "review"
  })

  assert.equal(continued.run.agentId, "claude")
  assert.equal(continued.run.sessionId, "claude-session")
  assert.equal(continued.run.role, "review")
  assert.equal(continued.run.contextRevision, 1)
  assert.equal(continued.run.handoffFromRunId, "run-1")
  assert.deepEqual(continued.run.model, { providerID: "anthropic", modelID: "claude-test" })
  assert.match(createPrompt, /transferred by TaskDesk/)
  assert.match(createPrompt, /TASK OBJECTIVE\nFix it/)
  assert.match(createPrompt, /CHANGED FILES\n- src\/auth\.js\n- test\/auth\.test\.js/)
  assert.match(createPrompt, /YOUR ROLE\nreview/)
  assert.match(createPrompt, /USER INSTRUCTION\nReview the implementation and list security issues/)
  assert.equal(sentPrompt, createPrompt)
})

test("Task Context preview is deterministic and includes workspace changes", async () => {
  const current = draft({
    status: "completed",
    context: { version: 1, revision: 2, taskId: "task-1", objective: "Fix it", currentState: "completed", latestOutcome: null, runSummaries: [] },
    run: { id: "run-2", sequence: 2, agentId: "pi", role: "test", sessionId: "pi-1", status: "completed", prompt: "Run tests", finishedAt: "2026-08-13T19:00:00.000Z" },
    runs: []
  })
  const controller = new TaskRunController({
    taskStore: { async list() { return [] }, async get() { return structuredClone(current) } },
    taskLauncher: {},
    worktreeManager: { async inspect() { return { managed: true, dirty: true, changeCount: 1, changedFiles: ["src/index.js"] } } }
  })

  const context = await controller.context("task-1")
  assert.equal(context.version, 1)
  assert.equal(context.revision, 2)
  assert.equal(context.objective, "Fix it")
  assert.equal(context.latestRun.agentId, "pi")
  assert.equal(context.latestRun.role, "test")
  assert.deepEqual(context.changedFiles, ["src/index.js"])
  assert.equal(context.workspace.changeCount, 1)
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

test("reconciliation adopts an ACP task session and keeps an unconfirmable ACP run active", async () => {
  let current = draft({
    status: "running",
    run: { id: "run-1", agentId: "pi", sessionId: "pi-session", transport: "acp", directory: "/state/worktrees/task-1" }
  })
  const adopted = []
  const controller = new TaskRunController({
    taskStore: {
      async list() { return [structuredClone(current)] },
      async setRunState(_id, update) {
        current = { ...current, status: update.status, error: update.error }
        return structuredClone(current)
      }
    },
    taskLauncher: { async inspectRun() { return "unknown" } },
    acpService: () => ({
      async adoptTaskSession(sessionID, details) { adopted.push({ sessionID, details }) }
    })
  })

  await controller.reconciliation
  assert.equal(current.status, "running")
  assert.deepEqual(adopted, [{
    sessionID: "pi-session",
    details: { title: "Fix it", prompt: "Fix it" }
  }])
})

test("cancel refuses an unknown task", async () => {
  const controller = new TaskRunController({
    taskStore: { async get() { return null } },
    taskLauncher: { async abort() {} }
  })
  await assert.rejects(() => controller.cancel("missing-task"), /Unknown task: missing-task/)
})

test("cancel returns unchanged task when not active", async () => {
  const current = draft({ status: "completed" })
  let abortCalled = false
  const controller = new TaskRunController({
    taskStore: { async get() { return structuredClone(current) } },
    taskLauncher: { async abort() { abortCalled = true } }
  })
  const result = await controller.cancel("task-1")
  assert.equal(result.status, "completed")
  assert.equal(abortCalled, false)
})

test("cancel aborts native run and persists cancelled status", async () => {
  let current = draft({
    status: "running",
    run: { id: "run-1", sessionId: "session-1", agentId: "codex" }
  })
  let aborted = false
  const calls = []
  const controller = new TaskRunController({
    taskStore: {
      async get() { return structuredClone(current) },
      async setRunState(_id, update) {
        calls.push(["setRunState", update.status, update.run?.id])
        current = { ...current, status: update.status, run: { ...current.run, status: update.status } }
        return structuredClone(current)
      }
    },
    taskLauncher: {
      async abort(task) {
        aborted = true
        calls.push(["abort", task.run.sessionId])
      }
    }
  })

  const result = await controller.cancel("task-1")
  assert.equal(aborted, true)
  assert.equal(result.status, "cancelled")
  assert.deepEqual(calls, [
    ["abort", "session-1"],
    ["setRunState", "cancelled", "run-1"]
  ])
})

test("cancel does not persist cancelled if launcher abort throws", async () => {
  let current = draft({
    status: "running",
    run: { id: "run-1", sessionId: "session-1", agentId: "codex" }
  })
  let setRunStateCalled = false
  const controller = new TaskRunController({
    taskStore: {
      async get() { return structuredClone(current) },
      async setRunState() { setRunStateCalled = true }
    },
    taskLauncher: {
      async abort() { throw new Error("adapter crashed") }
    }
  })

  await assert.rejects(() => controller.cancel("task-1"), /adapter crashed/)
  assert.equal(setRunStateCalled, false)
  assert.equal(current.status, "running")
})

test("cancel refuses a skipped native abort when an active task has a session id", async () => {
  const current = draft({
    status: "running",
    run: { id: "run-1", sessionId: "session-1", agentId: "codex" }
  })
  let persisted = false
  const controller = new TaskRunController({
    taskStore: {
      async get() { return structuredClone(current) },
      async setRunState() { persisted = true }
    },
    taskLauncher: { async abort() { return false } }
  })

  await assert.rejects(() => controller.cancel("task-1"), (error) => error.code === "native_abort_unconfirmed")
  assert.equal(persisted, false)
  assert.equal(current.status, "running")
})

test("cancel active task without sessionId persists cancelled without aborting native session", async () => {
  let current = draft({
    status: "starting",
    run: { id: "run-1", agentId: "codex" }
  })
  const calls = []
  const controller = new TaskRunController({
    taskStore: {
      async get() { return structuredClone(current) },
      async setRunState(_id, update) {
        calls.push(["setRunState", update.status, update.run?.id])
        current = { ...current, status: update.status, run: { ...current.run, status: update.status } }
        return structuredClone(current)
      }
    },
    taskLauncher: {
      async abort(task) {
        calls.push(["abort", task.run?.sessionId ?? null])
        return false
      }
    }
  })

  const result = await controller.cancel("task-1")
  assert.equal(result.status, "cancelled")
  assert.deepEqual(calls, [
    ["abort", null],
    ["setRunState", "cancelled", "run-1"]
  ])
})

test("cancel returns early without overwrite if task completes concurrently during abort", async () => {
  let current = draft({
    status: "running",
    run: { id: "run-1", sessionId: "session-1", agentId: "codex" }
  })
  let setRunStateCalled = false
  const controller = new TaskRunController({
    taskStore: {
      async get() { return structuredClone(current) },
      async setRunState() { setRunStateCalled = true }
    },
    taskLauncher: {
      async abort() {
        // Concurrent turn completion occurs while abort is in flight
        current = {
          ...current,
          status: "completed",
          run: { ...current.run, status: "completed", finishedAt: "2026-08-13T18:05:00.000Z" }
        }
      }
    }
  })

  const result = await controller.cancel("task-1")
  assert.equal(result.status, "completed")
  assert.equal(setRunStateCalled, false)
})
