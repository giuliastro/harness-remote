import http from "node:http"
import { authenticateDaemonRequest, writeJSON } from "./http-policy.js"

const MODEL_ROUTE = /^\/v1\/agents\/([^/]+)\/models$/
const TASK_LAUNCH_ROUTE = /^\/v1\/tasks\/([^/]+)\/launch$/
const DEFAULT_MODEL_WAIT_MS = 4_000
const MAX_MODEL_WAIT_MS = 8_000


function modelWaitMs(url) {
  const raw = url.searchParams.get("waitMs")
  if (raw === null || raw === "") return DEFAULT_MODEL_WAIT_MS
  const value = Number(raw)
  if (!Number.isFinite(value)) return DEFAULT_MODEL_WAIT_MS
  return Math.max(0, Math.min(MAX_MODEL_WAIT_MS, Math.trunc(value)))
}

async function settleWithin(promise, waitMs) {
  if (waitMs <= 0) return { settled: false }
  let timer
  const pending = Symbol("pending")
  try {
    const result = await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => resolve(pending), waitMs) })
    ])
    return result === pending ? { settled: false } : { settled: true, result }
  } catch (error) {
    return { settled: true, error }
  } finally {
    clearTimeout(timer)
  }
}

export function createAgentModelServer({ innerServer, config, daemon, taskStore, createServer = http.createServer }) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const modelMatch = MODEL_ROUTE.exec(url.pathname)
    if (modelMatch) {
      if (!authenticateDaemonRequest(request, response, config)) return
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET, OPTIONS" })
        response.end()
        return
      }
      const agentID = decodeURIComponent(modelMatch[1])
      const refresh = url.searchParams.get("refresh") === "1"
      const discovery = daemon.listModels(agentID, { allowStale: true, refresh })
      const settled = await settleWithin(discovery, modelWaitMs(url))
      if (!settled.settled) {
        // The discovery remains owned by the daemon/catalog and continues after this response. A
        // mobile/browser request is therefore never required to survive a cold `npx` adapter start.
        // Subsequent polls join the same single-flight operation instead of starting another ACP
        // process/session and the picker can survive background/foreground network transitions.
        const diagnostics = daemon.modelDiagnostics?.(agentID) ?? {}
        response.setHeader("Retry-After", "1")
        writeJSON(response, 202, {
          models: [],
          stale: false,
          refreshedAt: diagnostics.refreshedAt ?? null,
          loading: true,
          source: diagnostics.source,
          // Which phase discovery is in is the difference between "the adapter will not start" and
          // "variant probing is slow". Without it a stuck picker looks the same in every case.
          phase: diagnostics.phase ?? undefined,
          lastError: diagnostics.lastError ?? undefined
        })
        return
      }
      if (settled.error) {
        writeJSON(response, 503, { error: settled.error instanceof Error ? settled.error.message : String(settled.error), models: [], stale: true })
        return
      }
      writeJSON(response, 200, settled.result)
      return
    }

    const launchMatch = TASK_LAUNCH_ROUTE.exec(url.pathname)
    if (launchMatch && request.method === "POST") {
      if (!authenticateDaemonRequest(request, response, config)) return
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
