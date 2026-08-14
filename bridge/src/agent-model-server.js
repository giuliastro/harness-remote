import http from "node:http"
import { allowedOrigin, applyCorsHeaders, matchesCredentials, writeJSON } from "./http-policy.js"

const MODEL_ROUTE = /^\/v1\/agents\/([^/]+)\/models$/
const TASK_LAUNCH_ROUTE = /^\/v1\/tasks\/([^/]+)\/launch$/

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

/**
 * Machine-level model discovery is intentionally separate from the session API. Opening New Task
 * asks this endpoint for a fresh catalog, while task launch validates the selected model once more
 * before any agent session is started. A stale picker can therefore never silently fall back to a
 * different model.
 */
export function createAgentModelServer({
  innerServer,
  config,
  daemon,
  taskStore,
  createServer = http.createServer
}) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const modelMatch = MODEL_ROUTE.exec(url.pathname)
    if (modelMatch) {
      if (!authenticate(request, response, config)) return
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET, OPTIONS" })
        response.end()
        return
      }
      const agentID = decodeURIComponent(modelMatch[1])
      try {
        writeJSON(response, 200, await daemon.listModels(agentID, { allowStale: true }))
      } catch (error) {
        writeJSON(response, 503, { error: error instanceof Error ? error.message : String(error), models: [], stale: true })
      }
      return
    }

    const launchMatch = TASK_LAUNCH_ROUTE.exec(url.pathname)
    if (launchMatch && request.method === "POST") {
      if (!authenticate(request, response, config)) return
      const taskID = decodeURIComponent(launchMatch[1])
      try {
        const task = await taskStore.get(taskID)
        if (!task) {
          writeJSON(response, 404, { error: `Unknown task: ${taskID}` })
          return
        }
        if (task.model) await daemon.validateModel(task.agentId, task.model)
      } catch (error) {
        const status = error?.code === "model_unavailable" ? 409 : 503
        writeJSON(response, status, { error: error instanceof Error ? error.message : String(error) })
        return
      }
      innerServer.emit("request", request, response)
      return
    }

    innerServer.emit("request", request, response)
  })
}
