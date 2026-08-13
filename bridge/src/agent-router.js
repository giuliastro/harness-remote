import http from "node:http"
import { allowedOrigin, applyCorsHeaders, matchesCredentials, writeJSON } from "./http-policy.js"

const AGENT_ROUTE = /^\/v1\/agents\/([^/]+)(\/.*)?$/
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade"
])
const STREAMING_PATHS = new Set(["/global/event", "/v1/events"])
const DEFAULT_PROXY_TIMEOUT_MS = 15_000

function proxyHeaders(headers, authorization) {
  const result = {}
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    if (
      value === undefined ||
      HOP_BY_HOP.has(lower) ||
      lower === "host" ||
      lower === "authorization" ||
      lower === "origin" ||
      lower.startsWith("access-control-request-")
    ) continue
    result[name] = value
  }
  if (authorization) result.Authorization = authorization
  return result
}

function forwardResponseHeaders(upstream, response) {
  for (const [name, value] of Object.entries(upstream.headers)) {
    const lower = name.toLowerCase()
    if (value === undefined || HOP_BY_HOP.has(lower) || lower.startsWith("access-control-")) continue
    response.setHeader(name, value)
  }
}

function internalAuthorization(host) {
  if (!host.username && !host.password) return undefined
  return `Basic ${Buffer.from(`${host.username ?? ""}:${host.password ?? ""}`).toString("base64")}`
}

export function agentScopedRequest(request) {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
  const match = AGENT_ROUTE.exec(url.pathname)
  if (!match) return undefined
  return {
    agentID: decodeURIComponent(match[1]),
    path: match[2] || "/",
    search: url.search
  }
}

export function proxyManagedHttpRequest({
  request,
  response,
  route,
  host,
  requestImpl = http.request,
  timeoutMs = DEFAULT_PROXY_TIMEOUT_MS
}) {
  return new Promise((resolve, reject) => {
    let upstreamResponse
    let settled = false
    const streaming = STREAMING_PATHS.has(route.path)

    const finish = (error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve()
    }

    const upstream = requestImpl({
      host: host.readinessHost ?? host.host ?? "127.0.0.1",
      port: host.port,
      method: request.method,
      path: `${route.path}${route.search}`,
      headers: proxyHeaders(request.headers, internalAuthorization(host))
    }, (incoming) => {
      upstreamResponse = incoming
      forwardResponseHeaders(incoming, response)
      response.writeHead(incoming.statusCode ?? 502)
      incoming.pipe(response)
      incoming.once("end", () => finish())
      incoming.once("error", (error) => {
        upstream.destroy()
        finish(error)
      })
      incoming.once("aborted", () => {
        upstream.destroy()
        finish(new Error("Managed agent response was aborted"))
      })
    })

    const onClientClose = () => {
      upstreamResponse?.destroy()
      upstream.destroy()
      finish()
    }
    const cleanup = () => {
      request.off("aborted", onClientClose)
      response.off("close", onClientClose)
    }

    request.once("aborted", onClientClose)
    response.once("close", onClientClose)
    upstream.once("error", (error) => finish(error))
    if (!streaming && timeoutMs > 0) {
      upstream.setTimeout?.(timeoutMs, () => {
        upstream.destroy(new Error(`Managed agent request timed out after ${timeoutMs}ms`))
      })
    }
    request.pipe(upstream)
  })
}

export function createAgentRoutingServer({
  daemon,
  config,
  primaryAgentID,
  bridgeServer,
  createServer = http.createServer,
  proxyRequest = proxyManagedHttpRequest
}) {
  return createServer(async (request, response) => {
    const route = agentScopedRequest(request)
    if (!route) {
      bridgeServer.emit("request", request, response)
      return
    }

    if (route.agentID === primaryAgentID) {
      request.url = `${route.path}${route.search}`
      bridgeServer.emit("request", request, response)
      return
    }

    applyCorsHeaders(request, response, config)
    if (request.method === "OPTIONS") {
      response.writeHead(allowedOrigin(request, config) ? 204 : 403)
      response.end()
      return
    }
    if (!matchesCredentials(request, config)) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Harness Remote Daemon"' })
      response.end()
      return
    }

    const entry = daemon.hostEntry(route.agentID)
    if (!entry) {
      writeJSON(response, 404, { error: `Unknown agent: ${route.agentID}` })
      return
    }
    if (entry.kind !== "http") {
      writeJSON(response, 409, { error: `Agent ${route.agentID} is not routable through the managed HTTP proxy` })
      return
    }
    if (daemon.registry.host(route.agentID)?.state !== "available") {
      writeJSON(response, 503, { error: `Agent ${route.agentID} is unavailable` })
      return
    }

    try {
      await proxyRequest({ request, response, route, host: entry.host })
    } catch (error) {
      if (!response.headersSent) writeJSON(response, 502, { error: error instanceof Error ? error.message : String(error) })
      else response.destroy(error instanceof Error ? error : undefined)
    }
  })
}
