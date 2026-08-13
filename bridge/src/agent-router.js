import http from "node:http"
import { timingSafeEqual } from "node:crypto"

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

function allowedOrigin(request, config) {
  const origin = request.headers.origin
  if (!origin || !config.corsOrigins?.length) return undefined
  return config.corsOrigins.includes(origin) ? origin : undefined
}

function applyCorsHeaders(request, response, config) {
  if (!config.corsOrigins?.length) return
  response.setHeader("Vary", "Origin")
  const origin = allowedOrigin(request, config)
  if (!origin) return
  response.setHeader("Access-Control-Allow-Origin", origin)
  response.setHeader("Access-Control-Allow-Credentials", "true")
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type")
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
  if (request.headers["access-control-request-private-network"] === "true") {
    response.setHeader("Access-Control-Allow-Private-Network", "true")
  }
}

function matchesCredentials(request, config) {
  if (!config.username) return true
  const header = request.headers.authorization
  if (!header?.startsWith("Basic ")) return false
  const expected = Buffer.from(`${config.username}:${config.password}`)
  const received = Buffer.from(header.slice("Basic ".length), "base64")
  return received.length === expected.length && timingSafeEqual(received, expected)
}

function writeJSON(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  response.end(JSON.stringify(body))
}

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

export function proxyManagedHttpRequest({ request, response, route, host, requestImpl = http.request }) {
  return new Promise((resolve, reject) => {
    const upstream = requestImpl({
      host: host.readinessHost ?? host.host ?? "127.0.0.1",
      port: host.port,
      method: request.method,
      path: `${route.path}${route.search}`,
      headers: proxyHeaders(request.headers, internalAuthorization(host))
    }, (upstreamResponse) => {
      forwardResponseHeaders(upstreamResponse, response)
      response.writeHead(upstreamResponse.statusCode ?? 502)
      upstreamResponse.pipe(response)
      upstreamResponse.once("end", resolve)
    })
    upstream.once("error", reject)
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
