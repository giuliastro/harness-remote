import http from "node:http"
import { allowedOrigin, applyCorsHeaders, matchesCredentials, writeJSON } from "./http-policy.js"

const TASK_LAUNCH_ROUTE = /^\/v1\/tasks\/([^/]+)\/launch$/
const TASK_WORKTREE_ROUTE = /^\/v1\/tasks\/([^/]+)\/worktree$/
const TASK_WORKTREE_CLEANUP_ROUTE = /^\/v1\/tasks\/([^/]+)\/worktree\/cleanup$/
const LAUNCH_STATUS = new Map([
  ["unknown_task", 404],
  ["unknown_agent", 404],
  ["agent_unavailable", 503],
  ["invalid_state", 409],
  ["workspace_required", 409],
  ["unsupported_agent", 409],
  ["task_active", 409],
  ["worktree_dirty", 409],
  ["invalid_worktree", 409],
  ["worktree_outside_state", 409],
  ["worktree_missing", 409]
])

function authenticate(request, response, config) {
  applyCorsHeaders(request, response, config)
  if (request.method === "OPTIONS") {
    response.writeHead(allowedOrigin(request, config) ? 204 : 403)
    response.end()
    return false
  }
  if (!matchesCredentials(request, config)) {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Harness Remote Daemon"' })
    response.end()
    return false
  }
  return true
}

export function launchStatus(error) {
  return LAUNCH_STATUS.get(error?.code) ?? 500
}

export function createTaskLaunchServer({ innerServer, config, taskRunController, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const launchMatch = TASK_LAUNCH_ROUTE.exec(requestURL.pathname)
    const worktreeMatch = TASK_WORKTREE_ROUTE.exec(requestURL.pathname)
    const cleanupMatch = TASK_WORKTREE_CLEANUP_ROUTE.exec(requestURL.pathname)
    const inspect = worktreeMatch && request.method === "GET"
    const cleanup = cleanupMatch && request.method === "POST"
    if (!launchMatch && !inspect && !cleanup) {
      innerServer.emit("request", request, response)
      return
    }

    if (!authenticate(request, response, config)) return
    try {
      if (launchMatch) {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST, OPTIONS" })
          response.end()
          return
        }
        writeJSON(response, 200, await taskRunController.launch(decodeURIComponent(launchMatch[1])))
        return
      }
      if (inspect) {
        writeJSON(response, 200, await taskRunController.inspectWorkspace(decodeURIComponent(worktreeMatch[1])))
        return
      }
      writeJSON(response, 200, await taskRunController.cleanupWorkspace(decodeURIComponent(cleanupMatch[1])))
    } catch (error) {
      writeJSON(response, launchStatus(error), {
        error: error instanceof Error ? error.message : String(error),
        ...(error?.code ? { code: error.code } : {})
      })
    }
  })
}
