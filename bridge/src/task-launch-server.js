import http from "node:http"
import { allowedOrigin, applyCorsHeaders, matchesCredentials, writeJSON } from "./http-policy.js"

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

function launchStatus(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith("Unknown task:")) return 404
  if (message.includes("unavailable")) return 503
  if (message.includes("Only draft tasks") || message.includes("worktree") || message.includes("workspace")) return 409
  return 500
}

export function createTaskLaunchServer({ innerServer, config, taskRunController, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const match = TASK_LAUNCH_ROUTE.exec(requestURL.pathname)
    if (!match) {
      innerServer.emit("request", request, response)
      return
    }

    if (!authenticate(request, response, config)) return
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST, OPTIONS" })
      response.end()
      return
    }

    const taskID = decodeURIComponent(match[1])
    try {
      writeJSON(response, 200, await taskRunController.launch(taskID))
    } catch (error) {
      writeJSON(response, launchStatus(error), { error: error instanceof Error ? error.message : String(error) })
    }
  })
}
