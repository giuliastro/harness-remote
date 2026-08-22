import http from "node:http"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"

const COLLECTION = "/v1/work-threads"
const DETAIL_ROUTE = /^\/v1\/work-threads\/([^/]+)$/
const CANCEL_ROUTE = /^\/v1\/work-threads\/([^/]+)\/cancel$/
const CHECKPOINTS_ROUTE = /^\/v1\/work-threads\/([^/]+)\/checkpoints$/
const RESTORE_ROUTE = /^\/v1\/work-threads\/([^/]+)\/checkpoints\/([^/]+)\/restore$/

async function readJSONBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) throw new Error("Request body is too large")
  }
  if (!body) return {}
  try { return JSON.parse(body) } catch { throw new Error("Request body must be valid JSON") }
}

function statusFor(error) {
  const message = error instanceof Error ? error.message : String(error)
  if (/Unknown task|not found/i.test(message)) return 404
  if (/required|too long|valid JSON/i.test(message)) return 400
  if (/Wait for|Stop the coding agent|active/i.test(message)) return 409
  return 500
}

export function createWorkThreadServer({ innerServer, config, controller, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const detail = DETAIL_ROUTE.exec(requestURL.pathname)
    const cancel = CANCEL_ROUTE.exec(requestURL.pathname)
    const checkpoints = CHECKPOINTS_ROUTE.exec(requestURL.pathname)
    const restore = RESTORE_ROUTE.exec(requestURL.pathname)
    const matches = requestURL.pathname === COLLECTION || detail || cancel || checkpoints || restore
    if (!matches) {
      innerServer.emit("request", request, response)
      return
    }
    if (!authenticateDaemonRequest(request, response, config)) return

    try {
      if (requestURL.pathname === COLLECTION && request.method === "GET") {
        writeJSON(response, 200, { workThreads: await controller.list() })
        return
      }
      if (detail && request.method === "GET") {
        const task = await controller.get(decodeURIComponent(detail[1]))
        if (!task) {
          writeJSON(response, 404, { error: "Work Thread not found" })
          return
        }
        writeJSON(response, 200, task)
        return
      }
      if (detail && request.method === "PATCH") {
        const body = await readJSONBody(request)
        writeJSON(response, 200, await controller.rename(decodeURIComponent(detail[1]), body?.title))
        return
      }
      if (cancel && request.method === "POST") {
        writeJSON(response, 200, await controller.markCancelled(decodeURIComponent(cancel[1])))
        return
      }
      if (checkpoints && request.method === "GET") {
        writeJSON(response, 200, { checkpoints: await controller.checkpointsFor(decodeURIComponent(checkpoints[1])) })
        return
      }
      if (checkpoints && request.method === "POST") {
        const body = await readJSONBody(request)
        const checkpoint = await controller.createCheckpoint(decodeURIComponent(checkpoints[1]), {
          label: typeof body?.label === "string" ? body.label : undefined,
          kind: typeof body?.kind === "string" ? body.kind : "manual",
          runId: typeof body?.runId === "string" ? body.runId : null
        })
        writeJSON(response, 200, { checkpoint })
        return
      }
      if (restore && request.method === "POST") {
        writeJSON(response, 200, await controller.restoreCheckpoint(
          decodeURIComponent(restore[1]),
          decodeURIComponent(restore[2])
        ))
        return
      }

      const allow = requestURL.pathname === COLLECTION
        ? "GET, OPTIONS"
        : cancel || restore
          ? "POST, OPTIONS"
          : checkpoints
            ? "GET, POST, OPTIONS"
            : "GET, PATCH, OPTIONS"
      response.writeHead(405, { Allow: allow })
      response.end()
    } catch (error) {
      writeJSON(response, statusFor(error), { error: error instanceof Error ? error.message : String(error) })
    }
  })
}
