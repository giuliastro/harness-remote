import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { TaskRunController } from "../src/task-run-controller.js"
import { TaskRunStore } from "../src/task-run-store.js"

function previousRun() {
  return {
    id: "run-1",
    sequence: 1,
    agentId: "codex",
    sessionId: "session-1",
    transport: "acp",
    directory: "/repo",
    prompt: "Initial prompt",
    status: "completed",
    startedAt: "2026-08-22T10:00:00.000Z",
    finishedAt: "2026-08-22T10:01:00.000Z"
  }
}

async function completedStore(stateDirectory) {
  const store = new TaskRunStore({
    machineID: "machine-idempotency",
    stateDirectory,
    idFactory: () => "task-1",
    clock: () => "2026-08-22T10:02:00.000Z"
  })
  await store.create({
    project: { id: "project-1", name: "Repo", path: "/repo", kind: "git" },
    agentId: "codex",
    prompt: "Initial prompt"
  })
  await store.load()
  const run = previousRun()
  store.tasks[0] = { ...store.tasks[0], status: "completed", run, runs: [run] }
  await store.persist()
  return store
}

test("replaying one client request id cannot create a second Run or native prompt", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-continue-idempotency-"))
  try {
    const store = await completedStore(stateDirectory)
    let nextRun = 2
    let resumeCalls = 0
    let promptCalls = 0
    const controller = new TaskRunController({
      taskStore: store,
      taskLauncher: {
        async resumeSession(_task, run) {
          resumeCalls += 1
          return { sessionId: run.sessionId, transport: "acp", directory: "/repo" }
        },
        async createSession() { throw new Error("same-harness continuation should resume") },
        async startPrompt() { promptCalls += 1 }
      },
      runIDFactory: () => `run-${nextRun++}`
    })

    const input = { prompt: "Continue exactly once", clientRequestId: "mobile-request-1" }
    const first = await controller.continue("task-1", input)
    const replay = await controller.continue("task-1", input)

    assert.equal(first.run.id, "run-2")
    assert.equal(first.run.clientRequestId, "mobile-request-1")
    assert.equal(replay.run.id, "run-2")
    assert.equal(resumeCalls, 1)
    assert.equal(promptCalls, 1)
    assert.deepEqual((await store.get("task-1")).runs.map((run) => run.id), ["run-1", "run-2"])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("concurrent retries with one client request id converge before native Session creation", async () => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "harness-continue-race-"))
  try {
    const store = await completedStore(stateDirectory)
    let nextRun = 2
    let promptCalls = 0
    let resumeCalls = 0
    const controller = new TaskRunController({
      taskStore: store,
      taskLauncher: {
        async resumeSession(_task, run) {
          resumeCalls += 1
          await new Promise((resolve) => setTimeout(resolve, 10))
          return { sessionId: run.sessionId, transport: "acp", directory: "/repo" }
        },
        async createSession() { throw new Error("same-harness continuation should resume") },
        async startPrompt() { promptCalls += 1 }
      },
      runIDFactory: () => `run-${nextRun++}`
    })

    const input = { prompt: "Race this once", clientRequestId: "mobile-request-race" }
    const [first, second] = await Promise.all([
      controller.continue("task-1", input),
      controller.continue("task-1", input)
    ])

    assert.equal(first.run.clientRequestId, "mobile-request-race")
    assert.equal(second.run.clientRequestId, "mobile-request-race")
    assert.equal(resumeCalls, 1)
    assert.equal(promptCalls, 1)
    const persisted = await store.get("task-1")
    assert.equal(persisted.runs.filter((run) => run.clientRequestId === "mobile-request-race").length, 1)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
