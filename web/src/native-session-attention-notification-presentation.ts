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
  return parts
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part))
    .join("\n")
    .slice(0, 1000)
}

function taskIdentity(
  event: NativeSessionAttentionNotificationEvent,
  context?: NativeSessionAttentionNotificationContext
): string[] {
  const sessionTitle = context?.sessionTitle?.trim()
  const projectLabel = context?.projectLabel?.trim()
  return [
    sessionTitle ? `Session: ${sessionTitle}` : undefined,
    projectLabel ? `Project: ${projectLabel}` : undefined,
    `${event.machineName} · ${event.agentLabel}`
  ].filter((part): part is string => Boolean(part))
}

/** Keep the notification useful without requiring the full transcript. Authorization messages include
 * the requested action, harness-provided explanation/boundary when available, and the fail-closed
 * consequence required by the product contract. Optional task context comes only from bounded native
 * Session metadata; raw working-directory paths are never added to the notification. */
export function desktopAttentionNotification(
  event: NativeSessionAttentionNotificationEvent,
  context?: NativeSessionAttentionNotificationContext
): DesktopAttentionNotification {
  const identity = taskIdentity(event, context)
  const body = event.kind === "authorization"
    ? compact([
        event.requestedAction,
        event.explanation,
        event.boundary ? `Boundary: ${event.boundary}` : undefined,
        event.consequence,
        ...identity
      ])
    : compact([
        event.requestedAction,
        event.consequence,
        ...identity
      ])

  return {
    title: title(event),
    body,
    overlayDescription: compact([title(event), ...identity]).replaceAll("\n", " · ").slice(0, 240),
    target: {
      machineID: event.machineID,
      agentID: event.agentID,
      sessionID: event.sessionID
    }
  }
}
