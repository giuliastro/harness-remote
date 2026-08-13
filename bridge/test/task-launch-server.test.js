import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createTaskLaunchServer, launchStatus } from "../src/task-launch-server.js"

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return server.address().port
}

async function close(server) {
  await new Promise((resolve) => server.close(resolve))
}

test("POST launch returns the persisted running task", async () => {
  const innerServer = new EventEmitter()
  const server = createTaskLaunchServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    taskRunController: { async launch(id) { return { id, status: "running", run: { sessionId: "session-1" } } } }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/task-1/launch`, { method: "POST" })
    assert.equal(response.status, 200)
    assert.equal((await response.json()).run.sessionId, "session-1")
  } finally {
    await close(server)
  }
})

test("launch maps coded missing tasks to 404 and delegates unrelated routes", async () => {
  const innerServer = new EventEmitter()
  let delegated = false
  innerServer.on("request", (_request, response) => {
    delegated = true
    response.writeHead(204)
    response.end()
  })
  const server = createTaskLaunchServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    taskRunController: { async launch(id) { const error = new Error(`Unknown task: ${id}`); error.code = "unknown_task"; throw error } }
  })
  const port = await listen(server)
  try {
    const missing = await fetch(`http://127.0.0.1:${port}/v1/tasks/missing/launch`, { method: "POST" })
    assert.equal(missing.status, 404)
    const delegatedResponse = await fetch(`http://127.0.0.1:${port}/v1/tasks`)
    assert.equal(delegatedResponse.status, 204)
    assert.equal(delegated, true)
  } finally {
    await close(server)
  }
})

test("launch status ignores prose when no structured code is present", () => {
  assert.equal(launchStatus(new Error("unknown task worktree unavailable")), 500)
})
