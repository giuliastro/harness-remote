import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
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
