import { randomUUID } from "node:crypto"
import { taskLaunchError } from "./task-errors.js"

export class TaskRunController {
  constructor({ taskStore, taskLauncher, runIDFactory = randomUUID, clock = () => new Date().toISOString() }) {
    this.taskStore = taskStore
    this.taskLauncher = taskLauncher
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
