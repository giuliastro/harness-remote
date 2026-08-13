import http from "node:http"
import { matchesCredentials, writeJSON } from "./http-policy.js"

const ROUTE = /^\/v1\/tasks\/([^/]+)\/worktree$/

export function createTaskWorktreeLifecycleServer({ innerServer, config, taskStore, worktreeManager, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const match = ROUTE.exec(new URL(request.url ?? "/", "http://localhost").pathname)
    if (!match || request.method === "POST") return innerServer.emit("request", request, response)
    if (!matchesCredentials(request, config)) {
      response.writeHead(401)
      response.end()
      return
    }
    if (request.method !== "GET" && request.method !== "DELETE") {
      response.writeHead(405, { Allow: "GET, POST, DELETE, OPTIONS" })
      response.end()
      return
    }
    const taskID = decodeURIComponent(match[1])
    const task = await taskStore.get(taskID)
    if (!task) return writeJSON(response, 404, { error: `Unknown task: ${taskID}` })
    if (request.method === "GET") {
      const state = task.workspace?.mode === "worktree" ? await worktreeManager.inspect(task.workspace) : { managed: false, dirty: false, changeCount: 0 }
      return writeJSON(response, 200, state)
    }
    if (task.status === "starting" || task.status === "running") return writeJSON(response, 409, { error: "An active task cannot release its workspace" })
    if (task.workspace?.mode !== "worktree") return writeJSON(response, 200, { task, cleanup: { removed: false, branchDeleted: false } })
    try {
      const cleanup = await worktreeManager.cleanup(task.workspace)
      const updated = await taskStore.clearWorkspace(taskID)
      return writeJSON(response, 200, { task: updated, cleanup })
    } catch (error) {
      return writeJSON(response, error?.code === "worktree_dirty" ? 409 : 500, { error: error instanceof Error ? error.message : String(error), code: error?.code })
    }
  })
}
