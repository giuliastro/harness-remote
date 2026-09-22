import http from "node:http"
import { allowedOrigin, applyCorsHeaders, matchesCredentials, writeJSON } from "./http-policy.js"
import { ManagedEventFanout } from "./managed-event-fanout.js"
import { inspectGitProjectIdentity } from "./project-identity.js"
import { inspectGitProjectOutcome } from "./project-outcome.js"
import { normalizeTaskModel } from "./task-model.js"
import { normalizeOpenCodeV2Response, openCodeApiBody, openCodeApiModelBody, openCodeApiPath } from "./opencode-compat.js"

const AGENT_ROUTE = /^\/v1\/agents\/([^/]+)(\/.*)?$/
const TASK_WORKTREE_ROUTE = /^\/v1\/tasks\/([^/]+)\/worktree$/
const MACHINE_ROUTES = new Set(["/v1/machine", "/global/machine", "/v1/projects", "/v1/project-identity", "/v1/project-outcome", "/v1/tasks", "/v1/diagnostics"])
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
// This is an inactivity watchdog for managed HTTP requests, not a model-turn wall clock. The old
// 15s value expired before Android's own 30s transport window and manufactured daemon-side 502s.
const DEFAULT_PROXY_TIMEOUT_MS = 30_000

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

async function readJSONBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) throw new Error("Request body is too large")
  }
  return body ? JSON.parse(body) : {}
}

function authenticateMachineRequest(request, response, config) {
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

function routedAgentForBackend(daemon, route, requestedBackend) {
  if (!requestedBackend) return route
  const routedHost = daemon.registry.host(route.agentID)
  if (routedHost?.backend === requestedBackend) return route
  const matching = daemon.snapshot().agents.find((agent) => agent.backend === requestedBackend)
  return matching ? { ...route, agentID: matching.id } : route
}

/**
 * The universal workspace reads a common detail shape for every native session. ACP profiles
 * deliberately advertise questions/permissions as unsupported, and the ACP bridge has no VCS
 * endpoint. Do not forward those known-unsupported optional reads just to manufacture a 404 every
 * poll. Empty data means "nothing exposed by this harness" while preserving real 404s for unknown
 * agents and for paths we have not explicitly normalized here.
 */
function unsupportedOptionalRead(daemon, route, method) {
  if (method !== "GET") return undefined
  const host = daemon.registry.host(route.agentID)
  if (!host) return undefined
  if (route.path === "/question" && host.capabilities?.questions === false) return []
  if (route.path === "/permission" && host.capabilities?.permissions === false) return []
  if (route.path === "/vcs" && daemon.hostEntry(route.agentID)?.kind === "acp") return {}
  return undefined
}

export function proxyManagedHttpRequest({
  request,
  response,
  route,
  host,
  requestImpl = http.request,
  timeoutMs = DEFAULT_PROXY_TIMEOUT_MS
}) {
  if (host.apiBasePath === "/api") {
    return proxyOpenCodeV2Request({ request, response, route, host, requestImpl, timeoutMs })
  }
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

async function readRequestBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

function requestOpenCodeV2({ requestImpl, host, method, pathname, search = "", headers, body, timeoutMs }) {
  const encodedBody = body === undefined ? undefined : Buffer.from(JSON.stringify(body))
  const upstreamHeaders = { ...headers }
  delete upstreamHeaders["content-length"]
  delete upstreamHeaders["Content-Length"]
  delete upstreamHeaders["accept-encoding"]
  delete upstreamHeaders["Accept-Encoding"]
  upstreamHeaders["Accept-Encoding"] = "identity"
  if (encodedBody) upstreamHeaders["Content-Length"] = String(encodedBody.length)

  return new Promise((resolve, reject) => {
    let settled = false
    let timer
    const finish = (error, result) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(result)
    }
    const upstream = requestImpl({
      host: host.readinessHost ?? host.host ?? "127.0.0.1",
      port: host.port,
      method,
      path: openCodeApiPath(host, pathname, search),
      headers: upstreamHeaders
    }, (incoming) => {
      const chunks = []
      incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)))
      incoming.once("error", (error) => {
        upstream.destroy()
        finish(error)
      })
      incoming.once("aborted", () => {
        upstream.destroy()
        finish(new Error("Managed agent response was aborted"))
      })
      incoming.once("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8")
        let payload
        try { payload = raw ? JSON.parse(raw) : undefined } catch { payload = raw }
        finish(undefined, { statusCode: incoming.statusCode ?? 502, payload })
      })
    })
    upstream.once("error", (error) => finish(error))
    if (timeoutMs > 0) {
      timer = setTimeout(() => upstream.destroy(new Error(`Managed agent request timed out after ${timeoutMs}ms`)), timeoutMs)
    }
    if (encodedBody) upstream.end(encodedBody)
    else upstream.end()
  })
}

async function proxyOpenCodeV2Request({ request, response, route, host, requestImpl, timeoutMs }) {
  // OpenCode v2 has no todo/action routes. The stable bridge contract treats these as optional
  // surfaces, so an empty collection keeps opening a valid native Session independent of v2.
  if (request.method === "GET" && (route.path.endsWith("/todo") || route.path.endsWith("/action"))) {
    response.writeHead(200, { "Content-Type": "application/json" })
    response.end("[]")
    return
  }

  const rawBody = request.method === "GET" || request.method === "HEAD" ? Buffer.alloc(0) : await readRequestBody(request)
  let body
  if (rawBody.length) {
    try { body = JSON.parse(rawBody.toString("utf8")) } catch { body = undefined }
  }
  const directory = new URLSearchParams(route.search).get("directory") || ""
  const headers = proxyHeaders(request.headers, internalAuthorization(host))
  const effectiveTimeoutMs = (route.path.endsWith("/prompt_async") || route.path.endsWith("/prompt"))
    ? Math.max(timeoutMs, 300_000)
    : timeoutMs

  // OpenCode v2 deliberately keeps model selection out of the prompt body. The stable bridge API
  // carries it with the prompt, so translate that one mutation into the native model endpoint
  // before delivering the text. A failed switch is returned to the client and the prompt is never
  // sent against the wrong model.
  const modelBody = openCodeApiModelBody(host, route.path, body)
  if (modelBody) {
    const sessionMatch = /^\/session\/([^/]+)\//.exec(route.path)
    if (sessionMatch) {
      const switched = await requestOpenCodeV2({
        requestImpl,
        host,
        method: "POST",
        pathname: `/session/${sessionMatch[1]}/model`,
        headers,
        body: modelBody,
        timeoutMs: effectiveTimeoutMs
      })
      if (switched.statusCode >= 400) {
        response.setHeader("Content-Type", "application/json")
        response.writeHead(switched.statusCode)
        response.end(switched.payload === undefined ? "" : JSON.stringify(switched.payload))
        return
      }
    }
  }

  const upstreamBody = openCodeApiBody(host, route.path, body, directory)
  const upstream = await requestOpenCodeV2({
    requestImpl,
    host,
    method: request.method,
    pathname: route.path,
    search: route.search,
    headers,
    body: upstreamBody,
    timeoutMs: effectiveTimeoutMs
  })
  const sessionMatch = /^\/session\/([^/]+)\/message(?:$|\?)/.exec(route.path)
  const normalized = upstream.statusCode < 400
    ? normalizeOpenCodeV2Response({
      pathname: route.path,
      payload: upstream.payload,
      statusCode: upstream.statusCode,
      directory,
      sessionID: sessionMatch ? decodeURIComponent(sessionMatch[1]) : undefined
    })
    : { payload: upstream.payload }
  const serialized = normalized.payload === undefined ? "" : JSON.stringify(normalized.payload)
  response.setHeader("Content-Type", "application/json")
  if (normalized.nextCursor) {
    response.setHeader("x-next-cursor", normalized.nextCursor)
    response.setHeader("x-has-more", "1")
  } else if (route.path.endsWith("/message")) {
    response.setHeader("x-has-more", "0")
  }
  response.writeHead(upstream.statusCode)
  response.end(serialized)
}

async function ensureManagedHttpAvailable(daemon, entry, agentID) {
  const state = daemon.registry.host(agentID)?.state
  if (state === "available") return { ok: true }
  // A failed lazy start is recoverable. `unavailable` must not become a permanent circuit breaker:
  // the next authenticated request is allowed to retry the idempotent managed-host start path.
  if (state !== "configured" && state !== "unavailable") return { ok: false }
  try {
    await entry.host.start?.()
  } catch (error) {
    return { ok: false, error }
  }
  return daemon.registry.host(agentID)?.state === "available"
    ? { ok: true }
    : { ok: false }
}

export function createAgentRoutingServer({
  daemon,
  config,
  primaryAgentID,
  bridgeServer,
  acpBridgeServer,
  taskStore,
  projectCatalog,
  projectIdentity = inspectGitProjectIdentity,
  projectOutcome = inspectGitProjectOutcome,
  worktreeManager,
  diagnostics,
  createServer = http.createServer,
  proxyRequest = proxyManagedHttpRequest
}) {
  const activeRequests = new Map()
  const eventFanouts = new Map()
  let nextRequestID = 1

  const routerDiagnostics = () => ({
    inFlightRequests: [...activeRequests.values()].map((entry) => ({
      ...entry,
      durationMs: Math.max(0, Date.now() - entry.startedAtEpoch)
    })).map(({ startedAtEpoch, ...entry }) => entry),
    eventStreams: Object.fromEntries([...eventFanouts.entries()].map(([key, fanout]) => [key, fanout.diagnostics()]))
  })

  const server = createServer(async (request, response) => {
    const requestURL = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    let trackedRequestID
    if (requestURL.pathname !== "/v1/diagnostics") {
      trackedRequestID = nextRequestID++
      activeRequests.set(trackedRequestID, {
        id: trackedRequestID,
        method: request.method ?? "GET",
        path: requestURL.pathname,
        startedAt: new Date().toISOString(),
        startedAtEpoch: Date.now()
      })
      let finished = false
      const finishTracking = () => {
        if (finished) return
        finished = true
        activeRequests.delete(trackedRequestID)
        response.off("finish", finishTracking)
        response.off("close", finishTracking)
      }
      response.once("finish", finishTracking)
      response.once("close", finishTracking)
    }

    const worktreeMatch = TASK_WORKTREE_ROUTE.exec(requestURL.pathname)
    if (MACHINE_ROUTES.has(requestURL.pathname) || worktreeMatch) {
      if (!authenticateMachineRequest(request, response, config)) return
      try {
        if (request.method === "GET" && (requestURL.pathname === "/v1/machine" || requestURL.pathname === "/global/machine")) {
          writeJSON(response, 200, daemon.snapshot())
          return
        }
        if (request.method === "GET" && requestURL.pathname === "/v1/diagnostics") {
          writeJSON(response, 200, {
            ...(typeof diagnostics === "function" ? diagnostics() : {}),
            router: routerDiagnostics()
          })
          return
        }
        if (request.method === "GET" && requestURL.pathname === "/v1/projects") {
          const projects = await projectCatalog()
          writeJSON(response, 200, { projects })
          return
        }
        if (request.method === "GET" && requestURL.pathname === "/v1/project-identity") {
          const projectId = requestURL.searchParams.get("projectId")?.trim() || ""
          if (!projectId) {
            writeJSON(response, 400, { error: "A projectId is required" })
            return
          }
          const projects = await projectCatalog()
          const project = projects.find((candidate) => candidate.id === projectId)
          if (!project) {
            writeJSON(response, 404, { error: `Unknown project: ${projectId}` })
            return
          }
          // Never accept a caller-supplied path here. Identity inspection is limited to a path that
          // the daemon itself already admitted into the canonical Project catalog.
          const identity = project.kind === "git" ? await projectIdentity(project.path) : null
          writeJSON(response, 200, { projectId: project.id, identity })
          return
        }
        if (request.method === "GET" && requestURL.pathname === "/v1/project-outcome") {
          const projectId = requestURL.searchParams.get("projectId")?.trim() || ""
          if (!projectId) {
            writeJSON(response, 400, { error: "A projectId is required" })
            return
          }
          const projects = await projectCatalog()
          const project = projects.find((candidate) => candidate.id === projectId)
          if (!project) {
            writeJSON(response, 404, { error: `Unknown project: ${projectId}` })
            return
          }
          // Outcome inspection has the same Project-scoped boundary as identity inspection: a caller
          // chooses only a catalog id, never a filesystem path. Returned file names stay repo-relative.
          const outcome = project.kind === "git" ? await projectOutcome(project.path) : null
          writeJSON(response, 200, { projectId: project.id, outcome })
          return
        }
        if (request.method === "GET" && requestURL.pathname === "/v1/tasks") {
          writeJSON(response, 200, { tasks: await taskStore.list() })
          return
        }
        if (request.method === "POST" && requestURL.pathname === "/v1/tasks") {
          const body = await readJSONBody(request)
          const projects = await projectCatalog()
          const project = projects.find((candidate) => candidate.id === body.projectId)
          if (!project) {
            writeJSON(response, 404, { error: `Unknown project: ${body.projectId ?? "missing"}` })
            return
          }
          const agentID = typeof body.agentId === "string" ? body.agentId : ""
          if (!agentID || !daemon.registry.host(agentID)) {
            writeJSON(response, 404, { error: `Unknown agent: ${agentID || "missing"}` })
            return
          }
          const prompt = typeof body.prompt === "string" ? body.prompt.trim() : ""
          if (!prompt) {
            writeJSON(response, 400, { error: "A task prompt is required" })
            return
          }
          const model = normalizeTaskModel(body.model)
          writeJSON(response, 201, await taskStore.create({ project, agentId: agentID, prompt, model }))
          return
        }
        if (request.method === "POST" && worktreeMatch) {
          const taskID = decodeURIComponent(worktreeMatch[1])
          const task = await taskStore.get(taskID)
          if (!task) {
            writeJSON(response, 404, { error: `Unknown task: ${taskID}` })
            return
          }
          const workspace = await worktreeManager.prepare(task)
          try {
            const updated = await taskStore.setWorkspace(taskID, workspace)
            writeJSON(response, 200, updated)
          } catch (error) {
            await worktreeManager.rollback(workspace)
            throw error
          }
          return
        }
        const allow = worktreeMatch ? "POST, OPTIONS" : requestURL.pathname === "/v1/tasks" ? "GET, POST, OPTIONS" : "GET, OPTIONS"
        response.writeHead(405, { Allow: allow })
        response.end()
      } catch (error) {
        writeJSON(response, 500, { error: error instanceof Error ? error.message : String(error) })
      }
      return
    }

    const requestedBackend = typeof request.headers["x-harness-backend"] === "string"
      ? request.headers["x-harness-backend"].trim()
      : ""
    let route = agentScopedRequest(request)
    if (!route) {
      const matching = requestedBackend && daemon.snapshot().agents.find((agent) => agent.backend === requestedBackend)
      if (matching && matching.id !== primaryAgentID) {
        route = { agentID: matching.id, path: requestURL.pathname, search: requestURL.search }
      } else {
        bridgeServer.emit("request", request, response)
        return
      }
    }
    route = routedAgentForBackend(daemon, route, requestedBackend)

    const optionalPayload = unsupportedOptionalRead(daemon, route, request.method)
    if (optionalPayload !== undefined) {
      if (!authenticateMachineRequest(request, response, config)) return
      writeJSON(response, 200, optionalPayload)
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
    if (entry.kind === "http") {
      const readiness = await ensureManagedHttpAvailable(daemon, entry, route.agentID)
      if (!readiness.ok) {
        const detail = readiness.error instanceof Error ? `: ${readiness.error.message}` : ""
        writeJSON(response, 503, { error: `Agent ${route.agentID} is unavailable${detail}` })
        return
      }
    }

    if (entry.kind === "acp") {
      const scopedServer = acpBridgeServer?.(route.agentID)
      if (!scopedServer) {
        writeJSON(response, 409, { error: `Agent ${route.agentID} is not routable through the machine daemon` })
        return
      }
      request.url = `${route.path}${route.search}`
      scopedServer.emit("request", request, response)
      return
    }

    if (request.method === "GET" && STREAMING_PATHS.has(route.path)) {
      const key = `${route.agentID}:${route.path}${route.search}`
      let fanout = eventFanouts.get(key)
      if (!fanout) {
        fanout = new ManagedEventFanout({
          host: entry.host,
          path: openCodeApiPath(entry.host, route.path, route.search),
          ensureAvailable: () => ensureManagedHttpAvailable(daemon, entry, route.agentID)
        })
        eventFanouts.set(key, fanout)
      }
      fanout.subscribe(request, response)
      return
    }

    try {
      await proxyRequest({ request, response, route, host: entry.host })
    } catch (error) {
      if (!response.headersSent) writeJSON(response, 502, { error: error instanceof Error ? error.message : String(error) })
      else response.destroy(error instanceof Error ? error : undefined)
    }
  })

  server.on("close", () => {
    for (const fanout of eventFanouts.values()) fanout.close()
    eventFanouts.clear()
  })
  return server
}
