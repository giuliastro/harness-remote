import http from "node:http"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"
import { inspectTaskWork } from "./task-finish.js"

const resultRoute = /^\/v1\/tasks\/([^/]+)\/result$/
const finishRoute = /^\/v1\/tasks\/([^/]+)\/finish$/

function status(error) {
  if (error?.code === "unknown_task") return 404
  if (error?.code === "agent_unavailable") return 503
  if (["task_active", "worktree_dirty", "invalid_worktree", "worktree_outside_state", "worktree_missing"].includes(error?.code)) return 409
  return 500
}

export function createTaskFinishServer({ innerServer, config, taskStore, worktreeManager, taskRunController, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`).pathname
    const resultMatch = resultRoute.exec(pathname)
    const finishMatch = finishRoute.exec(pathname)
    const inspect = resultMatch && request.method === "GET"
    const finish = finishMatch && request.method === "POST"
    if (!inspect && !finish) {
      innerServer.emit("request", request, response)
      return
    }
    if (!authenticateDaemonRequest(request, response, config)) return

    try {
      if (taskRunController) {
        await taskRunController.reconciliation
        if (taskRunController.reconciliationError) {
          const error = new Error("Task state is unavailable")
          error.code = "agent_unavailable"
          throw error
        }
      }
      const taskID = decodeURIComponent((resultMatch ?? finishMatch)[1])
      const task = await taskStore.get(taskID)
      if (!task) {
        const error = new Error(`Unknown task: ${taskID}`)
        error.code = "unknown_task"
        throw error
      }
      if (task.workspace?.mode !== "worktree") {
        const result = { managed: false, dirty: false, changeCount: 0 }
        writeJSON(response, 200, finish ? { task, result, cleanup: { removed: false, branchDeleted: false } } : result)
        return
      }
      if (finish && ["starting", "running"].includes(task.status)) {
        const error = new Error("An active task cannot be finished")
        error.code = "task_active"
        throw error
      }
      const result = await inspectTaskWork(task.workspace, worktreeManager)
      if (!finish) {
        writeJSON(response, 200, result)
        return
      }
      const cleanup = await worktreeManager.cleanup(task.workspace)
      const updated = await taskStore.clearWorkspace(taskID)
      writeJSON(response, 200, { task: updated, result, cleanup })
    } catch (error) {
      writeJSON(response, status(error), { error: error instanceof Error ? error.message : String(error), ...(error?.code ? { code: error.code } : {}) })
    }
  })
}
