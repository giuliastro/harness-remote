import http from "node:http"
import { authenticateDaemonRequest, guardRequestHandler, writeJSON } from "../http-policy.js"

const PLUGIN_ROUTE = /^\/v1\/plugins(?:\/([a-z0-9][a-z0-9-]{0,63}))?(?:\/(install|update|uninstall|enable|disable|settings))?$/
const PLUGIN_ACTION_ROUTE = /^\/v1\/plugins\/([a-z0-9][a-z0-9-]{0,63})\/actions\/([a-z0-9][a-z0-9-]{0,63})$/
const MAX_BODY_BYTES = 128 * 1024

function requestError(message) {
  const error = new Error(message)
  error.code = "invalid_request"
  return error
}

async function readJSONBody(request) {
  let body = ""
  for await (const chunk of request) {
    body += chunk
    if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) throw requestError("Plugin request is too large")
  }
  if (!body) return {}
  try { return JSON.parse(body) } catch { throw requestError("Plugin request must be valid JSON") }
}

function statusForError(error) {
  if (error?.code === "invalid_request") return 400
  if (error?.code === "unknown_plugin") return 404
  if (error?.code === "plugin_not_ready" || error?.code === "plugin_disabled") return 409
  if (error?.code === "plugin_timeout" || error?.code === "plugin_closed") return 503
  return 500
}

function errorDetail(error) {
  if (error instanceof Error && error.message) return error.message.slice(0, 2_000)
  return "Plugin request failed"
}

/**
 * The plugin control plane. It wraps the machine daemon at the outermost layer so the control-plane
 * routes are reachable before any agent-scoped routing, and delegates every other path untouched.
 * Plugin identity, installation and settings remain machine-local; no plugin state is written into a
 * Session snapshot or shared across machines.
 */
export function createPluginServer({ innerServer, config, pluginHost, createServer = http.createServer }) {
  return createServer(guardRequestHandler(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const actionMatch = PLUGIN_ACTION_ROUTE.exec(url.pathname)
    const match = actionMatch ? null : PLUGIN_ROUTE.exec(url.pathname)
    if (!match && !actionMatch) {
      innerServer.emit("request", request, response)
      return
    }

    if (!authenticateDaemonRequest(request, response, config)) return

    try {
      if (!pluginHost) throw Object.assign(new Error("Plugin host is not configured"), { code: "plugin_unavailable" })
      if (actionMatch) {
        if (request.method !== "POST") {
          response.writeHead(405, { Allow: "POST, OPTIONS" })
          response.end()
          return
        }
        const body = await readJSONBody(request)
        writeJSON(response, 200, await pluginHost.runAction(actionMatch[1], actionMatch[2], body))
        return
      }
      const [, rawID, action] = match
      if (!rawID) {
        if (request.method !== "GET") {
          response.writeHead(405, { Allow: "GET, OPTIONS" })
          response.end()
          return
        }
        writeJSON(response, 200, await pluginHost.list({ refresh: url.searchParams.get("refresh") === "1" }))
        return
      }

      if (!action) {
        if (request.method !== "GET") {
          response.writeHead(405, { Allow: "GET, OPTIONS" })
          response.end()
          return
        }
        writeJSON(response, 200, { plugin: await pluginHost.detail(rawID, { refresh: url.searchParams.get("refresh") === "1" }) })
        return
      }

      if (action === "settings") {
        if (request.method !== "PATCH" && request.method !== "POST") {
          response.writeHead(405, { Allow: "PATCH, POST, OPTIONS" })
          response.end()
          return
        }
        const body = await readJSONBody(request)
        if (!body || typeof body !== "object" || Array.isArray(body) || !body.values || typeof body.values !== "object" || Array.isArray(body.values)) {
          throw requestError("Plugin settings require a values object")
        }
        writeJSON(response, 200, await pluginHost.configure(rawID, body.values))
        return
      }

      if (request.method !== "POST") {
        response.writeHead(405, { Allow: "POST, OPTIONS" })
        response.end()
        return
      }
      const result = action === "install"
        ? await pluginHost.install(rawID)
        : action === "update"
          ? await pluginHost.update(rawID)
          : action === "uninstall"
            ? await pluginHost.uninstall(rawID)
            : action === "enable"
              ? await pluginHost.enable(rawID)
              : await pluginHost.disable(rawID)
      writeJSON(response, 200, result)
    } catch (error) {
      if (error?.code === "plugin_unavailable") {
        writeJSON(response, 503, { error: errorDetail(error) })
        return
      }
      writeJSON(response, statusForError(error), {
        error: errorDetail(error),
        ...(error?.code ? { code: error.code } : {})
      })
    }
  }))
}
