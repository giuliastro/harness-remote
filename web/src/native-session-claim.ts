import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { remoteMachineRequestUrl } from "./remoteMachine"
import { desktopRequest, isDesktopPlatform } from "./desktopBridge"
import { authHeader, baseUrl, hasCredentials, routingHeaders } from "./serverConfig"
import type { ServerConfig } from "./types"

export type NativeSessionClaimTransport = {
  claimSession(config: ServerConfig, directory: string, sessionID: string): Promise<void>
}

function errorDetail(body: unknown, status: number): string {
  if (typeof body === "string") {
    try { return errorDetail(JSON.parse(body), status) }
    catch { return body || `HTTP ${status}` }
  }
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return (body as { error: string }).error
  }
  return `HTTP ${status}`
}

/**
 * Explicit transport boundary for taking over the writer of an existing native ACP Session.
 *
 * Machine daemons expose POST /session/:id/claim in the selected agent scope. The bridge may still
 * implement that claim with its proven ACP session/load machinery internally, but model discovery is
 * no longer part of this product or transport contract. A native writer-lock rejection propagates
 * unchanged so the Session remains observable instead of being replaced or silently stolen.
 */
export const nativeSessionClaimTransport: NativeSessionClaimTransport = {
  async claimSession(config, _directory, sessionID) {
    const path = `/session/${encodeURIComponent(sessionID)}/claim`

    if (isDesktopPlatform()) {
      await desktopRequest(config, { path, method: "POST", body: {} })
      return
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...routingHeaders(config, { preflight: !Capacitor.isNativePlatform() })
    }
    if (hasCredentials(config)) headers.Authorization = authHeader(config)
    const url = `${baseUrl(config)}${path}`

    if (Capacitor.isNativePlatform()) {
      let response
      try {
        response = config.remote ? await remoteMachineRequestUrl(config, url, { method: "POST", body: {}, readTimeout: 30_000 })
          : await CapacitorHttp.request({
          url,
          method: "POST",
          headers,
          data: {},
          connectTimeout: 12_000,
          readTimeout: 30_000
        })
      } catch {
        throw new Error(`Cannot reach ${config.host}:${config.port}.`)
      }
      if (response.status >= 400) throw new Error(errorDetail(response.data, response.status))
      return
    }

    let response: Response
    try {
      response = await fetch(url, { method: "POST", headers, body: "{}" })
    } catch {
      throw new Error(`Cannot reach ${config.host}:${config.port}.`)
    }
    if (!response.ok) {
      let body = ""
      try { body = await response.text() } catch {}
      throw new Error(errorDetail(body, response.status))
    }
  }
}
