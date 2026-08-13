import assert from "node:assert/strict"
import test from "node:test"
import { TaskRunController } from "../src/task-run-controller.js"

test("reconciles confirmed completion", async () => {
  const task = { id: "t", status: "running", run: { id: "r", sessionId: "s" } }
  const store = { async list() { return [task] }, async setRunState(_id, update) { task.status = update.status; return task } }
  const controller = new TaskRunController({ taskStore: store, taskLauncher: { async inspectRun() { return "completed" } } })
  await controller.reconciliation
  assert.equal(task.status, "completed")
})
