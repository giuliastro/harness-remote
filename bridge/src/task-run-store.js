import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { JsonFileStore } from "./json-file-store.js"
import { buildPersistedTaskContext } from "./task-context.js"

function machineFileName(machineID) {
  const digest = createHash("sha256").update(machineID).digest("hex").slice(0, 16)
  return `tasks-${digest}.json`
}

function taskError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizeTaskHistory(task) {
  if (!task || typeof task !== "object") return task
  const runs = Array.isArray(task.runs)
    ? task.runs
    : task.run
      ? [task.run]
      : []
  const normalized = { ...task, runs, finishedAt: task.finishedAt ?? null }
  const revision = Number.isFinite(Number(task.context?.revision))
    ? Number(task.context.revision)
    : runs.filter((run) => run?.finishedAt).length
  return { ...normalized, context: buildPersistedTaskContext(normalized, revision) }
}

function updateRunHistory(task, run) {
  const runs = Array.isArray(task.runs) ? task.runs.map((entry) => structuredClone(entry)) : []
  if (!run?.id) return runs
  const index = runs.findIndex((entry) => entry?.id === run.id)
  if (index >= 0) runs[index] = structuredClone(run)
  else runs.push(structuredClone(run))
  return runs
}

function persistedError(error) {
  return error ? { message: error instanceof Error ? error.message : String(error) } : null
}

export class TaskRunStore {
  #store

  constructor({ machineID, stateDirectory, idFactory = randomUUID, clock = () => new Date().toISOString(), warn = (message) => process.stderr.write(`${message}\n`) }) {
    this.machineID = machineID
    this.stateDirectory = stateDirectory
    this.file = path.join(stateDirectory, machineFileName(machineID))
    this.idFactory = idFactory
    this.clock = clock
    this.warn = warn
    this.loaded = false
    this.tasks = []
    this.#store = new JsonFileStore({
      filePath: this.file,
      stateDirectory,
      warn: (_message, backup) => this.warn(`Task state was malformed and has been preserved at ${backup}`)
    })
  }

  async load() {
    if (this.loaded) return
    const parsed = await this.#store.read()
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : []
    this.tasks = tasks.map(normalizeTaskHistory)
    this.loaded = true
  }

  async persist() {
    if (!this.loaded) throw new Error("Task store must load successfully before it can persist")
    await this.#store.write({
      version: 1,
      machineId: this.machineID,
      tasks: this.tasks
    }, { pretty: true })
  }

  async list() {
    await this.load()
    return this.tasks.map((task) => structuredClone(task))
  }

  async get(taskID) {
    await this.load()
    const task = this.tasks.find((candidate) => candidate.id === taskID)
    return task ? structuredClone(task) : undefined
  }

  async create({ project, agentId, prompt, model = null }) {
    await this.load()
    const text = typeof prompt === "string" ? prompt.trim() : ""
    if (!text) throw new Error("A task prompt is required")
    const timestamp = this.clock()
    const task = {
      id: this.idFactory(),
      machineId: this.machineID,
      projectId: project.id,
      project: { name: project.name, path: project.path, kind: project.kind },
      agentId,
      prompt: text,
      model,
      status: "draft",
      workspace: { mode: "project", path: project.path },
      run: null,
      runs: [],
      error: null,
      finishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    task.context = buildPersistedTaskContext(task, 0)
    this.tasks.push(task)
    await this.persist()
    return structuredClone(task)
  }

  async setWorkspace(taskID, workspace) {
    await this.load()
    const index = this.tasks.findIndex((task) => task.id === taskID)
    if (index < 0) throw taskError("unknown_task", `Unknown task: ${taskID}`)
    const task = this.tasks[index]
    if (task.status !== "draft") throw taskError("invalid_state", "Only draft tasks can change workspace")
    const updated = { ...task, workspace: structuredClone(workspace), updatedAt: this.clock() }
    this.tasks[index] = updated
    await this.persist()
    return structuredClone(updated)
  }

  async markFinished(taskID) {
    await this.load()
    const index = this.tasks.findIndex((task) => task.id === taskID)
    if (index < 0) throw taskError("unknown_task", `Unknown task: ${taskID}`)
    const task = this.tasks[index]
    if (task.status === "starting" || task.status === "running") {
      throw taskError("task_active", "An active task cannot be finished")
    }
    if (task.finishedAt) return structuredClone(task)
    const timestamp = this.clock()
    const updated = { ...task, finishedAt: timestamp, updatedAt: timestamp }
    updated.context = buildPersistedTaskContext(updated, task.context?.revision ?? 0)
    this.tasks[index] = updated
    await this.persist()
    return structuredClone(updated)
  }

  async clearWorkspace(taskID) {
    await this.load()
    const index = this.tasks.findIndex((task) => task.id === taskID)
    if (index < 0) throw taskError("unknown_task", `Unknown task: ${taskID}`)
    const task = this.tasks[index]
    if (task.status === "starting" || task.status === "running") {
      throw taskError("task_active", "An active task cannot release its workspace")
    }
    if (task.workspace?.mode !== "worktree") return structuredClone(task)
    const updated = {
      ...task,
      workspace: { mode: "project", path: task.project.path },
      updatedAt: this.clock()
    }
    updated.context = buildPersistedTaskContext(updated, task.context?.revision ?? 0)
    this.tasks[index] = updated
    await this.persist()
    return structuredClone(updated)
  }

  async setRunState(taskID, { status, run, error = null, expectedRunId }) {
    await this.load()
    const index = this.tasks.findIndex((task) => task.id === taskID)
    if (index < 0) throw new Error(`Unknown task: ${taskID}`)
    const task = this.tasks[index]

    // A mobile retry can arrive after the first HTTP response was lost. Once a client request id has
    // been persisted on any Run, starting that same mutation again is a replay, not a new prompt.
    if (status === "starting" && run?.clientRequestId) {
      const accepted = (Array.isArray(task.runs) ? task.runs : []).find((entry) => entry?.clientRequestId === run.clientRequestId)
      if (accepted) return structuredClone(task)
    }

    if (expectedRunId !== undefined && task.run?.id !== expectedRunId) return structuredClone(task)
    if (status === "starting" && !["draft", "starting", "completed", "failed", "cancelled"].includes(task.status)) {
      throw new Error("Task cannot start a new run from its current state")
    }
    if (status === "running" && task.status !== "starting") throw new Error("Task is not starting")
    if (status === "running" && !run?.sessionId) throw new Error("Running task requires a session id")
    if ((status === "completed" || status === "failed") && task.status !== "starting" && task.status !== "running") {
      if (expectedRunId !== undefined) return structuredClone(task)
      throw new Error("Only active tasks can enter a terminal state")
    }

    const nextRun = structuredClone(run ?? task.run)
    const nextError = persistedError(error)
    if (nextRun) {
      nextRun.status = status
      if (status === "failed") nextRun.error = nextError
      else if (Object.prototype.hasOwnProperty.call(nextRun, "error")) delete nextRun.error
    }
    if ((status === "completed" || status === "failed") && nextRun && !nextRun.finishedAt) {
      nextRun.finishedAt = this.clock()
    }
    const runs = updateRunHistory(task, nextRun)
    const terminalTransition = (status === "completed" || status === "failed") && !task.run?.finishedAt
    const currentRevision = Number(task.context?.revision) || 0
    const nextRevision = terminalTransition ? currentRevision + 1 : currentRevision
    const updated = {
      ...task,
      status,
      run: nextRun,
      runs,
      error: nextError,
      finishedAt: status === "starting" ? null : task.finishedAt ?? null,
      updatedAt: this.clock()
    }
    updated.context = buildPersistedTaskContext(updated, nextRevision)
    this.tasks[index] = updated
    await this.persist()
    return structuredClone(updated)
  }
}
