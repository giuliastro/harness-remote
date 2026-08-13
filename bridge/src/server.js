import http from "node:http"
import { readdir, realpath } from "node:fs/promises"
import path from "node:path"
import { AcpService } from "./acp-service.js"
import { harnessProfile } from "./harness-profiles.js"
import { allowedOrigin, applyCorsHeaders, matchesCredentials, writeJSON } from "./http-policy.js"

const ATTACHMENT_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"])
const MAX_ATTACHMENTS = 8
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
const MAX_ATTACHMENT_TOTAL_BYTES = 15 * 1024 * 1024

/** base64 carries 3 bytes per 4 characters, so measure it rather than decoding megabytes to count them. */
function base64ByteLength(value) {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0
  return Math.floor(value.length / 4) * 3 - padding
}

function attachmentPayload(url) {
  const match = typeof url === "string" ? /^data:[^;,]+;base64,(.+)$/s.exec(url) : null
  if (!match) throw new Error("An attachment must be a base64 data URL")
  return match[1]
}

/**
 * Attachments are validated before the prompt reaches the agent: a mime type the harness
 * cannot read, or a payload large enough to stall the turn, is a client mistake worth
 * naming rather than a failure to discover mid-stream.
 */
function parseAttachments(parts) {
  const files = (Array.isArray(parts) ? parts : []).filter((part) => part?.type === "file")
  if (files.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per prompt`)
  let total = 0
  return files.map((file) => {
    const mime = typeof file.mime === "string" ? file.mime.toLowerCase() : ""
    if (!ATTACHMENT_MIME_TYPES.has(mime)) {
      throw new Error(`Unsupported attachment type ${mime || "unknown"}: accepted types are image/png, image/jpeg, image/webp and image/gif`)
    }
    const data = attachmentPayload(file.url)
    if (base64ByteLength(data) > MAX_ATTACHMENT_BYTES) throw new Error("Each attachment must stay under 5MB")
    total += base64ByteLength(data)
    if (total > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error("Attachments must stay under 15MB in total")
    return { mime, filename: typeof file.filename === "string" ? file.filename : "attachment", data }
  })
}

async function readBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (body.length > 25_000_000) throw new Error("Request body is too large")
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

/**
 * The app's model API is OpenCode's, which names a model `provider/model`. ACP has no such rule:
 * OMP and PI happen to use that shape, while Claude Code's adapter offers bare ids — `sonnet`,
 * `opus[1m]`. Splitting on "/" and requiring both halves silently dropped every one of them, which
 * is why that backend looked like it exposed no models at all.
 *
 * A bare id is presented under the backend's own name instead, so it reads and behaves like the
 * others — `claude/sonnet`. `AcpService.setModel` puts it back to the id the agent knows.
 */
function providersResponse(models, fallbackProviderID) {
  const providers = new Map()
  const defaults = {}
  for (const option of models) {
    const separator = option.value.indexOf("/")
    const flat = separator <= 0
    const providerID = flat ? fallbackProviderID : option.value.slice(0, separator)
    const modelID = flat ? option.value : option.value.slice(separator + 1)
    if (!providerID || !modelID) continue
    const provider = providers.get(providerID) ?? { id: providerID, name: providerID, models: {} }
    provider.models[modelID] = {
      id: modelID,
      name: option.name ?? modelID,
      description: option.description || undefined,
      status: "active"
    }
    providers.set(providerID, provider)
    if (option.currentValue) defaults[providerID] = modelID
  }
  return { providers: [...providers.values()], default: defaults }
}

export function createBridgeServer({ config, acp, serviceOptions, machineRegistry }) {
  const backend = config.backend ?? "omp"
  const profile = harnessProfile(backend)
  const service = new AcpService(acp, { ...serviceOptions, actionProviders: profile.actionProviders })
  return http.createServer(async (request, response) => {
    applyCorsHeaders(request, response, config)
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
    if (config.logRequests && url.pathname === "/config/providers") process.stderr.write(`[bridge] ${request.method} ${url.pathname}${url.search}\n`)
    try {
      if (request.method === "GET" && (url.pathname === "/v1/machine" || url.pathname === "/global/machine")) {
        if (!machineRegistry) {
          writeJSON(response, 503, { error: "Machine registry is not configured" })
          return
        }
        writeJSON(response, 200, machineRegistry.snapshot())
        return
      }
      if (request.method === "GET" && (url.pathname === "/v1/health" || url.pathname === "/global/health")) {
        await acp.start()
        writeJSON(response, 200, { healthy: true, backend, version: acp.agentInfo?.version ?? "unknown" })
        return
      }
      if (request.method === "GET" && url.pathname === "/v1/capabilities") {
        await acp.start()
        writeJSON(response, 200, { ...profile.capabilities, attachments: Boolean(acp.promptCapabilities?.image) })
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

      const sessionMatch = /^\/session\/([^/]+)(?:\/(message|prompt_async|abort|todo|diff|action|command)(?:\/([^/]+))?)?$/.exec(url.pathname)
      if (sessionMatch) {
        const [, sessionID, operation, actionID] = sessionMatch
        if (request.method === "PATCH" && !operation) {
          const body = await readBody(request)
          writeJSON(response, 200, await service.renameSession(sessionID, typeof body.title === "string" ? body.title : ""))
          return
        }
        if (request.method === "DELETE" && !operation) {
          await service.deleteSession(sessionID)
          writeJSON(response, 200, true)
          return
        }
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
        if (request.method === "GET" && operation === "action" && !actionID) {
          writeJSON(response, 200, await service.actions(sessionID))
          return
        }
        if (request.method === "POST" && operation === "action" && actionID) {
          writeJSON(response, 200, await service.invokeAction(sessionID, actionID))
          return
        }
        if (request.method === "POST" && operation === "prompt_async") {
          const body = await readBody(request)
          const text = body.parts?.find((part) => part.type === "text")?.text ?? ""
          const attachments = parseAttachments(body.parts)
          if (!text && !attachments.length) throw new Error("A text prompt is required")
          await service.prompt(sessionID, text, modelWireName(body.model), attachments)
          writeJSON(response, 200, true)
          return
        }
        if (request.method === "POST" && operation === "command") {
          const body = await readBody(request)
          if (typeof body.command !== "string" || !body.command) throw new Error("A command name is required")
          const argumentsText = typeof body.arguments === "string" ? body.arguments.trim() : ""
          const text = argumentsText ? `/${body.command} ${argumentsText}` : `/${body.command}`
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
        writeJSON(response, 200, await service.commands(url.searchParams.get("sessionID") ?? undefined))
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
        writeJSON(response, 200, providersResponse(await service.models(sessionID), backend))
        return
      }
      writeJSON(response, 404, { error: "Not found" })
    } catch (error) {
      writeJSON(response, 400, { error: error instanceof Error ? error.message : "Request failed" })
    }
  })
}
