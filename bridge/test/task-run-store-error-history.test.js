import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { TaskRunStore } from "../src/task-run-store.js"

function clock() {
  let tick = 0
  return () => new Date(Date.UTC(2026, 7, 22, 8, 0, tick++)).toISOString()
}

test("a failed Run keeps its own error after a later Run succeeds", async (t) => {
  const stateDirectory = await mkdtemp(path.join(tmpdir(), "taskdesk-run-error-"))
  t.after(() => rm(stateDirectory, { recursive: true, force: true }))

  const store = new TaskRunStore({
    machineID: "machine-test",
    stateDirectory,
    idFactory: () => "task-1",
    clock: clock()
  })
  const created = await store.create({
    project: { id: "project-1", name: "Project", path: stateDirectory, kind: "git" },
    agentId: "codex",
    prompt: "First request"
  })

  const first = { id: "run-1", sequence: 1, agentId: "codex", prompt: "First request", sessionId: "session-1" }
  await store.setRunState(created.id, { status: "starting", run: first })
  await store.setRunState(created.id, { status: "running", run: first })
  await store.setRunState(created.id, { status: "failed", run: first, error: new Error("Session session-1 not found") })

  const second = { id: "run-2", sequence: 2, agentId: "codex", prompt: "Continue", sessionId: "session-2" }
  await store.setRunState(created.id, { status: "starting", run: second })
  await store.setRunState(created.id, { status: "running", run: second })
  const finished = await store.setRunState(created.id, { status: "completed", run: second })

  assert.equal(finished.status, "completed")
  assert.equal(finished.error, null)
  assert.equal(finished.runs.length, 2)
  assert.deepEqual(finished.runs[0].error, { message: "Session session-1 not found" })
  assert.equal(finished.runs[0].status, "failed")
  assert.equal(finished.runs[1].error, undefined)
  assert.equal(finished.runs[1].status, "completed")
})
