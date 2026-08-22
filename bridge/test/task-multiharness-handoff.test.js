import assert from "node:assert/strict"
import test from "node:test"
import { TaskRunController } from "../src/task-run-controller.js"
import { taskLaunchError } from "../src/task-errors.js"

function completedChain() {
  const runs = [
    {
      id: "run-1",
      sequence: 1,
      agentId: "codex",
      model: { providerID: "openai", modelID: "gpt-codex" },
      role: "implement",
      sessionId: "codex-session-a",
      transport: "acp",
      directory: "/repo",
      prompt: "Implement OAuth login",
      outcome: "Implemented the OAuth callback and token storage.",
      status: "completed",
      finishedAt: "2026-08-20T08:01:00.000Z"
    },
    {
      id: "run-2",
      sequence: 2,
      agentId: "claude",
      model: { providerID: "anthropic", modelID: "claude-test" },
      role: "review",
      sessionId: "claude-session-b",
      transport: "acp",
      directory: "/repo",
      prompt: "Review it",
      outcome: "Review found an unsafe refresh-token rotation path.",
      status: "completed",
      finishedAt: "2026-08-20T08:02:00.000Z"
    },
    {
      id: "run-3",
      sequence: 3,
      agentId: "pi",
      role: "test",
      sessionId: "pi-session-c",
      transport: "acp",
      directory: "/repo",
      prompt: "Verify the review findings",
      outcome: "One refresh-token regression test is failing.",
      status: "completed",
      finishedAt: "2026-08-20T08:03:00.000Z"
    }
  ]
  return {
    id: "task-1",
    machineId: "machine-1",
    projectId: "project-1",
    project: { id: "project-1", name: "repo", kind: "git", path: "/repo" },
    agentId: "codex",
    prompt: "Implement OAuth login",
    model: { providerID: "openai", modelID: "gpt-codex" },
    status: "completed",
    workspace: { mode: "project", path: "/repo" },
    run: runs[2],
    runs,
    error: null
  }
}

function inMemoryStore(initial) {
  let current = structuredClone(initial)
  return {
    get current() { return current },
    async get() { return structuredClone(current) },
    async setRunState(_taskID, update) {
      const nextRun = structuredClone(update.run ?? current.run)
      const runs = current.runs.map((run) => structuredClone(run))
      if (nextRun?.id) {
        const index = runs.findIndex((run) => run.id === nextRun.id)
        if (index >= 0) runs[index] = nextRun
        else runs.push(nextRun)
      }
      current = { ...current, status: update.status, run: nextRun, runs, error: update.error ?? null }
      return structuredClone(current)
    }
  }
}

test("returning to a harness reuses its previous Session and transfers intervening findings", async () => {
  const store = inMemoryStore(completedChain())
  let resumeSource = null
  let effectivePrompt = null
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: {
      async resumeSession(task, previousRun) {
        resumeSource = structuredClone(previousRun)
        effectivePrompt = task.prompt
        return { sessionId: previousRun.sessionId, transport: "acp", directory: task.workspace.path }
      },
      async createSession() { throw new Error("Codex already has a resumable Task Session") },
      async startPrompt(task) { effectivePrompt = task.prompt }
    },
    runIDFactory: () => "run-4",
    clock: () => "2026-08-20T08:04:00.000Z"
  })

  const continued = await controller.continue("task-1", {
    prompt: "Fix the review and test findings",
    agentId: "codex",
    role: "fix"
  })

  assert.equal(resumeSource.id, "run-1")
  assert.equal(resumeSource.sessionId, "codex-session-a")
  assert.equal(continued.run.id, "run-4")
  assert.equal(continued.run.sequence, 4)
  assert.equal(continued.run.sessionId, "codex-session-a")
  assert.equal(continued.run.resumedFromRunId, "run-1")
  assert.equal(continued.run.handoffFromRunId, "run-3")
  assert.deepEqual(continued.run.model, { providerID: "openai", modelID: "gpt-codex" })
  assert.match(effectivePrompt, /Review found an unsafe refresh-token rotation path/)
  assert.match(effectivePrompt, /One refresh-token regression test is failing/)
  assert.match(effectivePrompt, /USER INSTRUCTION\nFix the review and test findings/)
})

test("implicit continuation falls back to a fresh Session when a persisted native Session disappeared", async () => {
  const store = inMemoryStore(completedChain())
  let created = 0
  let effectivePrompt = null
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: {
      async resumeSession(_task, previousRun) {
        assert.equal(previousRun.id, "run-1")
        throw taskLaunchError("session_unavailable", "Session codex-session-a not found")
      },
      async createSession(task) {
        created += 1
        effectivePrompt = task.prompt
        return { sessionId: "codex-session-new", transport: "acp", directory: task.workspace.path }
      },
      async startPrompt(task) { effectivePrompt = task.prompt }
    },
    runIDFactory: () => "run-4",
    clock: () => "2026-08-20T08:04:00.000Z"
  })

  const continued = await controller.continue("task-1", {
    prompt: "Fix everything and continue",
    agentId: "codex"
  })

  assert.equal(created, 1)
  assert.equal(continued.run.sessionId, "codex-session-new")
  assert.equal(continued.run.resumedFromRunId, undefined)
  assert.equal(continued.run.handoffFromRunId, "run-3")
  assert.equal(continued.run.handoffReason, "session_unavailable")
  assert.match(effectivePrompt, /Review found an unsafe refresh-token rotation path/)
  assert.match(effectivePrompt, /One refresh-token regression test is failing/)
  assert.match(effectivePrompt, /USER INSTRUCTION\nFix everything and continue/)
})

test("explicit Advanced resume remains strict when the requested native Session disappeared", async () => {
  const store = inMemoryStore(completedChain())
  let created = 0
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: {
      async resumeSession() { throw taskLaunchError("session_unavailable", "Session not found") },
      async createSession() { created += 1; return { sessionId: "should-not-exist", transport: "acp", directory: "/repo" } },
      async startPrompt() {}
    },
    runIDFactory: () => "run-4"
  })

  await assert.rejects(() => controller.continue("task-1", {
    prompt: "Resume exactly that Codex session",
    agentId: "codex",
    mode: "resume"
  }), /Session not found/)
  assert.equal(created, 0)
})

test("a completed Run persists a bounded harness outcome for the next handoff", async () => {
  const initial = {
    ...completedChain(),
    status: "draft",
    run: null,
    runs: [],
    prompt: "Inspect the repository"
  }
  const store = inMemoryStore(initial)
  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: {
      async createSession() { return { sessionId: "codex-new", transport: "acp", directory: "/repo" } },
      async startPrompt(_task, _session, callbacks) {
        callbacks.onCompleted({ outcome: "Architecture review complete. The auth boundary needs refactoring." })
      }
    },
    runIDFactory: () => "run-outcome"
  })

  const launched = await controller.launch("task-1")
  assert.equal(launched.status, "running")
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(store.current.status, "completed")
  assert.equal(store.current.run.outcome, "Architecture review complete. The auth boundary needs refactoring.")
})
