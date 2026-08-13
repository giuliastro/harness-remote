import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createAgentRoutingServer } from "../src/agent-router.js"

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

class BridgeServer extends EventEmitter {}

function daemon() {
  return {
    registry: { host: () => ({ state: "available" }) },
    hostEntry: () => undefined
  }
}

test("worktree route prepares then persists the workspace on the task", async () => {
  const task = {
    id: "task-1",
    status: "draft",
    project: { name: "repo", path: "/repo", kind: "git" },
    workspace: { mode: "project", path: "/repo" }
  }
  const workspace = { mode: "worktree", path: "/state/worktrees/a", branch: "task/a", source: "/repo" }
  const calls = []
  const taskStore = {
    async get(id) { calls.push(["get", id]); return task },
    async setWorkspace(id, value) { calls.push(["set", id, value]); return { ...task, workspace: value } }
  }
  const worktreeManager = {
    async prepare(value) { calls.push(["prepare", value.id]); return workspace },
    async rollback() { calls.push(["rollback"]) }
  }
  const server = createAgentRoutingServer({
    daemon: daemon(),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    taskStore,
    projectCatalog: async () => [],
    worktreeManager
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/task-1/worktree`, { method: "POST" })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).workspace, workspace)
    assert.deepEqual(calls, [
      ["get", "task-1"],
      ["prepare", "task-1"],
      ["set", "task-1", workspace]
    ])
  } finally {
    await close(server)
  }
})

test("worktree route rolls back a fresh workspace when task persistence fails", async () => {
  const task = { id: "task-1", status: "draft", project: { path: "/repo", kind: "git" }, workspace: { mode: "project", path: "/repo" } }
  const workspace = { mode: "worktree", path: "/state/worktrees/a", branch: "task/a", source: "/repo" }
  let rolledBack
  const server = createAgentRoutingServer({
    daemon: daemon(),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    taskStore: {
      async get() { return task },
      async setWorkspace() { throw new Error("disk full") }
    },
    projectCatalog: async () => [],
    worktreeManager: {
      async prepare() { return workspace },
      async rollback(value) { rolledBack = value }
    }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/task-1/worktree`, { method: "POST" })
    assert.equal(response.status, 500)
    assert.equal((await response.json()).error, "disk full")
    assert.deepEqual(rolledBack, workspace)
  } finally {
    await close(server)
  }
})

test("unknown tasks do not create worktrees", async () => {
  let prepared = false
  const server = createAgentRoutingServer({
    daemon: daemon(),
    config: { username: "", password: "", corsOrigins: [] },
    primaryAgentID: "codex",
    bridgeServer: new BridgeServer(),
    taskStore: { async get() { return undefined } },
    projectCatalog: async () => [],
    worktreeManager: { async prepare() { prepared = true } }
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/missing/worktree`, { method: "POST" })
    assert.equal(response.status, 404)
    assert.equal(prepared, false)
  } finally {
    await close(server)
  }
})
