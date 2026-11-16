import http from "node:http"
import { authenticateDaemonRequest, guardRequestHandler, writeJSON } from "./http-policy.js"

const TASK_LAUNCH_ROUTE = /^\/v1\/tasks\/([^/]+)\/launch$/
const TASK_CONTINUE_ROUTE = /^\/v1\/tasks\/([^/]+)\/continue$/
const TASK_CONTEXT_ROUTE = /^\/v1\/tasks\/([^/]+)\/context$/
const TASK_WORKTREE_ROUTE = /^\/v1\/tasks\/([^/]+)\/worktree$/
const TASK_WORKTREE_CLEANUP_ROUTE = /^\/v1\/tasks\/([^/]+)\/worktree\/cleanup$/
const LAUNCH_STATUS = new Map([
  ["invalid_request", 400],
  ["unknown_task", 404],
  ["unknown_agent", 404],
  ["agent_unavailable", 503],
  ["invalid_state", 409],
  ["workspace_required", 409],
  ["unsupported_agent", 409],
  ["session_unavailable", 409],
  ["model_unavailable", 409],
  ["task_active", 409],
  ["worktree_dirty", 409],
  ["invalid_worktree", 409],
  ["worktree_outside_state", 409],
  ["worktree_missing", 409],
  ["invalid_project", 409]
])

function requestError(message) {
  const error = new Error(message)
  error.code = "invalid_request"
  return error
}

async function readJSONBody(request) {
  request.setEncoding("utf8")
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) throw requestError("Request body is too large")
  }
  if (!body) return {}
  try {
    return JSON.parse(body)
  } catch {
    throw requestError("Request body must be valid JSON")
  }
}

export function launchStatus(error) {
  return LAUNCH_STATUS.get(error?.code) ?? 500
}

export function createTaskLaunchServer({ innerServer, config, taskRunController, createServer = http.createServer }) {
  return createServer(guardRequestHandler(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const launchMatch = TASK_LAUNCH_ROUTE.exec(requestURL.pathname)
    const continueMatch = TASK_CONTINUE_ROUTE.exec(requestURL.pathname)
    const contextMatch = TASK_CONTEXT_ROUTE.exec(requestURL.pathname)
    const worktreeMatch = TASK_WORKTREE_ROUTE.exec(requestURL.pathname)
    const cleanupMatch = TASK_WORKTREE_CLEANUP_ROUTE.exec(requestURL.pathname)
    const inspect = worktreeMatch && request.method === "GET"
    const cleanup = cleanupMatch && request.method === "POST"
    const context = contextMatch && request.method === "GET"
    if (!launchMatch && !continueMatch && !context && !inspect && !cleanup) {
      innerServer.emit("request", request, response)
      return
    }

    if (!authenticateDaemonRequest(request, response, config)) return
    try {
      if (context) {
        writeJSON(response, 200, await taskRunController.context(decodeURIComponent(contextMatch[1])))
        return
      }
      if (launchMatch || continueMatch) {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST, OPTIONS" })
          response.end()
          return
        }
        const taskID = decodeURIComponent((launchMatch ?? continueMatch)[1])
        const body = await readJSONBody(request)
        if (!body || typeof body !== "object" || Array.isArray(body)) throw requestError("Request body must be a JSON object")
        if (continueMatch) {
          writeJSON(response, 200, await taskRunController.continue(taskID, body))
        } else {
          writeJSON(response, 200, await taskRunController.launch(taskID, body))
        }
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
  }))
}
