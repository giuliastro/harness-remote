import assert from "node:assert/strict"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { TaskStore } from "../src/task-store.js"

test("persists machine-scoped draft tasks with project, agent and workspace identity", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-store-"))
  try {
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const first = new TaskStore({
      machineID: "machine-1",
      stateDirectory,
      idFactory: () => "task-1",
      clock: () => "2026-08-13T13:00:00.000Z"
    })
    const created = await first.create({ project, agentId: "codex", prompt: "Fix issue #145" })
    assert.deepEqual(created, {
      id: "task-1",
      machineId: "machine-1",
      projectId: "machine-1:project",
      project: { name: "repo", path: "/work/repo", kind: "git" },
      agentId: "codex",
      prompt: "Fix issue #145",
      status: "draft",
      workspace: { mode: "project", path: "/work/repo" },
      run: null,
      createdAt: "2026-08-13T13:00:00.000Z",
      updatedAt: "2026-08-13T13:00:00.000Z"
    })

    const second = new TaskStore({ machineID: "machine-1", stateDirectory })
    assert.deepEqual(await second.list(), [created])
    const disk = JSON.parse(await readFile(path.join(stateDirectory, "tasks.json"), "utf8"))
    assert.equal(disk.version, 1)
    assert.deepEqual(disk.tasks, [created])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("does not load tasks belonging to another machine identity", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-machine-"))
  try {
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const first = new TaskStore({ machineID: "machine-1", stateDirectory, idFactory: () => "task-1" })
    await first.create({ project, agentId: "codex", prompt: "Do work" })
    const other = new TaskStore({ machineID: "machine-2", stateDirectory })
    assert.deepEqual(await other.list(), [])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
