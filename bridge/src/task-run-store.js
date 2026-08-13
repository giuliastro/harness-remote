import { TaskStore } from "./task-store.js"

export class TaskRunStore extends TaskStore {
  async setRunState(taskID, { status, run, error = null }) {
    await this.load()
    const index = this.tasks.findIndex((task) => task.id === taskID)
    if (index < 0) throw new Error(`Unknown task: ${taskID}`)
    const task = this.tasks[index]

    if (status === "starting" && task.status !== "draft" && task.status !== "starting") {
      throw new Error("Only draft tasks can start a run")
    }
    if (status === "running" && task.status !== "starting") throw new Error("Task is not starting")
    if (status === "running" && !run?.sessionId) throw new Error("Running task requires a session id")

    const updated = {
      ...task,
      status,
      run: structuredClone(run ?? task.run),
      error: error ? { message: error instanceof Error ? error.message : String(error) } : null,
      updatedAt: this.clock()
    }
    this.tasks[index] = updated
    await this.persist()
    return structuredClone(updated)
  }
}
