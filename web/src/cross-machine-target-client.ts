import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import type { NativeSessionRef, NativeSessionSurfaceTarget } from "./native-session-discovery"
import { normalizeModel, sameModel } from "./native-session-model"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { ModelSelection, ServerConfig } from "./types"

export type CrossMachineTargetStatus = "accepted" | "pending" | "uncertain"

export type CrossMachineTargetResult = {
  target: NativeSessionRef
  link?: unknown
}

type PendingCrossMachineTarget = {
  clientRequestId: string
  targetMachineID: string
  projectId: string
  targetAgentID: string
  title?: string
  model?: ModelSelection | null
  createdAt: number
}

const STORAGE_PREFIX = "harness-remote.cross-machine-target.v1"
const TARGET_ROUTE = "/v1/session-handoff-target"

function storageKey(source: NativeSessionSurfaceTarget): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(source.machineID)}:${encodeURIComponent(source.agentID)}:${encodeURIComponent(source.sessionID)}`
}

function requestID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `cross-machine-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function machineConfig(config: ServerConfig): ServerConfig {
  return { ...config, agentId: undefined }
}

function clearPending(source: NativeSessionSurfaceTarget) {
  try { localStorage.removeItem(storageKey(source)) } catch {}
}

function loadPending(source: NativeSessionSurfaceTarget): PendingCrossMachineTarget | null {
  try {
    const raw = localStorage.getItem(storageKey(source))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingCrossMachineTarget>
    if (typeof parsed.clientRequestId !== "string" || !parsed.clientRequestId) return null
    if (typeof parsed.targetMachineID !== "string" || !parsed.targetMachineID.trim()) return null
    if (typeof parsed.projectId !== "string" || !parsed.projectId.trim()) return null
    if (typeof parsed.targetAgentID !== "string" || !parsed.targetAgentID.trim()) return null
    return {
      clientRequestId: parsed.clientRequestId,
      targetMachineID: parsed.targetMachineID.trim(),
      projectId: parsed.projectId.trim(),
      targetAgentID: parsed.targetAgentID.trim(),
      title: typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : undefined,
      model: normalizeModel(parsed.model),
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now()
    }
  } catch {
    return null
  }
}

function persistPending(source: NativeSessionSurfaceTarget, pending: PendingCrossMachineTarget): boolean {
  try {
    localStorage.setItem(storageKey(source), JSON.stringify(pending))
    return true
  } catch {
    return false
  }
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

function responseData(value: unknown): { status: CrossMachineTargetStatus; clientRequestId?: string; result?: CrossMachineTargetResult } {
  if (!value || typeof value !== "object") return { status: "uncertain" }
  const body = value as { status?: unknown; clientRequestId?: unknown; result?: unknown }
  const status = body.status === "pending" || body.status === "uncertain" || body.status === "accepted"
    ? body.status
    : "uncertain"
  const clientRequestId = typeof body.clientRequestId === "string" && body.clientRequestId ? body.clientRequestId : undefined
  const candidate = body.result as CrossMachineTargetResult | undefined
  if (!candidate?.target?.machineID || !candidate.target.agentID || !candidate.target.sessionID || !candidate.target.directory) {
    return { status, clientRequestId }
  }
  return { status, clientRequestId, result: candidate }
}

/**
 * The target daemon creates one real native Session; the first prompt remains a separate recovery
 * domain. The creation id is persisted before network I/O and intentionally has no TTL. An accepted
 * result is acknowledged only after the caller has durably stored the returned target identity.
 *
 * No source authority is sent across this boundary. The request carries source identity, target
 * Project/harness/model metadata and nothing that can silently grant target-side writer permission.
 */
export async function createCrossMachineTargetSession({
  source,
  targetMachineID,
  targetConfig,
  projectId,
  targetAgentID,
  title,
  model
}: {
  source: NativeSessionSurfaceTarget
  targetMachineID: string
  targetConfig: ServerConfig
  projectId: string
  targetAgentID: string
  title?: string
  model?: ModelSelection | null
}): Promise<{ status: CrossMachineTargetStatus; clientRequestId: string; result?: CrossMachineTargetResult }> {
  const machineID = targetMachineID.trim()
  const project = projectId.trim()
  const agentID = targetAgentID.trim()
  if (!machineID || machineID === source.machineID) throw new Error("Choose a different target machine for this handoff.")
  if (!project) throw new Error("A verified target Project is required for cross-machine continuation.")
  if (!agentID) throw new Error("Choose a target coding agent for this handoff.")
  if (!source.directory) throw new Error("This Session has no project directory, so it cannot be handed off safely.")

  const normalizedTitle = title?.trim() || undefined
  const normalizedModel = normalizeModel(model)
  const existing = loadPending(source)
  if (existing && (
    existing.targetMachineID !== machineID
    || existing.projectId !== project
    || existing.targetAgentID !== agentID
    || (existing.title || "") !== (normalizedTitle || "")
    || !sameModel(existing.model, normalizedModel)
  )) {
    throw new Error("A previous cross-machine target creation is unresolved. Retry that exact machine, Project, harness and model before choosing another destination.")
  }

  const pending = existing ?? {
    clientRequestId: requestID(),
    targetMachineID: machineID,
    projectId: project,
    targetAgentID: agentID,
    title: normalizedTitle,
    model: normalizedModel,
    createdAt: Date.now()
  }
  if (!persistPending(source, pending)) {
    throw new Error("Cannot persist cross-machine handoff recovery state. No target Session was created.")
  }

  const config = machineConfig(targetConfig)
  const body = {
    clientRequestId: pending.clientRequestId,
    projectId: pending.projectId,
    targetAgentID: pending.targetAgentID,
    source: source.ref,
    title: pending.title,
    model: pending.model ? { providerID: pending.model.providerID, modelID: pending.model.modelID } : undefined,
    variant: pending.model?.variant || undefined
  }

  let parsed: { status: CrossMachineTargetStatus; clientRequestId?: string; result?: CrossMachineTargetResult }
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path: TARGET_ROUTE, method: "POST", body })
    if (!result.ok) {
      const status = Number(result.error.status)
      if (result.error.code === "http" && status >= 400 && status < 500) clearPending(source)
      throw new Error(result.error.message)
    }
    parsed = responseData(result.response.data)
  } else {
    const headers: Record<string, string> = { Accept: "application/json", "Content-Type": "application/json" }
    if (hasCredentials(config)) headers.Authorization = authHeader(config)
    const url = `${machineBaseUrl(config)}${TARGET_ROUTE}`

    if (Capacitor.isNativePlatform()) {
      let response
      try {
        response = await CapacitorHttp.request({
          url,
          method: "POST",
          headers,
          data: body,
          connectTimeout: 12_000,
          readTimeout: 30_000
        })
      } catch {
        throw new Error(`Cannot reach ${config.host}:${config.port}. Target creation status is unknown; retry will use the same request id.`)
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
        throw new Error(`Cannot reach ${config.host}:${config.port}. Target creation status is unknown; retry will use the same request id.`)
      }
      let data: unknown
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

  if (parsed.clientRequestId && parsed.clientRequestId !== pending.clientRequestId) {
    throw new Error("The target daemon returned a different handoff request id. Retry the original target instead of creating another Session.")
  }
  if (parsed.status === "accepted") {
    if (!parsed.result?.target) {
      throw new Error("The target daemon accepted creation without a recoverable native Session identity. Retry will use the same request id.")
    }
    if (parsed.result.target.machineID !== pending.targetMachineID || parsed.result.target.agentID !== pending.targetAgentID) {
      throw new Error("The target daemon returned a Session for a different machine or harness. Retry the original target instead of creating another Session.")
    }
  }

  return { status: parsed.status, clientRequestId: pending.clientRequestId, result: parsed.result }
}

/** Clear the creation key only after the caller durably records the exact accepted target identity. */
export function acknowledgeCrossMachineTargetSession(source: NativeSessionSurfaceTarget) {
  clearPending(source)
}
