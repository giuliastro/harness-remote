import http from "node:http"
import { timingSafeEqual } from "node:crypto"
import { readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { AcpService } from "./acp-service.js"
import { harnessProfile } from "./harness-profiles.js"


function writeJSON(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" })
  response.end(JSON.stringify(body))
}

/** Returns the request origin when it is explicitly allowed by --cors. */
function allowedOrigin(request, config) {
  const origin = request.headers.origin
  if (!origin || !config.corsOrigins?.length) return undefined
  return config.corsOrigins.includes(origin) ? origin : undefined
}

/**
 * Credentialed CORS forbids a wildcard origin, so each allowed origin is echoed
 * back individually and responses are marked as origin-dependent for caches.
 */
function applyCorsHeaders(request, response, config) {
  if (!config.corsOrigins?.length) return
  response.setHeader("Vary", "Origin")
  const origin = allowedOrigin(request, config)
  if (!origin) return
  response.setHeader("Access-Control-Allow-Origin", origin)
  response.setHeader("Access-Control-Allow-Credentials", "true")
  response.setHeader("Access-Control-Allow-Headers", "authorization, content-type")
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
}

function matchesCredentials(request, config) {
  if (!config.username) return true
  const header = request.headers.authorization
  if (!header?.startsWith("Basic ")) return false
  const expected = Buffer.from(`${config.username}:${config.password}`)
  const received = Buffer.from(header.slice("Basic ".length), "base64")
  return received.length === expected.length && timingSafeEqual(received, expected)
}

async function readBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 1_000_000) throw new Error("Request body is too large")
  }
  return body ? JSON.parse(body) : {}
}

function writeSSE(response, event, data) {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

async function allowedDirectory(candidate, config) {
  const resolved = await realpath(candidate)
  const roots = await Promise.all((config.roots.length ? config.roots : [process.cwd()]).map((root) => realpath(root)))
  if (!roots.some((root) => resolved === root || !path.relative(root, resolved).startsWith(`..${path.sep}`) && path.relative(root, resolved) !== "..")) {
    throw new Error("Directory is outside the configured --root boundary")
  }
  return resolved
}

function modelWireName(model) {
  if (!model) return undefined
  const modelID = model.modelID ?? model.id
  return model.providerID && modelID ? `${model.providerID}/${modelID}` : undefined
}

function providersResponse(models) {
  const providers = new Map()
  const defaults = {}
  for (const option of models) {
    const [providerID, ...modelParts] = option.value.split("/")
    const modelID = modelParts.join("/")
    if (!providerID || !modelID) continue
    const provider = providers.get(providerID) ?? { id: providerID, name: providerID, models: {} }
    provider.models[modelID] = { id: modelID, name: option.name ?? modelID, status: "active" }
    providers.set(providerID, provider)
    if (option.currentValue) defaults[providerID] = modelID
  }
  return { providers: [...providers.values()], default: defaults }
}

export function createBridgeServer({ config, acp, serviceOptions }) {
  const backend = config.backend ?? "omp"
  const profile = harnessProfile(backend)
  const service = new AcpService(acp, serviceOptions)
  return http.createServer(async (request, response) => {
    applyCorsHeaders(request, response, config)
    // Browsers omit credentials on the preflight, so it must be answered before auth.
    if (request.method === "OPTIONS") {
      response.writeHead(allowedOrigin(request, config) ? 204 : 403)
      response.end()
      return
    }
    if (!matchesCredentials(request, config)) {
      response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Harness Remote Bridge"' })
      response.end()
      return
    }

    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const directory = url.searchParams.get("directory") || undefined
    if (config.logRequests && url.pathname === "/config/providers") {
      process.stderr.write(`[bridge] ${request.method} ${url.pathname}${url.search}\n`)
    }
    try {
      if (request.method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/global/health")) {
        await acp.start()
        writeJSON(response, 200, { healthy: true, backend, version: acp.agentInfo?.version ?? "unknown" })
        return
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        writeJSON(response, 200, profile.capabilities)
        return
      }
      if (request.method === "GET" && (url.pathname === "/v1/events" || url.pathname === "/global/event")) {
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive"
        })
        response.write(": connected\n\n")
        const unsubscribe = service.subscribe((event) => writeSSE(response, event.type, event))
        // Clients treat a long silence as a dead connection, because a TCP stream can die
        // without ever delivering an error. OpenCode beats every 10s; without matching it an
        // idle session looks broken and the client reconnects on a loop.
        const heartbeat = setInterval(() => response.write(": ping\n\n"), config.heartbeatMs ?? 10_000)
        heartbeat.unref?.()
        request.on("close", () => {
          clearInterval(heartbeat)
          unsubscribe()
        })
        return
      }
      if (request.method === "GET" && (url.pathname === "/v1/sessions" || url.pathname === "/session" || url.pathname === "/experimental/session")) {
        writeJSON(response, 200, await service.listSessions(directory))
        return
      }
      if (request.method === "GET" && url.pathname === "/session/status") {
        const statuses = Object.fromEntries((await service.listSessions(directory)).map((session) => [session.id, service.status(session.id)]))
        writeJSON(response, 200, statuses)
        return
      }
      if (request.method === "GET" && url.pathname === "/path") {
        const selected = await allowedDirectory(directory ?? config.roots[0] ?? process.cwd(), config)
        writeJSON(response, 200, { home: selected, state: "", config: "", worktree: selected, directory: selected })
        return
      }
      if (request.method === "GET" && url.pathname === "/file") {
        const selected = await allowedDirectory(url.searchParams.get("path") ?? config.roots[0] ?? process.cwd(), config)
        const entries = await readdir(selected, { withFileTypes: true })
        writeJSON(response, 200, entries.map((entry) => ({
          name: entry.name,
          path: path.join(selected, entry.name),
          absolute: path.join(selected, entry.name),
          type: entry.isDirectory() ? "directory" : "file",
          ignored: false
        })))
        return
      }
      if (request.method === "POST" && url.pathname === "/session") {
        const body = await readBody(request)
        const selected = await allowedDirectory(directory ?? config.roots[0] ?? process.cwd(), config)
        const created = await service.createSession({ directory: selected, title: body.title, model: modelWireName(body.model) })
        writeJSON(response, 200, created)
        return
      }

      const sessionMatch = /^\/session\/([^/]+)(?:\/(message|prompt_async|abort|todo|diff))?$/.exec(url.pathname)
      if (sessionMatch) {
        const [, sessionID, operation] = sessionMatch
        if (request.method === "GET" && operation === "message") {
          writeJSON(response, 200, await service.messages(sessionID, url.searchParams.get("refresh") === "1"))
          return
        }
        if (request.method === "GET" && operation === "todo") {
          writeJSON(response, 200, await service.todos(sessionID))
          return
        }
        if (request.method === "GET" && operation === "diff") {
          writeJSON(response, 200, [])
          return
        }
        if (request.method === "POST" && operation === "prompt_async") {
          const body = await readBody(request)
          const text = body.parts?.find((part) => part.type === "text")?.text
          if (!text) throw new Error("A text prompt is required")
          await service.prompt(sessionID, text, modelWireName(body.model))
          writeJSON(response, 200, true)
          return
        }
        if (request.method === "POST" && operation === "abort") {
          service.abort(sessionID)
          writeJSON(response, 200, true)
          return
        }
      }
      if (request.method === "GET" && url.pathname === "/command") {
        writeJSON(response, 200, [])
        return
      }
      if (request.method === "GET" && url.pathname === "/agent") {
        writeJSON(response, 200, [])
        return
      }
      if (request.method === "GET" && url.pathname === "/config/providers") {
        const sessionID = url.searchParams.get("sessionID")
        if (!sessionID) {
          writeJSON(response, 200, { providers: [], default: {} })
          return
        }
        writeJSON(response, 200, providersResponse(await service.models(sessionID)))
        return
      }
      writeJSON(response, 404, { error: "Not found" })
    } catch (error) {
      writeJSON(response, 400, { error: error instanceof Error ? error.message : "Request failed" })
    }
  })
}
