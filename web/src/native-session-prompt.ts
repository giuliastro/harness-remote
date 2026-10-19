import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import type { AttachmentPart } from "./attachments"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import { normalizeModel, sameModel } from "./native-session-model"
import { authHeader, baseUrl, hasCredentials, routingHeaders } from "./serverConfig"
import type { ModelSelection } from "./types"
import { messageText } from "./message-content"

export type NativeSessionPromptStatus = "accepted" | "pending" | "uncertain"

/**
 * What the daemon did with an accepted prompt, when it says so (ACP harnesses do; legacy OpenCode
 * over HTTP does not). `queued` means it waits behind the running turn and is not a turn yet.
 */
export type NativeSessionPromptDisposition = { disposition: "started" | "queued" | "steered"; messageID?: string }

function parseDisposition(data: unknown): NativeSessionPromptDisposition | undefined {
  const result = data && typeof data === "object" ? (data as { result?: unknown }).result : undefined
  if (!result || typeof result !== "object") return undefined
  const { disposition, messageID } = result as { disposition?: unknown; messageID?: unknown }
  if (disposition !== "started" && disposition !== "queued" && disposition !== "steered") return undefined
  return { disposition, ...(typeof messageID === "string" && messageID ? { messageID } : {}) }
}

export type PendingNativeSessionPrompt = {
  clientRequestId: string
  text: string
  wireText?: string
  model?: ModelSelection | null
  attachmentKeys?: string[]
  createdAt: number
}

const STORAGE_PREFIX = "harness-remote.native-session-prompt.v1"
const COMMAND_STORAGE_PREFIX = "harness-remote.native-session-command.v1"
/**
 * How long an unresolved delivery may keep blocking a different prompt for the same Session.
 *
 * The record exists so a retry after a lost response converges on the same daemon ledger entry
 * instead of duplicating a turn. It must not become permanent: the native transcript is the real
 * authority, and an ambiguous record that never expires made one failed delivery brick the Session
 * for every later prompt - which is exactly what a model change produces, because a new model makes
 * the next request differ from the stored one.
 */
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

function attachmentKeys(attachments: AttachmentPart[]): string[] {
  return attachments.map((attachment) => [
    attachment.mime,
    attachment.filename,
    String(attachment.url.length),
    attachment.url.slice(-96)
  ].join("\u0000"))
}

function sameAttachmentKeys(left: string[] = [], right: string[] = []): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}


function handoffAlreadySent(target: NativeSessionSurfaceTarget): boolean {
  try { return localStorage.getItem(handoffSentKey(target)) === "1" } catch { return false }
}

function markHandoffSent(target: NativeSessionSurfaceTarget) {
  try { localStorage.setItem(handoffSentKey(target), "1") } catch {}
}

export function nativeSessionTransferredContext(target: NativeSessionSurfaceTarget): string {
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
  const context = nativeSessionTransferredContext(target)
  if (!context) return visibleText
  // Keep the mature v3 packet markers. native-session-turns strips this technical envelope back to
  // USER INSTRUCTION for display, so the harness gets context while the user sees only what they wrote.
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
      attachmentKeys: Array.isArray(parsed.attachmentKeys)
        ? parsed.attachmentKeys.filter((value): value is string => typeof value === "string")
        : [],
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

/**
 * Resolve an ambiguous native prompt after the authoritative transcript proves that exact request
 * reached the Session. This is the same acceptance cleanup as receiving the HTTP 200 directly:
 * clear the durable request id and, for the first handoff prompt, remember that transferred context
 * has already been delivered so a later ordinary prompt cannot send it a second time.
 */
export function markPendingNativeSessionPromptAccepted(target: NativeSessionSurfaceTarget) {
  const pending = loadPendingNativeSessionPrompt(target)
  if (pending?.wireText && pending.wireText !== pending.text) markHandoffSent(target)
  clearPendingNativeSessionPrompt(target)
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

/**
 * Send one prompt to the exact existing native Session with a durable client request id.
 *
 * The pending id, visible text, wire text and model selection are written before network I/O. A retry
 * therefore converges on the daemon ledger even after a lost HTTP response. For the first prompt of
 * an explicit cross-agent handoff, wireText carries bounded v3-style context while text remains the
 * user's actual instruction for draft recovery and UI fidelity.
 */
export async function sendNativeSessionPrompt(
  target: NativeSessionSurfaceTarget,
  text: string,
  model?: ModelSelection | null,
  attachments: AttachmentPart[] = []
): Promise<{ status: NativeSessionPromptStatus; clientRequestId: string; outcome?: NativeSessionPromptDisposition }> {
  const normalized = text.trim()
  if (!normalized) throw new Error("A text prompt is required")
  const requestedModel = normalizeModel(model)
  const requestedAttachmentKeys = attachmentKeys(attachments)

  const pendingCommand = loadPendingNativeSessionCommand(target)
  if (pendingCommand && Date.now() - pendingCommand.createdAt <= PENDING_DELIVERY_TTL_MS) {
    throw new Error("A previous command still has an unresolved delivery status. Retry that exact command before sending a prompt.")
  }
  if (pendingCommand) clearPendingNativeSessionCommand(target)

  const stored = loadPendingNativeSessionPrompt(target)
  // A record whose retry window has passed is superseded rather than blocking forever.
  const existing = stored && Date.now() - stored.createdAt <= PENDING_DELIVERY_TTL_MS ? stored : null
  if (stored && !existing) clearPendingNativeSessionPrompt(target)
  if (existing && (
    existing.text !== normalized
    || !sameModel(existing.model, requestedModel)
    || !sameAttachmentKeys(existing.attachmentKeys, requestedAttachmentKeys)
  )) {
    throw new Error("A previous prompt still has an unresolved delivery status. Retry that exact prompt, model and image selection before sending a different request.")
  }
  const pending = existing ?? {
    clientRequestId: requestID(),
    text: normalized,
    wireText: wirePrompt(target, normalized),
    model: requestedModel,
    attachmentKeys: requestedAttachmentKeys,
    createdAt: Date.now()
  }
  persistPending(target, pending)

  const path = `/session/${encodeURIComponent(target.sessionID)}/prompt`
  const body = {
    clientRequestId: pending.clientRequestId,
    text: pending.wireText || pending.text,
    directory: target.directory,
    model: pending.model ? { providerID: pending.model.providerID, modelID: pending.model.modelID } : undefined,
    variant: pending.model?.variant || undefined,
    attachments
  }

  let status: NativeSessionPromptStatus
  let outcome: NativeSessionPromptDisposition | undefined
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(target.config, { path, method: "POST", body })
    if (!result.ok) {
      // The desktop transport distinguishes a daemon answer from a transport failure, so only an
      // `http` outcome proves the mutation was refused rather than possibly dispatched.
      if (result.error.code === "http" && Number(result.error.status) >= 400) {
        clearPendingNativeSessionPrompt(target)
      }
      throw new Error(result.error.message)
    }
    status = parseStatus(result.response.data)
    outcome = parseDisposition(result.response.data)
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
      outcome = parseDisposition(response.data)
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
      outcome = parseDisposition(data)
    }
  }

  if (status === "accepted") markPendingNativeSessionPromptAccepted(target)
  return { status, clientRequestId: pending.clientRequestId, ...(outcome ? { outcome } : {}) }
}


type PendingNativeSessionCommand = {
  clientRequestId: string
  command: string
  arguments: string
  model?: ModelSelection | null
  createdAt: number
}

function commandStorageKey(target: NativeSessionSurfaceTarget): string {
  return `${COMMAND_STORAGE_PREFIX}:${encodeURIComponent(target.machineID)}:${encodeURIComponent(target.agentID)}:${encodeURIComponent(target.sessionID)}`
}

function loadPendingNativeSessionCommand(target: NativeSessionSurfaceTarget): PendingNativeSessionCommand | null {
  try {
    const raw = localStorage.getItem(commandStorageKey(target))
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PendingNativeSessionCommand>
    if (typeof parsed.clientRequestId !== "string" || !parsed.clientRequestId) return null
    if (typeof parsed.command !== "string" || !parsed.command.trim()) return null
    return {
      clientRequestId: parsed.clientRequestId,
      command: parsed.command.trim(),
      arguments: typeof parsed.arguments === "string" ? parsed.arguments : "",
      model: normalizeModel(parsed.model),
      createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now()
    }
  } catch {
    return null
  }
}

function persistPendingCommand(target: NativeSessionSurfaceTarget, pending: PendingNativeSessionCommand) {
  try { localStorage.setItem(commandStorageKey(target), JSON.stringify(pending)) } catch {}
}

function clearPendingNativeSessionCommand(target: NativeSessionSurfaceTarget) {
  try { localStorage.removeItem(commandStorageKey(target)) } catch {}
}

/**
 * Execute one harness-native slash command through the same durable Session-first mutation boundary
 * used by ordinary prompts. ACP adapters still receive slash text through AcpService; managed
 * OpenCode is dispatched to its native /command endpoint by the daemon.
 */
export async function sendNativeSessionCommand(
  target: NativeSessionSurfaceTarget,
  command: string,
  argumentsText = "",
  model?: ModelSelection | null
): Promise<{ status: NativeSessionPromptStatus; clientRequestId: string; outcome?: NativeSessionPromptDisposition }> {
  const normalizedCommand = command.replace(/^\/+/, "").trim()
  const normalizedArguments = argumentsText.trim()
  if (!normalizedCommand) throw new Error("A command name is required")
  const requestedModel = normalizeModel(model)

  const pendingPrompt = loadPendingNativeSessionPrompt(target)
  if (pendingPrompt && Date.now() - pendingPrompt.createdAt <= PENDING_DELIVERY_TTL_MS) {
    throw new Error("A previous prompt still has an unresolved delivery status. Retry that exact prompt before running a command.")
  }
  if (pendingPrompt) clearPendingNativeSessionPrompt(target)

  const stored = loadPendingNativeSessionCommand(target)
  const existing = stored && Date.now() - stored.createdAt <= PENDING_DELIVERY_TTL_MS ? stored : null
  if (stored && !existing) clearPendingNativeSessionCommand(target)
  if (existing && (
    existing.command !== normalizedCommand
    || existing.arguments !== normalizedArguments
    || !sameModel(existing.model, requestedModel)
  )) {
    throw new Error("A previous command still has an unresolved delivery status. Retry that exact command and model before running a different request.")
  }

  const pending = existing ?? {
    clientRequestId: requestID(),
    command: normalizedCommand,
    arguments: normalizedArguments,
    model: requestedModel,
    createdAt: Date.now()
  }
  persistPendingCommand(target, pending)

  const path = `/session/${encodeURIComponent(target.sessionID)}/command`
  const body = {
    clientRequestId: pending.clientRequestId,
    command: pending.command,
    arguments: pending.arguments,
    directory: target.directory,
    model: pending.model ? { providerID: pending.model.providerID, modelID: pending.model.modelID } : undefined,
    variant: pending.model?.variant || undefined
  }

  let status: NativeSessionPromptStatus
  let outcome: NativeSessionPromptDisposition | undefined
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(target.config, { path, method: "POST", body })
    if (!result.ok) {
      if (result.error.code === "http" && Number(result.error.status) >= 400) clearPendingNativeSessionCommand(target)
      throw new Error(result.error.message)
    }
    status = parseStatus(result.response.data)
    outcome = parseDisposition(result.response.data)
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
        throw new Error(`Cannot reach ${target.config.host}:${target.config.port}. Command delivery status is unknown; retry will use the same request id.`)
      }
      if (response.status >= 400) {
        clearPendingNativeSessionCommand(target)
        throw new Error(errorDetail(response.data, response.status))
      }
      status = parseStatus(response.data)
      outcome = parseDisposition(response.data)
    } else {
      let response: Response
      try {
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
      } catch {
        throw new Error(`Cannot reach ${target.config.host}:${target.config.port}. Command delivery status is unknown; retry will use the same request id.`)
      }
      let data: unknown = undefined
      try {
        const raw = await response.text()
        data = raw ? JSON.parse(raw) : undefined
      } catch {}
      if (!response.ok) {
        clearPendingNativeSessionCommand(target)
        throw new Error(errorDetail(data, response.status))
      }
      status = parseStatus(data)
      outcome = parseDisposition(data)
    }
  }

  if (status === "accepted") clearPendingNativeSessionCommand(target)
  return { status, clientRequestId: pending.clientRequestId, ...(outcome ? { outcome } : {}) }
}
