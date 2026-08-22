import { buildPersistedTaskContext } from "./task-context.js"
import { abortWorkThreadRun } from "./work-thread-abort.js"
import { WorkThreadCheckpointManager } from "./work-thread-checkpoints.js"

const ACTIVE = new Set(["starting", "running"])
const TERMINAL = new Set(["completed", "failed", "cancelled"])
const STARTUP_RECONCILE_GRACE_MS = 15_000

function runAgent(task, run = task?.run) {
  return run?.agentId || task?.agentId || ""
}

function sessionID(run) {
  return run?.sessionId || run?.sessionID || null
}

function titleFromTask(task) {
  const explicit = typeof task?.title === "string" ? task.title.trim() : ""
  if (explicit) return explicit
  const line = typeof task?.prompt === "string" ? task.prompt.trim().split(/\r?\n/).find(Boolean)?.trim() : ""
  return line || "Untitled Work Thread"
}

function isInsideStartupGrace(task, now) {
  const started = Date.parse(task?.run?.startedAt || "")
  const current = Date.parse(now || "")
  return Number.isFinite(started) && Number.isFinite(current) && current >= started && current - started < STARTUP_RECONCILE_GRACE_MS
}

export class WorkThreadController {
  constructor({ taskStore, taskRunController, checkpointManager, clock = () => new Date().toISOString() }) {
    this.taskStore = taskStore
    this.taskRunController = taskRunController
    this.clock = clock
    this.checkpoints = checkpointManager ?? new WorkThreadCheckpointManager({ stateDirectory: taskStore.stateDirectory })
    this.reconciling = new Map()
  }

  async #mutate(taskID, mutator) {
    await this.taskStore.load()
    const index = this.taskStore.tasks.findIndex((candidate) => candidate.id === taskID)
    if (index < 0) throw new Error(`Unknown task: ${taskID}`)
    const current = this.taskStore.tasks[index]
    const updated = mutator(structuredClone(current))
    this.taskStore.tasks[index] = updated
    await this.taskStore.persist()
    return structuredClone(updated)
  }

  async #inspectActive(task) {
    if (!ACTIVE.has(task?.status) || !sessionID(task.run)) return "unchanged"
    const agentID = runAgent(task)
    if (task.run?.transport === "acp") {
      const service = this.taskRunController.acpService?.(agentID)
      if (!service) return "unknown"
      try {
        const status = service.status(sessionID(task.run))
        return status?.type === "busy" ? "running" : "completed"
      } catch {
        return "unknown"
      }
    }
    try {
      return await this.taskRunController.taskLauncher.inspectRun(task)
    } catch {
      return "unknown"
    }
  }

  async reconcile(taskID) {
    const existing = this.reconciling.get(taskID)
    if (existing) return existing
    const work = (async () => {
      let task = await this.taskStore.get(taskID)
      if (!task || !ACTIVE.has(task.status)) return task
      const state = await this.#inspectActive(task)
      if (state === "completed" && !isInsideStartupGrace(task, this.clock())) {
        try {
          task = await this.taskStore.setRunState(taskID, {
            status: "completed",
            run: task.run,
            expectedRunId: task.run?.id
          })
        } catch {}
      } else if (state === "failed") {
        try {
          task = await this.taskStore.setRunState(taskID, {
            status: "failed",
            run: task.run,
            error: new Error("The native coding session is no longer running"),
            expectedRunId: task.run?.id
          })
        } catch {}
      }
      return task
    })().finally(() => this.reconciling.delete(taskID))
    this.reconciling.set(taskID, work)
    return work
  }

  async list() {
    const tasks = await this.taskStore.list()
    await Promise.all(tasks.filter((task) => ACTIVE.has(task.status)).map((task) => this.reconcile(task.id)))
    const refreshed = await this.taskStore.list()
    return refreshed.map((task) => ({ ...task, title: titleFromTask(task) }))
  }

  async get(taskID) {
    await this.reconcile(taskID)
    const task = await this.taskStore.get(taskID)
    return task ? { ...task, title: titleFromTask(task) } : undefined
  }

  async rename(taskID, title) {
    const text = typeof title === "string" ? title.trim().replace(/\s+/g, " ") : ""
    if (!text) throw new Error("A Work Thread title is required")
    if (text.length > 180) throw new Error("Work Thread title is too long")
    return this.#mutate(taskID, (task) => ({
      ...task,
      title: text,
      updatedAt: this.clock()
    }))
  }

  async markCancelled(taskID) {
    let task = await this.taskStore.get(taskID)
    if (!task) throw new Error(`Unknown task: ${taskID}`)
    if (!ACTIVE.has(task.status)) return task

    // A product-level Stop must stop the real native session first. Persisting "cancelled" while the
    // harness keeps editing files would be much worse than returning an error and leaving state honest.
    await abortWorkThreadRun(task, this.taskRunController)
    task = await this.taskStore.get(taskID) ?? task
    if (!ACTIVE.has(task.status)) return task

    return this.#mutate(taskID, (current) => {
      const timestamp = this.clock()
      const run = current.run ? { ...current.run, status: "cancelled", finishedAt: current.run.finishedAt || timestamp } : current.run
      const runs = Array.isArray(current.runs)
        ? current.runs.map((entry) => entry?.id === run?.id ? run : entry)
        : run ? [run] : []
      const updated = {
        ...current,
        status: "cancelled",
        run,
        runs,
        error: null,
        updatedAt: timestamp
      }
      updated.context = buildPersistedTaskContext(updated, (Number(current.context?.revision) || 0) + 1)
      return updated
    })
  }

  async createCheckpoint(taskID, { label, kind = "manual", runId = null } = {}) {
    const task = await this.taskStore.get(taskID)
    if (!task) throw new Error(`Unknown task: ${taskID}`)
    if (ACTIVE.has(task.status)) throw new Error("Wait for the coding agent to finish before creating a checkpoint")
    const existing = Array.isArray(task.checkpoints) ? task.checkpoints : []
    if (runId && existing.some((checkpoint) => checkpoint.runId === runId && checkpoint.kind === kind)) {
      return existing.find((checkpoint) => checkpoint.runId === runId && checkpoint.kind === kind)
    }
    if (kind === "baseline" && existing.some((checkpoint) => checkpoint.kind === "baseline")) {
      return existing.find((checkpoint) => checkpoint.kind === "baseline")
    }
    const checkpoint = await this.checkpoints.create(task, { label, kind, runId })
    if (!checkpoint) return null
    await this.#mutate(taskID, (current) => ({
      ...current,
      checkpoints: [...(Array.isArray(current.checkpoints) ? current.checkpoints : []), checkpoint],
      updatedAt: this.clock()
    }))
    return checkpoint
  }

  async checkpointsFor(taskID) {
    const task = await this.taskStore.get(taskID)
    if (!task) throw new Error(`Unknown task: ${taskID}`)
    return Array.isArray(task.checkpoints) ? task.checkpoints : []
  }

  async restoreCheckpoint(taskID, checkpointID) {
    const task = await this.taskStore.get(taskID)
    if (!task) throw new Error(`Unknown task: ${taskID}`)
    if (ACTIVE.has(task.status)) throw new Error("Stop the coding agent before restoring a checkpoint")
    const checkpoint = (Array.isArray(task.checkpoints) ? task.checkpoints : []).find((candidate) => candidate.id === checkpointID)
    if (!checkpoint) throw new Error("Checkpoint not found")

    // Make restore itself reversible before rewriting the workspace.
    try {
      await this.createCheckpoint(taskID, { label: `Before restore: ${checkpoint.label || "checkpoint"}`, kind: "before-restore" })
    } catch {}
    const latest = await this.taskStore.get(taskID)
    const result = await this.checkpoints.restore(latest, checkpoint)
    const updated = await this.#mutate(taskID, (current) => {
      const timestamp = this.clock()
      const next = {
        ...current,
        restoredCheckpointId: checkpoint.id,
        restoredAt: timestamp,
        updatedAt: timestamp
      }
      next.context = buildPersistedTaskContext(next, (Number(current.context?.revision) || 0) + 1)
      return next
    })
    return { task: updated, result }
  }

  async ensureTerminalCheckpoint(taskID) {
    const task = await this.taskStore.get(taskID)
    if (!task || !TERMINAL.has(task.status) || !task.run?.id || !task.run?.finishedAt) return null
    return this.createCheckpoint(taskID, {
      label: `After ${task.run.agentId || task.agentId || "agent"} step ${task.run.sequence || ""}`.trim(),
      kind: "after-run",
      runId: task.run.id
    })
  }
}