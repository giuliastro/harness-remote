import assert from "node:assert/strict"
import test from "node:test"
import { launchStatus } from "../src/task-launch-server.js"
import { TaskRunController } from "../src/task-run-controller.js"

function completedTask() {
  const run = {
    id: "run-1",
    sequence: 1,
    agentId: "codex",
    model: { providerID: "openai", modelID: "gpt-old" },
    sessionId: "codex-1",
    transport: "acp",
    status: "completed",
    prompt: "Implement it",
    finishedAt: "2026-08-20T09:00:00.000Z"
  }
  return {
    id: "task-1",
    status: "completed",
    agentId: "codex",
    model: run.model,
    prompt: "Implement it",
    project: { kind: "git", path: "/repo" },
    workspace: { mode: "project", path: "/repo" },
    run,
    runs: [run],
    context: { version: 1, revision: 1 }
  }
}

test("Continue persists an acceptance Run before model validation and fails that same Run when the model disappeared", async () => {
  let task = completedTask()
  const writes = []
  let createCalls = 0
  let promptCalls = 0
  const error = new Error("Selected model is no longer available: anthropic/removed")
  error.code = "model_unavailable"
  const controller = new TaskRunController({
    runIDFactory: () => "run-2",
    taskStore: {
      async list() { return [] },
      async get() { return structuredClone(task) },
      async setRunState(_taskID, update) {
        writes.push(structuredClone({ status: update.status, run: update.run, expectedRunId: update.expectedRunId, error: update.error?.message }))
        const nextRun = { ...(update.run ?? task.run), status: update.status }
        if (update.error) nextRun.error = { message: update.error.message }
        task = { ...task, status: update.status, run: nextRun }
        return structuredClone(task)
      }
    },
    taskLauncher: {
      async validateModelSelection(agentID, model) {
        assert.equal(agentID, "claude")
        assert.deepEqual(model, { providerID: "anthropic", modelID: "removed" })
        throw error
      },
      async createSession() { createCalls += 1; throw new Error("must not create a Session") },
      async startPrompt() { promptCalls += 1; throw new Error("must not prompt") }
    }
  })

  await assert.rejects(
    () => controller.continue("task-1", {
      prompt: "Review the implementation",
      agentId: "claude",
      model: { providerID: "anthropic", modelID: "removed" },
      role: "review"
    }),
    (failure) => failure.code === "model_unavailable"
  )

  assert.equal(writes.length, 2)
  assert.equal(writes[0].status, "starting")
  assert.equal(writes[0].run.id, "run-2")
  assert.equal(writes[0].run.agentId, "claude")
  assert.deepEqual(writes[0].run.model, { providerID: "anthropic", modelID: "removed" })
  assert.equal(writes[0].run.sessionId, null)
  assert.equal(writes[1].status, "failed")
  assert.equal(writes[1].run.id, "run-2")
  assert.equal(writes[1].expectedRunId, "run-2")
  assert.match(writes[1].error, /no longer available/)
  assert.equal(createCalls, 0)
  assert.equal(promptCalls, 0)
})

test("model_unavailable is a stable handoff conflict instead of a generic server error", () => {
  const error = new Error("model unavailable")
  error.code = "model_unavailable"
  assert.equal(launchStatus(error), 409)
})
