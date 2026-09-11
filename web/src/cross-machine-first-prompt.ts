import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import { authHeader, baseUrl, hasCredentials, routingHeaders } from "./serverConfig"
import type { ModelSelection } from "./types"

export type CrossMachineFirstPromptStatus = "accepted" | "pending" | "uncertain"

const HANDOFF_SENT_PREFIX = "harness-remote.native-session-handoff-context.v1"

function handoffSentKey(target: NativeSessionSurfaceTarget): string {
  return `${HANDOFF_SENT_PREFIX}:${encodeURIComponent(target.machineID)}:${encodeURIComponent(target.agentID)}:${encodeURIComponent(target.sessionID)}`
}

function parseStatus(data: unknown): CrossMachineFirstPromptStatus {
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

function wirePrompt(visibleText: string, transferredContext: string): string {
  if (!transferredContext) return visibleText
  return [
    "You are taking over an existing TaskDesk task.",
    "",
    "TRANSFERRED TASK CONTEXT",
    transferredContext,
    "",
    "USER INSTRUCTION",
    visibleText,
    "",
    "Continue from the shared workspace and the transferred Task Context."
  ].join("\n")
}

/**
 * Send the first prompt of a cross-machine handoff with a caller-owned durable request id.
 *
 * Unlike an ordinary Session prompt, this function deliberately owns no local retry TTL and never
 * clears the request identity: the cross-machine orchestrator persists that id together with the
 * exact target Session before network I/O. A retry after a lost response therefore reaches the
 * target daemon with the same id and converges on its mutation ledger instead of creating a second
 * turn. Authority/approval state is not part of this request.
 */
export async function sendCrossMachineFirstPrompt({
  target,
  clientRequestId,
  text,
  model,
  transferredContext
}: {
  target: NativeSessionSurfaceTarget
  clientRequestId: string
  text: string
  model?: ModelSelection | null
  transferredContext: string
}): Promise<{ status: CrossMachineFirstPromptStatus; clientRequestId: string }> {
  const requestId = clientRequestId.trim()
  const normalized = text.trim()
  if (!requestId) throw new Error("A durable cross-machine prompt request id is required.")
  if (!normalized) throw new Error("A text prompt is required")

  const path = `/session/${encodeURIComponent(target.sessionID)}/prompt`
  const body = {
    clientRequestId: requestId,
    text: wirePrompt(normalized, transferredContext),
    directory: target.directory,
    model: model ? { providerID: model.providerID, modelID: model.modelID } : undefined,
    variant: model?.variant || undefined,
    attachments: []
  }

  let status: CrossMachineFirstPromptStatus
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
        response = await CapacitorHttp.request({
          url,
          method: "POST",
          headers,
          data: body,
          connectTimeout: 12_000,
          readTimeout: 30_000
        })
      } catch {
        throw new Error(`Cannot reach ${target.config.host}:${target.config.port}. First prompt delivery status is unknown; retry will use the same request id.`)
      }
      if (response.status >= 400) throw new Error(errorDetail(response.data, response.status))
      status = parseStatus(response.data)
    } else {
      let response: Response
      try {
        response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
      } catch {
        throw new Error(`Cannot reach ${target.config.host}:${target.config.port}. First prompt delivery status is unknown; retry will use the same request id.`)
      }
      let data: unknown
      try {
        const raw = await response.text()
        data = raw ? JSON.parse(raw) : undefined
      } catch {}
      if (!response.ok) throw new Error(errorDetail(data, response.status))
      status = parseStatus(data)
    }
  }

  return { status, clientRequestId: requestId }
}

/**
 * Keep ordinary native-session-prompt from replaying transferred context on the next prompt after
 * this specialized first-prompt path succeeds. This key intentionally matches that module's v1
 * handoff-context marker; it is presentation/context state, not writer authority.
 */
export function markCrossMachineHandoffContextSent(target: NativeSessionSurfaceTarget) {
  try { localStorage.setItem(handoffSentKey(target), "1") } catch {}
}
