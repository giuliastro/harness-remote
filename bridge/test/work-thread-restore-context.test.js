import assert from "node:assert/strict"
import test from "node:test"
import { TaskRunController } from "../src/task-run-controller.js"

test("same-harness continuation after Restore reuses native Session but explicitly realigns workspace context", async () => {
  let current = {
    id: "task-restore",
    status: "completed",
    agentId: "codex",
    prompt: "Implement the feature",
    project: { kind: "git", path: "/repo" },
    workspace: { mode: "worktree", path: "/state/worktrees/task-restore" },
    context: { revision: 4 },
    restoredCheckpointId: "checkpoint-before-refactor",
    restoredAt: "2026-08-21T12:00:00.000Z",
    run: {
      id: "run-4",
      sequence: 4,
      agentId: "codex",
      sessionId: "codex-session",
      transport: "acp",
      directory: "/state/worktrees/task-restore",
      prompt: "Refactor the parser",
      status: "completed",
      startedAt: "2026-08-21T11:00:00.000Z",
      finishedAt: "2026-08-21T11:30:00.000Z"
    },
    runs: [{
      id: "run-4",
      sequence: 4,
      agentId: "codex",
      sessionId: "codex-session",
      transport: "acp",
      directory: "/state/worktrees/task-restore",
      prompt: "Refactor the parser",
      status: "completed",
      startedAt: "2026-08-21T11:00:00.000Z",
      finishedAt: "2026-08-21T11:30:00.000Z"
    }]
  }

  let resumedSession = null
  let effectivePrompt = null
  const store = {
    async list() { return [] },
    async get() { return structuredClone(current) },
    async setRunState(_id, update) {
      current = { ...current, status: update.status, run: structuredClone(update.run), error: update.error ?? null }
      return structuredClone(current)
    }
  }

  const controller = new TaskRunController({
    taskStore: store,
    taskLauncher: {
      async validateModelSelection() {},
      async resumeSession(task, previousRun) {
        resumedSession = previousRun.sessionId
        return { sessionId: previousRun.sessionId, transport: "acp", directory: task.workspace.path }
      },
      async createSession() { throw new Error("Restore should not force a fresh native Session") },
      async startPrompt(task) { effectivePrompt = task.prompt }
    },
    worktreeManager: {
      async inspect() {
        return { managed: true, dirty: true, changeCount: 1, changedFiles: ["src/parser.ts"] }
      }
    },
    runIDFactory: () => "run-5",
    clock: () => "2026-08-21T12:05:00.000Z"
  })

  const result = await controller.continue("task-restore", "Continue from the restored implementation")

  assert.equal(resumedSession, "codex-session")
  assert.equal(result.run.sessionId, "codex-session")
  assert.equal(result.run.resumedFromRunId, "run-4")
  assert.equal(result.run.handoffFromRunId, "run-4")
  assert.equal(result.run.handoffReason, "workspace_restore")
  assert.equal(result.run.workspaceRestoredAt, "2026-08-21T12:00:00.000Z")
  assert.match(effectivePrompt, /WORKSPACE RESTORE/)
  assert.match(effectivePrompt, /checkpoint checkpoint-before-refactor/)
  assert.match(effectivePrompt, /current files are authoritative/i)
  assert.match(effectivePrompt, /USER INSTRUCTION\nContinue from the restored implementation/)
})
