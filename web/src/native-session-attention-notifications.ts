import type { NativeSessionAttentionKind } from "./native-session-attention"
import type { NativeSessionAttentionIndex, NativeSessionAttentionIndexItem } from "./native-session-attention-index"

export type NotifiableNativeSessionAttentionKind = Extract<
  NativeSessionAttentionKind,
  "recoverable" | "authorization" | "rejected"
>

export type NativeSessionAttentionNotificationObservation = {
  machineID: string
  machineName: string
  agentID: string
  agentLabel: string
  index: NativeSessionAttentionIndex
}

export type NativeSessionAttentionNotificationEvent = {
  transition: "entered" | "changed"
  machineID: string
  machineName: string
  agentID: string
  agentLabel: string
  sessionID: string
  kind: NotifiableNativeSessionAttentionKind
  reason: NativeSessionAttentionIndexItem["attention"]["reason"]
  requestIDs: string[]
  requestedAction?: string
  explanation?: string
  boundary?: string
  consequence: string
}

type ScopeState = {
  signatures: Record<string, string>
}

export type NativeSessionAttentionNotificationState = {
  scopes: Record<string, ScopeState>
}

export type NativeSessionAttentionNotificationResult = {
  state: NativeSessionAttentionNotificationState
  notifications: NativeSessionAttentionNotificationEvent[]
}

export const EMPTY_NATIVE_SESSION_ATTENTION_NOTIFICATION_STATE: NativeSessionAttentionNotificationState = {
  scopes: {}
}

function scopeKey(observation: NativeSessionAttentionNotificationObservation): string {
  return `${observation.machineID}\u0000${observation.agentID}`
}

function isNotifiable(item: NativeSessionAttentionIndexItem): item is NativeSessionAttentionIndexItem & {
  attention: NativeSessionAttentionIndexItem["attention"] & { kind: NotifiableNativeSessionAttentionKind }
} {
  return item.attention.kind === "recoverable"
    || item.attention.kind === "authorization"
    || item.attention.kind === "rejected"
}

function requestIDs(item: NativeSessionAttentionIndexItem): string[] {
  return [
    ...item.permissions.map((request) => `permission:${request.id}`),
    ...item.questions.map((request) => `question:${request.id}`)
  ].sort()
}

function signature(item: NativeSessionAttentionIndexItem): string {
  return [item.attention.kind, item.attention.reason, ...requestIDs(item)].join("|")
}

function metadataText(metadata: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key]
    if (typeof value === "string" && value.trim()) return value.trim()
  }
  return undefined
}

function notificationEvent(
  observation: NativeSessionAttentionNotificationObservation,
  item: NativeSessionAttentionIndexItem & {
    attention: NativeSessionAttentionIndexItem["attention"] & { kind: NotifiableNativeSessionAttentionKind }
  },
  transition: NativeSessionAttentionNotificationEvent["transition"]
): NativeSessionAttentionNotificationEvent {
  const permission = item.permissions[0]
  const question = item.questions[0]?.questions?.[0]

  if (item.attention.kind === "authorization") {
    return {
      transition,
      machineID: observation.machineID,
      machineName: observation.machineName,
      agentID: observation.agentID,
      agentLabel: observation.agentLabel,
      sessionID: item.sessionID,
      kind: item.attention.kind,
      reason: item.attention.reason,
      requestIDs: requestIDs(item),
      requestedAction: permission?.permission || "Permission requested",
      explanation: permission ? metadataText(permission.metadata, ["reason", "description", "message"]) : undefined,
      boundary: permission?.patterns?.length ? permission.patterns.join(", ") : undefined,
      consequence: "The Session remains blocked until you allow or deny this request."
    }
  }

  if (item.attention.kind === "rejected") {
    return {
      transition,
      machineID: observation.machineID,
      machineName: observation.machineName,
      agentID: observation.agentID,
      agentLabel: observation.agentLabel,
      sessionID: item.sessionID,
      kind: item.attention.kind,
      reason: item.attention.reason,
      requestIDs: requestIDs(item),
      consequence: "This request was rejected and will not proceed automatically."
    }
  }

  return {
    transition,
    machineID: observation.machineID,
    machineName: observation.machineName,
    agentID: observation.agentID,
    agentLabel: observation.agentLabel,
    sessionID: item.sessionID,
    kind: item.attention.kind,
    reason: item.attention.reason,
    requestIDs: requestIDs(item),
    requestedAction: question?.question || question?.header,
    consequence: item.attention.reason === "question"
      ? "The Session remains blocked until you answer this question."
      : "Open the Session to review the condition and resume or retry when appropriate."
  }
}

/**
 * Reconcile complete attention snapshots into meaningful notification transitions.
 *
 * Rules are intentionally conservative:
 * - the first complete snapshot for a machine/harness is baseline only, so reload/reconnect does not
 *   spam the user for attention that already existed;
 * - incomplete snapshots are ignored for state/dedup purposes, so a transient endpoint failure cannot
 *   make an existing permission look new when the endpoint recovers;
 * - streaming/activity events never enter this model; only the product-level attention index does;
 * - a resolved item is removed only by a complete snapshot, so a later re-entry is legitimately new;
 * - request ids participate in the signature, so a genuinely new permission/question in the same
 *   Session can notify even when the high-level severity did not change.
 */
export function reconcileNativeSessionAttentionNotifications(
  previous: NativeSessionAttentionNotificationState,
  observations: readonly NativeSessionAttentionNotificationObservation[]
): NativeSessionAttentionNotificationResult {
  const scopes = { ...previous.scopes }
  const notifications: NativeSessionAttentionNotificationEvent[] = []

  for (const observation of observations) {
    if (!observation.index.complete) continue

    const key = scopeKey(observation)
    const currentItems = observation.index.items.filter(isNotifiable)
    const currentSignatures = Object.fromEntries(
      currentItems.map((item) => [item.sessionID, signature(item)])
    )
    const prior = scopes[key]

    if (prior) {
      for (const item of currentItems) {
        const current = currentSignatures[item.sessionID]
        const before = prior.signatures[item.sessionID]
        if (before === undefined) notifications.push(notificationEvent(observation, item, "entered"))
        else if (before !== current) notifications.push(notificationEvent(observation, item, "changed"))
      }
    }

    // A complete empty snapshot intentionally clears this scope. An absent observation does not: a
    // temporarily disconnected machine must not lose its dedup baseline merely because it vanished
    // from one aggregate refresh.
    scopes[key] = { signatures: currentSignatures }
  }

  return { state: { scopes }, notifications }
}
