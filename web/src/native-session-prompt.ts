import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import { authHeader, baseUrl, hasCredentials, routingHeaders } from "./serverConfig"
import type { MessageEnvelope, ModelSelection } from "./types"

export type NativeSessionPromptStatus = "accepted" | "pending" | "uncertain"

export type PendingNativeSessionPrompt = {
  clientRequestId: string
  text: string
  wireText?: string
  model?: ModelSelection | null
  createdAt: number
}

const STORAGE_PREFIX = "harness-remote.native-session-prompt.v1"
const PENDING_DELIVERY_TTL_MS = 10 * 60 * 1000
const HANDOFF_SENT_PREFIX = "harness-remote.native-session-handoff-context.v1"
const HANDOFF_CONTEXT_MAX_CHARS = 12_000
const HANDOFF_MESSAGE_MAX_CHARS = 1_500
const HANDOFF_MESSAGE_LIMIT = 16

function storageKey(target: NativeSessionSurfaceTarget): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(target.machineID)}:${encodeURIComponent(target.agentID)}:${encodeURIComponent(target.sessionID)}`
}

function handoffSentKey(target: NativeSessionSurfaceTarget): string {
  return `${HANDOFF_SENT_PREFIX}:${encodeURIComponent(target.machineID)}:${encodeURIComponent(target.agentID)}:${encodeURIComponent(target.sessionID)}`
}

function requestID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID()
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function normalizeModel(value: unknown): ModelSelection | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as Partial<ModelSelection>
  const providerID = typeof candidate.providerID === "string" ? candidate.providerID.trim() : ""
  const modelID = typeof candidate.modelID === "string" ? candidate.modelID.trim() : ""
  if (!providerID || !modelID) return null
  const variant = typeof candidate.variant === "string" && candidate.variant.trim() ? candidate.variant.trim() : undefined
  return { providerID, modelID, ...(variant ? { variant } : {}) }
}

function sameModel(left?: ModelSelection | null, right?: ModelSelection | null): boolean {
  if (!left && !right) return true
  if (!left || !right) return false
  return left.providerID === right.providerID && left.modelID === right.modelID && (left.variant || "") === (right.variant || "")
}

/**
 * A selected model is session state, not a per-message command. Re-sending the same selection on
 * every prompt makes OMP append/report a model-change transition even when nothing changed. Keep the
 * model on the durable pending request for idempotency, but omit the ACP mutation when discovery has
 * already proven that exact provider/model/variant is active on the native Session.
 */
export function nativePromptModelForWire(
  targetModel: ModelSelection | null | undefined,
  requestedModel: ModelSelection | null | undefined
): ModelSelection | null {
  const current = normalizeModel(targetModel)
  const requested = normalizeModel(requestedModel)
  if (!requested || sameModel(current, requested)) return null
  return requested
}

function messageText(message: MessageEnvelope): string {
  return (message.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function handoffAlreadySent(target: NativeSessionSurfaceTarget): boolean {
  try { return localStorage.getItem(handoffSentKey(target)) === "1" } catch { return false }
}

function markHandoffSent(target: NativeSessionSurfaceTarget) {
  try { localStorage.setItem(handoffSentKey(target), "1") } catch {}
}

function transferredContext(target: NativeSessionSurfaceTarget): string {
  const history = target.history || []
  if (!history.length) return ""
  const lines: string[] = []
  for (const entry of history) {
    for (const message of entry.messages) {
      const text = messageText(message)
      if (!text) continue
      const label = message.info.role === "user" ? "User" : entry.agentLabel
      const clipped = text.length > HANDOFF_MESSAGE_MAX_CHARS ? `${text.slice(0, HANDOFF_MESSAGE_MAX_CHARS)}…` : text
      lines.push(`${label}: ${clipped}`)
    }
  }
  return lines.slice(-HANDOFF_MESSAGE_LIMIT).join("\n\n").slice(-HANDOFF_CONTEXT_MAX_CHARS)
}

function wirePrompt(target: NativeSessionSurfaceTarget, visibleText: string): string {
  if (!target.history?.length || handoffAlreadySent(target)) return visibleText
  const context = transferredContext(target)
  if (!context) return visibleText
  return [
    "You are taking over an existing TaskDesk task.",
    "",
    "TRANSFERRED TASK CONTEXT",
    context,
    "",
    "USER INSTRUCTION",
    visibleText,
    "",
    "Continue from the shared workspace and the transferred Task Context."
  ].join("\n")
}

export function loadPendingNativeSessionPrompt(target: NativeSessionSurfaceTarget): PendingNativeSessionPrompt | null {
  try {
    const raw = localStorage.getItem(storageKey(target))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingNativeSessionPrompt>
    if (typeof parsed.clientRequestId !== "string" || !parsed.clientRequestId) return null
    if (typeof parsed.text !== "string" || !parsed.text.trim()) return null
    return {
      clientRequestId: parsed.clientRequestId,
      text: parsed.text,
      wireText: typeof parsed.wireText === "string" && parsed.wireText.trim() ? parsed.wireText : undefined,
      model: normalizeModel(parsed.model),
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now()
    }
  } catch {
    return null
  }
}

function persistPending(target: NativeSessionSurfaceTarget, pending: PendingNativeSessionPrompt) {
  try { localStorage.setItem(storageKey(target), JSON.stringify(pending)) } catch {}
}

export function clearPendingNativeSessionPrompt(target: NativeSessionSurfaceTarget) {
  try { localStorage.removeItem(storageKey(target)) } catch {}
}

function parseStatus(data: unknown): NativeSessionPromptStatus {
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

export async function sendNativeSessionPrompt(
  target: NativeSessionSurfaceTarget,
  text: string,
  model?: ModelSelection | null
): Promise<{ status: NativeSessionPromptStatus; clientRequestId: string }> {
  const normalized = text.trim()
  if (!normalized) throw new Error("A text prompt is required")
  const requestedModel = normalizeModel(model)

  const stored = loadPendingNativeSessionPrompt(target)
  const existing = stored && Date.now() - stored.createdAt <= PENDING_DELIVERY_TTL_MS ? stored : null
  if (stored && !existing) clearPendingNativeSessionPrompt(target)
  if (existing && (existing.text !== normalized || !sameModel(existing.model, requestedModel))) {
    throw new Error("A previous prompt still has an unresolved delivery status. Retry that exact prompt and model selection before sending a different request.")
  }
  const pending = existing ?? {
    clientRequestId: requestID(),
    text: normalized,
    wireText: wirePrompt(target, normalized),
    model: requestedModel,
    createdAt: Date.now()
  }
  persistPending(target, pending)

  const path = `/session/${encodeURIComponent(target.sessionID)}/prompt`
  const wireModel = nativePromptModelForWire(target.model, pending.model)
  const body = {
    clientRequestId: pending.clientRequestId,
    text: pending.wireText || pending.text,
    directory: target.directory,
    model: wireModel ? { providerID: wireModel.providerID, modelID: wireModel.modelID } : undefined,
    variant: wireModel?.variant || undefined
  }

  let status: NativeSessionPromptStatus
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(target.config, { path, method: "POST", body })
    if (!result.ok) {
      if (result.error.code === "http" && Number(result.error.status) >= 400) {
        clearPendingNativeSessionPrompt(target)
      }
      throw new Error(result.error.message)
    }
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
        response = await CapacitorHttp.request({
          url,
          method: "POST",
          headers,
          data: body,
          connectTimeout: 12_000,
          readTimeout: 30_000
        })
      } catch {
        throw new Error(`Cannot reach ${target.config.host}:${target.config.port}. Prompt delivery status is unknown; retry will use the same request id.`)
      }
      if (response.status >= 400) {
        clearPendingNativeSessionPrompt(target)
        throw new Error(errorDetail(response.data, response.status))
      }
      status = parseStatus(response.data)
    } else {
      let response: Response
      try {
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
      } catch {
        throw new Error(`Cannot reach ${target.config.host}:${target.config.port}. Prompt delivery status is unknown; retry will use the same request id.`)
      }
      let data: unknown = undefined
      try {
        const raw = await response.text()
        data = raw ? JSON.parse(raw) : undefined
      } catch {}
      if (!response.ok) {
        clearPendingNativeSessionPrompt(target)
        throw new Error(errorDetail(data, response.status))
      }
      status = parseStatus(data)
    }
  }

  if (status === "accepted") {
    if (pending.wireText && pending.wireText !== pending.text) markHandoffSent(target)
    clearPendingNativeSessionPrompt(target)
  }
  return { status, clientRequestId: pending.clientRequestId }
}
