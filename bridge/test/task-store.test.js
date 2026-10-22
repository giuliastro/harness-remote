import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { TaskRunStore } from "../src/task-run-store.js"

test("persists machine-scoped draft tasks with project, agent and workspace identity", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-store-"))
  try {
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const first = new TaskRunStore({
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
      model: null,
      status: "draft",
      workspace: { mode: "project", path: "/work/repo" },
      run: null,
      runs: [],
      error: null,
      finishedAt: null,
      createdAt: "2026-08-13T13:00:00.000Z",
      updatedAt: "2026-08-13T13:00:00.000Z",
      context: {
        version: 1,
        revision: 0,
        taskId: "task-1",
        objective: "Fix issue #145",
        currentState: "draft",
        latestOutcome: null,
        runSummaries: []
      }
    })

    const second = new TaskRunStore({ machineID: "machine-1", stateDirectory })
    assert.deepEqual(await second.list(), [created])
    const disk = JSON.parse(await readFile(first.file, "utf8"))
    assert.equal(disk.version, 1)
    assert.equal(disk.machineId, "machine-1")
    assert.deepEqual(disk.tasks, [created])
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("legacy single-run tasks load with a compatible runs history and Task Context", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-history-"))
  try {
    const store = new TaskRunStore({ machineID: "machine-1", stateDirectory })
    await mkdir(stateDirectory, { recursive: true })
    const legacyRun = { id: "run-1", sessionId: "session-1", startedAt: "2026-08-13T13:00:00.000Z" }
    await writeFile(store.file, JSON.stringify({
      version: 1,
      machineId: "machine-1",
      tasks: [{ id: "task-1", status: "completed", prompt: "Legacy task", agentId: "codex", run: legacyRun }]
    }), "utf8")
    const [loaded] = await store.list()
    assert.deepEqual(loaded.runs, [legacyRun])
    assert.deepEqual(loaded.run, legacyRun)
    assert.equal(loaded.finishedAt, null)
    assert.equal(loaded.context.version, 1)
    assert.equal(loaded.context.objective, "Legacy task")
    assert.equal(loaded.context.revision, 0)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("markFinished closes a terminal task without changing its workspace", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-finish-"))
  try {
    let now = "2026-08-13T13:00:00.000Z"
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const store = new TaskRunStore({ machineID: "machine-1", stateDirectory, idFactory: () => "task-1", clock: () => now })
    await store.create({ project, agentId: "codex", prompt: "Do work" })
    store.tasks[0] = {
      ...store.tasks[0],
      status: "completed",
      workspace: { mode: "worktree", path: "/state/worktrees/task-1", branch: "task/task-1", source: "/work/repo" }
    }
    await store.persist()
    now = "2026-08-13T14:00:00.000Z"
    const finished = await store.markFinished("task-1")
    assert.equal(finished.finishedAt, now)
    assert.equal(finished.workspace.mode, "worktree")
    assert.equal(finished.status, "completed")
    assert.equal(finished.updatedAt, now)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("markFinished refuses an active task", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-active-finish-"))
  try {
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const store = new TaskRunStore({ machineID: "machine-1", stateDirectory, idFactory: () => "task-1" })
    await store.create({ project, agentId: "codex", prompt: "Do work" })
    store.tasks[0] = { ...store.tasks[0], status: "running" }
    await assert.rejects(() => store.markFinished("task-1"), (error) => error.code === "task_active")
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("different machine identities persist to different files", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-machine-"))
  try {
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const first = new TaskRunStore({ machineID: "machine-1", stateDirectory, idFactory: () => "task-1" })
    await first.create({ project, agentId: "codex", prompt: "Do work" })
    const other = new TaskRunStore({ machineID: "machine-2", stateDirectory, idFactory: () => "task-2" })
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
    const store = new TaskRunStore({ machineID: "machine-1", stateDirectory, idFactory: () => "task-1" })
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
    const store = new TaskRunStore({ machineID: "machine-1", stateDirectory, warn: (message) => warnings.push(message) })
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

test("setWorkspace fails loudly if the task disappeared before persistence", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-missing-"))
  try {
    const store = new TaskRunStore({ machineID: "machine-1", stateDirectory })
    await assert.rejects(
      () => store.setWorkspace("missing", { mode: "worktree", path: "/tmp/worktree" }),
      /Unknown task: missing/
    )
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})

test("setRunState transitions active task to cancelled terminal state with finishedAt and revision increment", async () => {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "harness-task-cancel-"))
  try {
    const project = { id: "machine-1:project", name: "repo", path: "/work/repo", kind: "git" }
    const store = new TaskRunStore({
      machineID: "machine-1",
      stateDirectory,
      idFactory: () => "task-1",
      clock: () => "2026-08-13T14:00:00.000Z"
    })
    await store.create({ project, agentId: "codex", prompt: "Work to cancel" })
    const starting = await store.setRunState("task-1", {
      status: "starting",
      run: { id: "run-1", agentId: "codex", startedAt: "2026-08-13T14:00:00.000Z" }
    })
    const running = await store.setRunState("task-1", {
      status: "running",
      run: { ...starting.run, sessionId: "sess-1" }
    })
    assert.equal(running.status, "running")
    assert.equal(running.context.revision, 0)

    const cancelled = await store.setRunState("task-1", {
      status: "cancelled",
      run: running.run,
      expectedRunId: "run-1"
    })
    assert.equal(cancelled.status, "cancelled")
    assert.equal(cancelled.run.status, "cancelled")
    assert.equal(cancelled.run.finishedAt, "2026-08-13T14:00:00.000Z")
    assert.equal(cancelled.runs[0].status, "cancelled")
    assert.equal(cancelled.runs[0].finishedAt, "2026-08-13T14:00:00.000Z")
    assert.equal(cancelled.context.revision, 1)
  } finally {
    await rm(stateDirectory, { recursive: true, force: true })
  }
})
