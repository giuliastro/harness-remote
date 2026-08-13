import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
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
    const disk = JSON.parse(await readFile(first.file, "utf8"))
    assert.equal(disk.version, 1)
    assert.equal(disk.machineId, "machine-1")
    assert.deepEqual(disk.tasks, [created])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("different machine identities persist to different files", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-machine-"))
  try {
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const first = new TaskStore({ machineID: "machine-1", stateDirectory, idFactory: () => "task-1" })
    await first.create({ project, agentId: "codex", prompt: "Do work" })
    const other = new TaskStore({ machineID: "machine-2", stateDirectory, idFactory: () => "task-2" })
    assert.notEqual(first.file, other.file)
    assert.deepEqual(await other.list(), [])
    await other.create({ project: { ...project, id: "machine-2:project" }, agentId: "codex", prompt: "Other work" })
    assert.equal((await first.list()).length, 1)
    assert.equal((await other.list()).length, 1)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("a failed load is retryable and cannot be mistaken for an empty successful load", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-read-"))
  try {
    const store = new TaskStore({ machineID: "machine-1", stateDirectory, idFactory: () => "task-1" })
    await mkdir(store.file, { recursive: true })
    await assert.rejects(() => store.list())
    assert.equal(store.loaded, false)
    await rm(store.file, { recursive: true, force: true })
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const created = await store.create({ project, agentId: "codex", prompt: "Retry safely" })
    assert.equal(created.id, "task-1")
    assert.equal((await store.list()).length, 1)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("malformed task state is preserved before starting a fresh machine-scoped store", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-corrupt-"))
  try {
    const warnings = []
    const store = new TaskStore({ machineID: "machine-1", stateDirectory, warn: (message) => warnings.push(message) })
    await mkdir(stateDirectory, { recursive: true })
    await writeFile(store.file, "{not-json", "utf8")
    assert.deepEqual(await store.list(), [])
    const names = await readdir(stateDirectory)
    assert.equal(names.some((name) => name.startsWith(`${path.basename(store.file)}.corrupt-`)), true)
    assert.equal(warnings.length, 1)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
