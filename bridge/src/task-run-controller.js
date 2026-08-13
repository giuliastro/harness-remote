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
  }

  async #recordPromptFailure(taskID, run, error) {
    try {
      const current = await this.taskStore.get(taskID)
      if (!current || current.run?.id !== run.id) return
      if (current.status !== "starting" && current.status !== "running") return
      await this.taskStore.setRunState(taskID, { status: "failed", run: current.run, error })
    } catch {}
  }

  async inspectWorkspace(taskID) {
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (task.workspace?.mode !== "worktree") return { managed: false, dirty: false, changeCount: 0 }
    if (!this.worktreeManager) throw new Error("Worktree manager is not configured")
    return this.worktreeManager.inspect(task.workspace)
  }

  async cleanupWorkspace(taskID) {
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (task.status === "starting" || task.status === "running") {
      throw taskLaunchError("task_active", "An active task cannot release its workspace")
    }
    if (task.workspace?.mode !== "worktree") {
      return { task, cleanup: { removed: false, branchDeleted: false } }
    }
    if (!this.worktreeManager) throw new Error("Worktree manager is not configured")
    const cleanup = await this.worktreeManager.cleanup(task.workspace)
    const updated = await this.taskStore.clearWorkspace(taskID)
    return { task: updated, cleanup }
  }

  async launch(taskID) {
    const task = await this.taskStore.get(taskID)
    if (!task) throw taskLaunchError("unknown_task", `Unknown task: ${taskID}`)
    if (task.status !== "draft") throw taskLaunchError("invalid_state", "Only draft tasks can be launched")
    if (task.project?.kind === "git" && task.workspace?.mode !== "worktree") {
      throw taskLaunchError("workspace_required", "Git tasks must prepare an isolated worktree before launch")
    }
    if (!task.workspace?.path) throw taskLaunchError("workspace_required", "Task workspace is not prepared")

    const run = {
      id: this.runIDFactory(),
      agentId: task.agentId,
      sessionId: null,
      transport: null,
      directory: task.workspace.path,
      startedAt: this.clock()
    }
    let current = await this.taskStore.setRunState(taskID, { status: "starting", run })

    try {
      const session = await this.taskLauncher.createSession(current)
      const linkedRun = {
        ...run,
        sessionId: session.sessionId,
        transport: session.transport
      }
      current = await this.taskStore.setRunState(taskID, { status: "starting", run: linkedRun })
      await this.taskLauncher.startPrompt(current, session, (error) => {
        void this.#recordPromptFailure(taskID, linkedRun, error)
      })
      return await this.taskStore.setRunState(taskID, { status: "running", run: linkedRun })
    } catch (error) {
      try {
        await this.taskStore.setRunState(taskID, { status: "failed", run: current.run ?? run, error })
      } catch {}
      throw error
    }
  }
}
