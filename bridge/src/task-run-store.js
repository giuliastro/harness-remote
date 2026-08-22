import { TaskStore } from "./task-store.js"
import { buildPersistedTaskContext } from "./task-context.js"

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

export class TaskRunStore extends TaskStore {
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