import { randomUUID } from "node:crypto"

export class TaskRunController {
  constructor({ taskStore, taskLauncher, runIDFactory = randomUUID, clock = () => new Date().toISOString() }) {
    this.taskStore = taskStore
    this.taskLauncher = taskLauncher
    this.runIDFactory = runIDFactory
    this.clock = clock
  }

  async launch(taskID) {
    const task = await this.taskStore.get(taskID)
    if (!task) throw new Error(`Unknown task: ${taskID}`)
    if (task.status !== "draft") throw new Error("Only draft tasks can be launched")
    if (task.project?.kind === "git" && task.workspace?.mode !== "worktree") {
      throw new Error("Git tasks must prepare an isolated worktree before launch")
    }
    if (!task.workspace?.path) throw new Error("Task workspace is not prepared")

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
      await this.taskLauncher.startPrompt(current, session)
      return await this.taskStore.setRunState(taskID, { status: "running", run: linkedRun })
    } catch (error) {
      try {
        await this.taskStore.setRunState(taskID, { status: "failed", run: current.run ?? run, error })
      } catch {}
      throw error
    }
  }
}
