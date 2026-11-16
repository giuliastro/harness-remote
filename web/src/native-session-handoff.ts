import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { remoteMachineRequestUrl } from "./remoteMachine"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import { normalizeModel, sameModel } from "./native-session-model"
import { authHeader, baseUrl, hasCredentials, routingHeaders } from "./serverConfig"
import type { ModelSelection } from "./types"

export type NativeSessionHandoffStatus = "accepted" | "pending" | "uncertain"

export type NativeSessionHandoffResult = {
  target: {
    machineID: string
    agentID: string
    sessionID: string
    directory: string
  }
  link?: unknown
}

type PendingNativeSessionHandoff = {
  clientRequestId: string
  targetAgentID: string
  title?: string
  model?: ModelSelection | null
  createdAt: number
}

const STORAGE_PREFIX = "harness-remote.native-session-handoff.v1"

function storageKey(source: NativeSessionSurfaceTarget): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(source.machineID)}:${encodeURIComponent(source.agentID)}:${encodeURIComponent(source.sessionID)}`
}

function requestID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `handoff-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function loadPending(source: NativeSessionSurfaceTarget): PendingNativeSessionHandoff | null {
  try {
    const raw = localStorage.getItem(storageKey(source))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingNativeSessionHandoff>
    if (typeof parsed.clientRequestId !== "string" || !parsed.clientRequestId) return null
    if (typeof parsed.targetAgentID !== "string" || !parsed.targetAgentID.trim()) return null
    return {
      clientRequestId: parsed.clientRequestId,
      targetAgentID: parsed.targetAgentID.trim(),
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined,
      model: normalizeModel(parsed.model),
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now()
    }
  } catch {
    return null
  }
}

function persistPending(source: NativeSessionSurfaceTarget, pending: PendingNativeSessionHandoff): boolean {
  try {
    localStorage.setItem(storageKey(source), JSON.stringify(pending))
    return true
  } catch {
    return false
  }
}

function clearPending(source: NativeSessionSurfaceTarget) {
  try { localStorage.removeItem(storageKey(source)) } catch {}
}

export function acknowledgeNativeSessionHandoff(source: NativeSessionSurfaceTarget) {
  clearPending(source)
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

function responseData(value: unknown): { status: NativeSessionHandoffStatus; result?: NativeSessionHandoffResult } {
  if (!value || typeof value !== "object") return { status: "accepted" }
  const body = value as { status?: unknown; result?: unknown }
  const status = body.status === "pending" || body.status === "uncertain" || body.status === "accepted"
    ? body.status
    : "accepted"
  const candidate = body.result as NativeSessionHandoffResult | undefined
  if (!candidate?.target?.agentID || !candidate.target.sessionID || !candidate.target.machineID) return { status }
  return { status, result: candidate }
}

/**
 * Create exactly one real native Session on another harness and link it to the source Session.
 *
 * The client request id is persisted before network I/O. A lost response or WebView reload therefore
 * retries the same semantic handoff instead of creating another target Session. Unlike prompt
 * delivery, resource creation has no blind TTL: forgetting this id after an ambiguous response can
 * create a second real native Session. A definite 4xx refusal releases it immediately; an accepted
 * result is acknowledged only by the caller after the returned target ref has itself been persisted.
 */
export async function handoffNativeSession(
  source: NativeSessionSurfaceTarget,
  targetAgentID: string,
  title?: string,
  model?: ModelSelection | null
): Promise<{ status: NativeSessionHandoffStatus; clientRequestId: string; result?: NativeSessionHandoffResult }> {
  const target = targetAgentID.trim()
  if (!target || target === source.agentID) throw new Error("Choose a different coding agent for this handoff.")
  if (!source.directory) throw new Error("This Session has no project directory, so it cannot be handed off safely.")
  const normalizedTitle = title?.trim() || undefined
  const normalizedModel = normalizeModel(model)

  const existing = loadPending(source)
  if (existing && (
    existing.targetAgentID !== target
    || (existing.title || "") !== (normalizedTitle || "")
    || !sameModel(existing.model, normalizedModel)
  )) {
    throw new Error("A previous handoff still has an unresolved delivery status. Retry that exact target and model before choosing another destination.")
  }
  const pending = existing ?? {
    clientRequestId: requestID(),
    targetAgentID: target,
    title: normalizedTitle,
    model: normalizedModel,
    createdAt: Date.now()
  }
  if (!persistPending(source, pending)) {
    throw new Error("Cannot persist Session handoff recovery state. No target Session was created.")
  }

  const path = `/session/${encodeURIComponent(source.sessionID)}/handoff`
  const body = {
    clientRequestId: pending.clientRequestId,
    directory: source.directory,
    targetAgentID: pending.targetAgentID,
    title: pending.title,
    model: pending.model ? { providerID: pending.model.providerID, modelID: pending.model.modelID } : undefined,
    variant: pending.model?.variant || undefined
  }

  let parsed: { status: NativeSessionHandoffStatus; result?: NativeSessionHandoffResult }
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(source.config, { path, method: "POST", body })
    if (!result.ok) {
      const status = Number(result.error.status)
      if (result.error.code === "http" && status >= 400 && status < 500) clearPending(source)
      throw new Error(result.error.message)
    }
    parsed = responseData(result.response.data)
  } else {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Content-Type": "application/json",
      ...routingHeaders(source.config, { preflight: !Capacitor.isNativePlatform() })
    }
    if (hasCredentials(source.config)) headers.Authorization = authHeader(source.config)
    const url = `${baseUrl(source.config)}${path}`

    if (Capacitor.isNativePlatform()) {
      let response
      try {
        response = source.config.remote ? await remoteMachineRequestUrl(source.config, url, { method: "POST", body, readTimeout: 30_000 })
          : await CapacitorHttp.request({
          url,
          method: "POST",
          headers,
          data: body,
          connectTimeout: 12_000,
          readTimeout: 30_000
        })
      } catch {
        throw new Error(`Cannot reach ${source.config.host}:${source.config.port}. Handoff delivery status is unknown; retry will use the same request id.`)
      }
      if (response.status >= 400) {
        if (response.status < 500) clearPending(source)
        throw new Error(errorDetail(response.data, response.status))
      }
      parsed = responseData(response.data)
    } else {
      let response: Response
      try {
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
      } catch {
        throw new Error(`Cannot reach ${source.config.host}:${source.config.port}. Handoff delivery status is unknown; retry will use the same request id.`)
      }
      let data: unknown = undefined
      try {
        const raw = await response.text()
        data = raw ? JSON.parse(raw) : undefined
      } catch {}
      if (!response.ok) {
        if (response.status < 500) clearPending(source)
        throw new Error(errorDetail(data, response.status))
      }
      parsed = responseData(data)
    }
  }

  return { ...parsed, clientRequestId: pending.clientRequestId }
}
