import type { DesktopAttentionNotification } from "../electron/ipc-contract"
import type { NativeSessionAttentionNotificationEvent } from "./native-session-attention-notifications"

export type NativeSessionAttentionNotificationContext = {
  sessionTitle?: string
  projectLabel?: string
}

function title(event: NativeSessionAttentionNotificationEvent): string {
  if (event.kind === "authorization") return "Authorization required"
  if (event.kind === "rejected") return "Request rejected"
  return event.reason === "question" ? "Input required" : "Session needs attention"
}

function compact(parts: Array<string | undefined>): string {
  const lines: string[] = []
  let length = 0
  let hinted = false
  for (const part of parts) {
    const value = part?.trim()
    if (!value) continue
    const nextLength = length + (lines.length ? 1 : 0) + value.length
    if (nextLength > 1000) {
      const hint = "Open the Session to review full details"
      if (!hinted && length + (lines.length ? 1 : 0) + hint.length <= 1000) {
        length += (lines.length ? 1 : 0) + hint.length
        lines.push(hint)
        hinted = true
      }
      continue
    }
    lines.push(value)
    length = nextLength
  }
  return lines.join("\n")
}

function reviewableExecutionDetail(value: string | undefined, label: string, maximum: number): string {
  if (value === undefined) return `${label} not supplied by the harness`
  if (value.length > maximum || value !== value.trim() || /[\x00-\x1f\x7f]/.test(value)) {
    return `${label}: open the Session to review full details`
  }
  return `${label}: ${value}`
}

function taskIdentity(
  event: NativeSessionAttentionNotificationEvent,
  context?: NativeSessionAttentionNotificationContext
): string[] {
  const sessionTitle = context?.sessionTitle?.trim()
  const projectLabel = context?.projectLabel?.trim()
  return [
    `${event.machineName} · ${event.agentLabel}`,
    sessionTitle ? `Session: ${sessionTitle}` : undefined,
    projectLabel ? `Project: ${projectLabel}` : undefined
  ].filter((part): part is string => Boolean(part))
}

/** Keep the notification useful without requiring the full transcript. Authorization messages include
 * the requested action, harness-provided explanation/boundary when available, and the fail-closed
 * consequence required by the product contract. Optional task context comes only from bounded native
 * Session metadata; execution directories are included only when explicitly supplied by the native permission request. */
export function desktopAttentionNotification(
  event: NativeSessionAttentionNotificationEvent,
  context?: NativeSessionAttentionNotificationContext
): DesktopAttentionNotification {
  const identity = taskIdentity(event, context)
  const body = event.kind === "authorization"
    ? compact([
        ...identity,
        event.requestedAction,
        event.command === undefined ? "Exact command not supplied by the harness" : reviewableExecutionDetail(event.command, "Command", 300),
        reviewableExecutionDetail(event.executionDirectory, "Execution directory", 200),
        event.explanation,
        event.boundary ? `Boundary: ${event.boundary}` : undefined,
        event.consequence
      ])
    : compact([
        event.requestedAction,
        event.consequence,
        ...identity
      ])

  return {
    title: title(event),
    body,
    overlayDescription: compact([title(event), ...identity]).split("\n").join(" · ").slice(0, 240),
    target: {
      machineID: event.machineID,
      agentID: event.agentID,
      sessionID: event.sessionID
    }
  }
}
