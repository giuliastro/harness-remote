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
        event.command === undefined ? "Exact command not supplied by the harness" : event.command.length > 300 ? "Command too long for notification; open the Session to review" : `Command: ${event.command}`,
        event.executionDirectory === undefined ? "Execution directory not supplied" : event.executionDirectory.length > 200 ? "Execution directory: open the Session to review" : `Execution directory: ${event.executionDirectory}`,
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
