import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createTaskFinishServer } from "../src/task-finish-server.js"
import { inspectTaskWork } from "../src/task-finish.js"

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

const workspace = { mode: "worktree", path: "/state/worktrees/t", branch: "task/t", source: "/repo" }

function manager({ dirty = false, branchMissing = false } = {}) {
  return {
    async inspect() { return { managed: true, dirty, changeCount: dirty ? 1 : 0 } },
    async runGit(args) {
      if (args.includes("rev-list")) return { stdout: "2\t3\n" }
      if (args.at(-1) === workspace.branch) {
        if (branchMissing) throw new Error("branch missing")
        return { stdout: "branch-head\n" }
      }
      if (args.at(-1) === "HEAD" && args[1] === workspace.path) return { stdout: "branch-head\n" }
      if (args.at(-1) === "HEAD") return { stdout: "source-head\n" }
      return { stdout: "branch-head\n" }
    },
    async cleanup() { return { removed: true, branchDeleted: false } }
  }
}

test("result inspection reports branch divergence without mutating work", async () => {
  const result = await inspectTaskWork(workspace, manager())
  assert.equal(result.commitsBehind, 2)
  assert.equal(result.commitsAhead, 3)
  assert.equal(result.mergedIntoSource, false)
  assert.equal(result.branchMissing, false)
  assert.equal(result.sourceHead, "source-head")
  assert.equal(result.branchHead, "branch-head")
})

test("result inspection falls back to the worktree head when the branch ref is missing", async () => {
  const result = await inspectTaskWork(workspace, manager({ branchMissing: true }))
  assert.equal(result.branchMissing, true)
  assert.equal(result.branchHead, "branch-head")
  assert.equal(result.commitsAhead, 3)
  assert.equal(result.mergedIntoSource, false)
})

test("finish releases an inactive clean worktree and preserves its result", async () => {
  const innerServer = new EventEmitter()
  let cleared = false
  const task = { id: "t", status: "completed", workspace, project: { path: "/repo" } }
  const server = createTaskFinishServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    taskStore: {
      async get() { return task },
      async clearWorkspace() { cleared = true; return { ...task, workspace: { mode: "project", path: "/repo" } } }
    },
    worktreeManager: manager()
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/t/finish`, { method: "POST" })
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.result.commitsAhead, 3)
    assert.equal(body.cleanup.branchDeleted, false)
    assert.equal(body.task.workspace.mode, "project")
    assert.equal(cleared, true)
  } finally {
    await close(server)
  }
})

test("finish waits for restart reconciliation before deciding whether a task is active", async () => {
  const innerServer = new EventEmitter()
  const task = { id: "t", status: "running", workspace, project: { path: "/repo" } }
  const taskRunController = {
    reconciliationError: null,
    reconciliation: Promise.resolve().then(() => { task.status = "failed" })
  }
  const server = createTaskFinishServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    taskStore: {
      async get() { return task },
      async clearWorkspace() { return { ...task, workspace: { mode: "project", path: "/repo" } } }
    },
    worktreeManager: manager(),
    taskRunController
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/t/finish`, { method: "POST" })
    assert.equal(response.status, 200)
  } finally {
    await close(server)
  }
})

test("finish refuses an active task before touching Git", async () => {
  const innerServer = new EventEmitter()
  let inspected = false
  const worktreeManager = manager()
  worktreeManager.inspect = async () => { inspected = true; return { managed: true, dirty: false, changeCount: 0 } }
  const server = createTaskFinishServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    taskStore: { async get() { return { id: "t", status: "running", workspace } } },
    worktreeManager
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/t/finish`, { method: "POST" })
    assert.equal(response.status, 409)
    assert.equal((await response.json()).code, "task_active")
    assert.equal(inspected, false)
  } finally {
    await close(server)
  }
})
