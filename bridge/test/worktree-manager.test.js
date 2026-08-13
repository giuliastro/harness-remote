import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { WorktreeManager } from "../src/worktree-manager.js"

function draft(overrides = {}) {
  return {
    id: "task-123",
    status: "draft",
    project: { kind: "git", path: "/repo" },
    workspace: { mode: "project", path: "/repo" },
    ...overrides
  }
}

test("prepares a deterministic isolated worktree without mutating the primary checkout", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-worktree-"))
  const calls = []
  try {
    const manager = new WorktreeManager({ stateDirectory, runGit: async (args) => { calls.push(args); return { stdout: "/repo\n" } } })
    const workspace = await manager.prepare(draft())
    assert.equal(workspace.mode, "worktree")
    assert.equal(workspace.source, "/repo")
    assert.equal(workspace.path.startsWith(path.join(stateDirectory, "worktrees")), true)
    assert.match(workspace.branch, /^task\/[0-9a-f]{12}$/)
    assert.deepEqual(calls[0], ["-C", "/repo", "rev-parse", "--show-toplevel"])
    assert.deepEqual(calls[1], ["-C", "/repo", "worktree", "add", "-B", workspace.branch, workspace.path, "HEAD"])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("rejects non-Git tasks before invoking Git", async () => {
  let calls = 0
  const manager = new WorktreeManager({ stateDirectory: "/state", runGit: async () => { calls += 1 } })
  await assert.rejects(() => manager.prepare(draft({ project: { kind: "directory", path: "/repo" } })), /requires a Git project/)
  assert.equal(calls, 0)
})

test("an already prepared worktree is idempotent", async () => {
  const workspace = { mode: "worktree", path: "/state/worktrees/a", branch: "task/a", source: "/repo" }
  const manager = new WorktreeManager({ stateDirectory: "/state", runGit: async () => { throw new Error("should not run") } })
  assert.deepEqual(await manager.prepare(draft({ workspace })), workspace)
})

test("rollback removes only a just-prepared worktree and its branch", async () => {
  const calls = []
  const manager = new WorktreeManager({ stateDirectory: "/state", runGit: async (args) => { calls.push(args) } })
  await manager.rollback({ mode: "worktree", path: "/state/worktrees/a", branch: "task/a", source: "/repo" })
  assert.deepEqual(calls, [
    ["-C", "/repo", "worktree", "remove", "--force", "/state/worktrees/a"],
    ["-C", "/repo", "branch", "-D", "task/a"]
  ])
})

test("prepare uses a resettable task branch so rollback leftovers do not wedge retries", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-worktree-retry-"))
  const calls = []
  try {
    const manager = new WorktreeManager({ stateDirectory, runGit: async (args) => { calls.push(args); return { stdout: "/repo\n" } } })
    await manager.prepare(draft())
    assert.equal(calls[1].includes("-B"), true)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("inspect reports dirty work without changing it", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-worktree-inspect-"))
  const worktreePath = path.join(stateDirectory, "worktrees", "abc")
  try {
    await mkdir(worktreePath, { recursive: true })
    const calls = []
    const manager = new WorktreeManager({ stateDirectory, runGit: async (args) => { calls.push(args); return { stdout: " M src/a.js\n?? new.txt\n" } } })
    assert.deepEqual(await manager.inspect({ mode: "worktree", path: worktreePath, branch: "task/abc", source: "/repo" }), {
      managed: true,
      dirty: true,
      changeCount: 2
    })
    assert.deepEqual(calls, [["-C", worktreePath, "status", "--porcelain=v1", "--untracked-files=all"]])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("cleanup refuses dirty worktrees before removal", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-worktree-dirty-"))
  const worktreePath = path.join(stateDirectory, "worktrees", "abc")
  try {
    await mkdir(worktreePath, { recursive: true })
    const calls = []
    const manager = new WorktreeManager({ stateDirectory, runGit: async (args) => { calls.push(args); return { stdout: " M src/a.js\n" } } })
    await assert.rejects(
      () => manager.cleanup({ mode: "worktree", path: worktreePath, branch: "task/abc", source: "/repo" }),
      (error) => error.code === "worktree_dirty"
    )
    assert.equal(calls.length, 1)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("cleanup removes a clean worktree without force and preserves an unmerged branch", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-worktree-clean-"))
  const worktreePath = path.join(stateDirectory, "worktrees", "abc")
  try {
    await mkdir(worktreePath, { recursive: true })
    const calls = []
    const manager = new WorktreeManager({ stateDirectory, runGit: async (args) => {
      calls.push(args)
      if (args.includes("status")) return { stdout: "" }
      if (args.includes("branch")) throw new Error("not fully merged")
      return { stdout: "" }
    } })
    const result = await manager.cleanup({ mode: "worktree", path: worktreePath, branch: "task/abc", source: "/repo" })
    assert.deepEqual(result, { removed: true, branchDeleted: false })
    assert.deepEqual(calls[1], ["-C", "/repo", "worktree", "remove", worktreePath])
    assert.deepEqual(calls[2], ["-C", "/repo", "branch", "-d", "task/abc"])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("inspect rejects a workspace outside the daemon state directory", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-worktree-boundary-"))
  try {
    const manager = new WorktreeManager({ stateDirectory, runGit: async () => { throw new Error("should not run") } })
    await assert.rejects(
      () => manager.inspect({ mode: "worktree", path: path.join(stateDirectory, "outside"), branch: "task/a", source: "/repo" }),
      (error) => error.code === "worktree_outside_state"
    )
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
