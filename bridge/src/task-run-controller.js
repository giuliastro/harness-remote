import { randomUUID } from "node:crypto"
import { taskLaunchError } from "./task-errors.js"
import { WorktreeManager } from "./worktree-manager.js"

export class TaskRunController {
  constructor({ taskStore, taskLauncher, worktreeManager, runIDFactory = randomUUID, clock = () => new Date().toISOString() }) {
    this.taskStore = taskStore
    this.taskLauncher = taskLauncher
    this.worktreeManager = worktreeManager ?? (taskStore?.stateDirectory ? new WorktreeManager({ stateDirectory: taskStore.stateDirectory }) : undefined)
    this.runIDFactory = runIDFactory
    this.clock = clock
    this.reconciliationError = null
    this.reconciliation = (typeof taskStore?.list === "function" ? this.reconcileAll() : Promise.resolve())
      .catch((error) => { this.reconciliationError = error })
  }

  async #awaitReconciliation() {
    await this.reconciliation
    if (this.reconciliationError) {
      throw taskLaunchError("agent_unavailable", "Task state is unavailable", { cause: this.reconciliationError })
    }
  }

  async #terminal(taskID, run, status, error = null) {
    try { await this.taskStore.setRunState(taskID, { status, run, error, expectedRunId: run?.id }) } catch {}
  }

  async reconcileAll() {
    for (const task of await this.taskStore.list()) {
      if (!["starting", "running"].includes(task.status)) continue
      if (!task.run?.id) {
        try { await this.taskStore.setRunState(task.id, { status: "failed", error: new Error("Active task has no persisted run identity") }) } catch {}
        continue
      }
      let state = "unknown"
      try { state = await this.taskLauncher.inspectRun?.(task) ?? "unknown" } catch {}
      if (state === "completed") await this.#terminal(task.id, task.run, "completed")
      else if (state !== "running") await this.#terminal(task.id, task.run, "failed", new Error("Task run could not be confirmed after daemon restart"))
    }
  }

  async inspectWorkspace(taskID) {
    await this.#awaitReconciliation()
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (task.workspace?.mode !== "worktree") return { managed: false, dirty: false, changeCount: 0 }
    if (!this.worktreeManager) throw new Error("Worktree manager is not configured")
    return this.worktreeManager.inspect(task.workspace)
  }

  async cleanupWorkspace(taskID) {
    await this.#awaitReconciliation()
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (task.status === "starting" || task.status === "running") throw taskLaunchError("task_active", "An active task cannot release its workspace")
    if (task.workspace?.mode !== "worktree") return { task, cleanup: { removed: false, branchDeleted: false } }
    if (!this.worktreeManager) throw new Error("Worktree manager is not configured")
    const cleanup = await this.worktreeManager.cleanup(task.workspace)
    const updated = await this.taskStore.clearWorkspace(taskID)
    return { task: updated, cleanup }
  }

  async launch(taskID) {
    await this.#awaitReconciliation()
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (task.status !== "draft") throw taskLaunchError("invalid_state", "Only draft tasks can be launched")
    if (task.project?.kind === "git" && task.workspace?.mode !== "worktree") throw taskLaunchError("workspace_required", "Git tasks must prepare an isolated worktree before launch")
    if (!task.workspace?.path) throw taskLaunchError("workspace_required", "Task workspace is not prepared")

    const run = { id: this.runIDFactory(), agentId: task.agentId, sessionId: null, transport: null, directory: task.workspace.path, startedAt: this.clock() }
    let current = await this.taskStore.setRunState(taskID, { status: "starting", run })
    try {
      const session = await this.taskLauncher.createSession(current)
      const linkedRun = { ...run, sessionId: session.sessionId, transport: session.transport }
      current = await this.taskStore.setRunState(taskID, { status: "starting", run: linkedRun, expectedRunId: run.id })
      const onFailed = (error) => void this.#terminal(taskID, linkedRun, "failed", error)
      onFailed.onFailed = onFailed
      onFailed.onCompleted = () => void this.#terminal(taskID, linkedRun, "completed")
      await this.taskLauncher.startPrompt(current, session, onFailed)
      return await this.taskStore.setRunState(taskID, { status: "running", run: linkedRun, expectedRunId: linkedRun.id })
    } catch (error) {
      await this.#terminal(taskID, current.run ?? run, "failed", error)
      throw error
    }
  }
}
