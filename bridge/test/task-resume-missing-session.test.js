import assert from "node:assert/strict"
import test from "node:test"
import { TaskLauncher } from "../src/task-launcher.js"
import { TaskRunController } from "../src/task-run-controller.js"

function completedTask() {
  const run = {
    id: "run-1",
    sequence: 1,
    agentId: "codex",
    sessionId: "01a0285c-cc51-7631-8161-ae9486b78cb1",
    transport: "acp",
    directory: "/repo",
    prompt: "Initial work",
    status: "completed",
    finishedAt: "2026-08-22T07:00:00.000Z"
  }
  return {
    id: "task-1",
    status: "completed",
    agentId: "codex",
    prompt: "Initial work",
    project: { kind: "git", path: "/repo" },
    workspace: { mode: "project", path: "/repo" },
    run,
    runs: [run],
    context: { version: 1, revision: 1, objective: "Initial work", currentState: "completed", runSummaries: [] }
  }
}

function daemonFor(host = {}) {
  return {
    hostEntry: () => ({ kind: "acp", host }),
    registry: { host: () => ({ state: "available" }) }
  }
}

function memoryStore(initial) {
  let current = initial
  return {
    async list() { return [] },
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      const run = structuredClone(update.run ?? current.run)
      const runs = Array.isArray(current.runs) ? current.runs.map((entry) => entry.id === run?.id ? run : entry) : []
      if (run?.id && !runs.some((entry) => entry.id === run.id)) runs.push(run)
      current = { ...current, status: update.status, run, runs, error: update.error ?? null }
      return structuredClone(current)
    }
  }
}

test("normal Continue falls back to a fresh ACP Session when persisted history points at a missing native Session", async () => {
  let promptSent = ""
  const store = memoryStore(completedTask())
  const service = {
    async adoptTaskSession() { return true },
    async models() { throw new Error("Internal error: Session 01a0285c-cc51-7631-8161-ae9486b78cb1 not found") },
    async createSession() { return { id: "fresh-session" } },
    async promptAndWait(_sessionID, text) { promptSent = text },
    async messages() { return [] }
  }
  const launcher = new TaskLauncher({ daemon: daemonFor(), acpService: () => service })
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: launcher,
    runIDFactory: () => "run-2",
    clock: () => "2026-08-22T08:00:00.000Z"
  })

  const continued = await controller.continue("task-1", "Continue from where we left off")
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(continued.status, "running")
  assert.equal(continued.run.sessionId, "fresh-session")
  assert.equal(continued.run.handoffReason, "session_unavailable")
  assert.equal(continued.run.handoffFromRunId, "run-1")
  assert.match(promptSent, /transferred by TaskDesk/i)
  assert.match(promptSent, /Continue from where we left off/)
})

test("normal Continue creates a fresh Session with Task context when no native Session is recorded", async () => {
  const prior = completedTask()
  prior.run = { ...prior.run, sessionId: null, transport: null }
  prior.runs = [prior.run]
  let promptSent = ""
  const store = memoryStore(prior)
  const service = {
    async createSession() { return { id: "replacement-session" } },
    async promptAndWait(_sessionID, text) { promptSent = text },
    async messages() { return [] }
  }
  const launcher = new TaskLauncher({ daemon: daemonFor(), acpService: () => service })
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: launcher,
    runIDFactory: () => "run-2",
    clock: () => "2026-08-22T08:00:00.000Z"
  })

  const continued = await controller.continue("task-1", "Continue without native memory")
  await new Promise((resolve) => setImmediate(resolve))

  assert.equal(continued.status, "running")
  assert.equal(continued.run.sessionId, "replacement-session")
  assert.equal(continued.run.handoffFromRunId, "run-1")
  assert.match(promptSent, /transferred by TaskDesk/i)
  assert.match(promptSent, /Continue without native memory/)
})

test("raw ACP resume classifies a Session-not-found response before accepting the continuation", async () => {
  const host = {
    async start() {},
    async request(method) {
      if (method === "session/load") throw new Error("Internal error: Session old-session not found")
      throw new Error(`unexpected method ${method}`)
    }
  }
  const launcher = new TaskLauncher({ daemon: daemonFor(host) })

  await assert.rejects(
    () => launcher.resumeSession({
      id: "task-1",
      agentId: "codex",
      workspace: { mode: "project", path: "/repo" },
      run: { sequence: 2, agentId: "codex" }
    }, {
      id: "run-1",
      agentId: "codex",
      sessionId: "old-session",
      model: null
    }),
    (error) => error.code === "session_unavailable" && /can no longer be resumed/i.test(error.message)
  )
})
