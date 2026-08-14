import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import test from "node:test"
import { createTaskFinishServer } from "../src/task-finish-server.js"
import { inspectTaskDiff, parseNumstat } from "../src/task-review.js"

const workspace = { mode: "worktree", path: "/state/worktrees/t", branch: "task/t", source: "/repo" }

function manager() {
  return {
    async inspect() { return { managed: true, dirty: true, changeCount: 3 } },
    async runGit(args) {
      if (args.includes("rev-parse")) return { stdout: "source-head\n" }
      if (args.includes("--numstat")) return { stdout: "4\t1\tsrc/a.js\n-\t-\tassets/logo.png\n" }
      if (args.includes("--others")) return { stdout: "notes.txt\n" }
      throw new Error(`Unexpected git args: ${args.join(" ")}`)
    }
  }
}

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

test("numstat parser preserves binary files with unknown line counts", () => {
  assert.deepEqual(parseNumstat("4\t1\tsrc/a.js\n-\t-\tassets/logo.png\n"), [
    { path: "src/a.js", additions: 4, deletions: 1, untracked: false },
    { path: "assets/logo.png", additions: null, deletions: null, untracked: false }
  ])
})

test("review inspection combines committed/tracked changes with untracked files without mutation", async () => {
  const calls = []
  const worktreeManager = manager()
  const runGit = worktreeManager.runGit
  worktreeManager.runGit = async (args) => {
    calls.push(args)
    return runGit(args)
  }
  const result = await inspectTaskDiff(workspace, worktreeManager)
  assert.equal(result.sourceHead, "source-head")
  assert.equal(result.fileCount, 3)
  assert.equal(result.additions, 4)
  assert.equal(result.deletions, 1)
  assert.equal(result.hasUnknownLineCounts, true)
  assert.deepEqual(result.files.map((file) => file.path), ["assets/logo.png", "notes.txt", "src/a.js"])
  assert.equal(result.files.find((file) => file.path === "notes.txt").untracked, true)
  assert.ok(calls.every((args) => !args.includes("add") && !args.includes("commit") && !args.includes("checkout")))
})

test("diff route returns a no-op review result for project workspaces", async () => {
  const innerServer = new EventEmitter()
  const server = createTaskFinishServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    taskStore: {
      async get() {
        return { id: "t", status: "completed", project: { path: "/repo" }, workspace: { mode: "project", path: "/repo" } }
      }
    },
    worktreeManager: manager()
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/t/diff`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.managed, false)
    assert.equal(body.fileCount, 0)
    assert.deepEqual(body.files, [])
  } finally {
    await close(server)
  }
})

test("diff route remains available as a point-in-time view for active worktree tasks", async () => {
  const innerServer = new EventEmitter()
  const server = createTaskFinishServer({
    innerServer,
    config: { username: "", password: "", corsOrigins: [] },
    taskStore: { async get() { return { id: "t", status: "running", workspace } } },
    worktreeManager: manager()
  })
  const port = await listen(server)
  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/tasks/t/diff`)
    assert.equal(response.status, 200)
    assert.equal((await response.json()).fileCount, 3)
  } finally {
    await close(server)
  }
})
