import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { remoteMachineRequestUrl } from "./remoteMachine"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import { authHeader, baseUrl, hasCredentials, routingHeaders } from "./serverConfig"

export type NativeSessionStopStatus = "accepted" | "pending" | "uncertain"

type PendingNativeSessionStop = {
  clientRequestId: string
  operationToken: string
  createdAt: number
}

const STORAGE_PREFIX = "harness-remote.native-session-stop.v1"

function storageKey(target: NativeSessionSurfaceTarget): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(target.machineID)}:${encodeURIComponent(target.agentID)}:${encodeURIComponent(target.sessionID)}`
}

function requestID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `stop-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function loadPending(target: NativeSessionSurfaceTarget): PendingNativeSessionStop | null {
  try {
    const raw = localStorage.getItem(storageKey(target))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingNativeSessionStop>
    if (typeof parsed.clientRequestId !== "string" || !parsed.clientRequestId) return null
    if (typeof parsed.operationToken !== "string" || !parsed.operationToken) return null
    return {
      clientRequestId: parsed.clientRequestId,
      operationToken: parsed.operationToken,
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now()
    }
  } catch {
    return null
  }
}

function persistPending(target: NativeSessionSurfaceTarget, pending: PendingNativeSessionStop) {
  try { localStorage.setItem(storageKey(target), JSON.stringify(pending)) } catch {}
}

function clearPending(target: NativeSessionSurfaceTarget) {
  try { localStorage.removeItem(storageKey(target)) } catch {}
}

function parseStatus(data: unknown): NativeSessionStopStatus {
  if (data && typeof data === "object") {
    const value = (data as { status?: unknown }).status
    if (value === "accepted" || value === "pending" || value === "uncertain") return value
  }
  return "accepted"
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
 * Request cancellation of the current turn in the exact native Session.
 *
 * `operationToken` identifies the user turn being stopped. A lost HTTP response therefore retries
 * with the same client request id, while a later user turn gets a fresh id and cannot be swallowed by
 * an accepted Stop from the past. Accepted means the native cancellation primitive accepted the
 * request; the UI still reconciles the real Session status instead of inventing a terminal state.
 */
export async function stopNativeSession(
  target: NativeSessionSurfaceTarget,
  operationToken: string
): Promise<{ status: NativeSessionStopStatus; clientRequestId: string }> {
  const token = operationToken.trim()
  if (!token) throw new Error("Cannot stop this Session without an active turn identity")

  const existing = loadPending(target)
  const pending = existing?.operationToken === token
    ? existing
    : { clientRequestId: requestID(), operationToken: token, createdAt: Date.now() }
  persistPending(target, pending)

  const path = `/session/${encodeURIComponent(target.sessionID)}/stop`
  const body = {
    clientRequestId: pending.clientRequestId,
    directory: target.directory,
    operationToken: token
  }

  let status: NativeSessionStopStatus
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(target.config, { path, method: "POST", body })
    if (!result.ok) throw new Error(result.error.message)
    status = parseStatus(result.response.data)
  } else {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...routingHeaders(target.config, { preflight: !Capacitor.isNativePlatform() })
    }
    if (hasCredentials(target.config)) headers.Authorization = authHeader(target.config)
    const url = `${baseUrl(target.config)}${path}`

    if (Capacitor.isNativePlatform()) {
      let response
      try {
        response = target.config.remote ? await remoteMachineRequestUrl(target.config, url, { method: "POST", body, readTimeout: 30_000 })
          : await CapacitorHttp.request({
          url,
          method: "POST",
          headers,
          data: body,
          connectTimeout: 12_000,
          readTimeout: 30_000
        })
      } catch {
        throw new Error(`Cannot reach ${target.config.host}:${target.config.port}. Stop delivery status is unknown; retry will use the same request id.`)
      }
      if (response.status >= 400) throw new Error(errorDetail(response.data, response.status))
      status = parseStatus(response.data)
    } else {
      let response: Response
      try {
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
      } catch {
        throw new Error(`Cannot reach ${target.config.host}:${target.config.port}. Stop delivery status is unknown; retry will use the same request id.`)
      }
      let data: unknown = undefined
      try {
        const raw = await response.text()
        data = raw ? JSON.parse(raw) : undefined
      } catch {}
      if (!response.ok) throw new Error(errorDetail(data, response.status))
      status = parseStatus(data)
    }
  }

  if (status === "accepted") clearPending(target)
  return { status, clientRequestId: pending.clientRequestId }
}
