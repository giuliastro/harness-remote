import http from "node:http"
import { authenticateDaemonRequest, guardRequestHandler, writeJSON } from "./http-policy.js"

export const REMOTE_DEVICES_ROUTE = "/v1/remote/devices"
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * Authenticated control-plane endpoints for inspecting and revoking paired devices.
 * The wrapper owns only this route family; everything else stays with the existing server stack.
 */
export function createRemoteDeviceManagementServer({ innerServer, config, registry, createServer = http.createServer }) {
  if (!innerServer?.emit || !registry?.list || !registry?.revoke) {
    throw new Error("Remote device management requires an inner server and paired-device registry")
  }
  return createServer(guardRequestHandler(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    const pathname = url.pathname
    const isListRoute = pathname === REMOTE_DEVICES_ROUTE
    const isDeviceRoute = pathname.startsWith(`${REMOTE_DEVICES_ROUTE}/`)
    if (!isListRoute && !isDeviceRoute) {
      innerServer.emit("request", request, response)
      return
    }

    if (!authenticateDaemonRequest(request, response, config)) return

    if (isListRoute) {
      if (request.method !== "GET") {
        response.writeHead(405, { Allow: "GET, OPTIONS" })
        response.end()
        return
      }
      const devices = registry.list().map(({ publicKey: _publicKey, ...device }) => device)
      writeJSON(response, 200, { devices })
      return
    }

    const encodedID = pathname.slice(REMOTE_DEVICES_ROUTE.length + 1)
    let id
    try { id = decodeURIComponent(encodedID) } catch { id = "" }
    if (!DEVICE_ID_PATTERN.test(id)) {
      writeJSON(response, 400, { error: "Invalid device ID" })
      return
    }
    if (request.method !== "DELETE") {
      response.writeHead(405, { Allow: "DELETE, OPTIONS" })
      response.end()
      return
    }
    const revoked = await registry.revoke(id)
    if (!revoked) {
      writeJSON(response, 404, { error: "Paired device not found" })
      return
    }
    writeJSON(response, 200, { revoked: true })
  }))
}
