import type { ServerConfig, SessionStatus } from "./types.js"

/**
 * Session-index invalidations are intentionally coarser than transcript streaming. Lifecycle edges
 * can change a rail row and therefore require one fresh Session-index read; token chunks must not
 * fan out into global Session discovery.
 */
const SESSION_INDEX_LIFECYCLE_EVENTS = new Set([
  "session.status",
  "session.idle",
  "session.updated",
  "session.created",
  "session.deleted",
  "session.error",
  // OpenCode changes message metadata at turn boundaries while token chunks use part events. This
  // gives the rail one bounded second chance after the terminal message without refreshing per token.
  "message.updated"
])

// A status edge and `/session/status` are separate reads. Keep the fresher streamed status just long
// enough for the Session-index reconciliation triggered by that same edge to win a short endpoint
// lag, then fall back to the native index again. A later streamed status always supersedes it.
export const LIVE_SESSION_STATUS_GRACE_MS = 15_000

type LiveStatus = { status: SessionStatus; observedAt: number }

const liveStatuses = new Map<string, Map<string, LiveStatus>>()
const invalidationListeners = new Set<() => void>()
let invalidationRevision = 0

function endpointKey(config: Pick<ServerConfig, "host" | "port" | "username" | "backend">): string {
  const host = config.host.trim().replace(/\/+$/, "").toLowerCase()
  return `${host}:${config.port}|${config.username.trim()}|${config.backend}`
}

function pruneLiveStatuses(key: string, now: number): void {
  const bySession = liveStatuses.get(key)
  if (!bySession) return
  for (const [sessionID, entry] of bySession) {
    if (now - entry.observedAt > LIVE_SESSION_STATUS_GRACE_MS) bySession.delete(sessionID)
  }
  if (bySession.size === 0) liveStatuses.delete(key)
}

function invalidateSessionIndex(): void {
  invalidationRevision += 1
  for (const listener of invalidationListeners) listener()
}

export function sessionIndexLifecycleEvent(type: string): boolean {
  return SESSION_INDEX_LIFECYCLE_EVENTS.has(type)
}

/** React-facing store: the value changes only when the Session rail should perform a fresh index read. */
export function sessionIndexInvalidationRevision(): number {
  return invalidationRevision
}

export function subscribeSessionIndexInvalidation(listener: () => void): () => void {
  invalidationListeners.add(listener)
  return () => invalidationListeners.delete(listener)
}

export function noteSessionIndexLiveEvent(
  config: Pick<ServerConfig, "host" | "port" | "username" | "backend">,
  event: { type: string; sessionID?: string; status?: string },
  now = Date.now()
): void {
  const invalidates = sessionIndexLifecycleEvent(event.type)
  if (!event.sessionID) {
    if (invalidates) invalidateSessionIndex()
    return
  }

  const key = endpointKey(config)
  pruneLiveStatuses(key, now)
  if (event.type === "session.deleted") {
    liveStatuses.get(key)?.delete(event.sessionID)
    if (liveStatuses.get(key)?.size === 0) liveStatuses.delete(key)
    if (invalidates) invalidateSessionIndex()
    return
  }

  let status: SessionStatus | undefined
  if (event.type === "session.idle") status = { type: "idle" }
  else if (event.type === "session.status" && event.status) status = { type: event.status }

  if (status) {
    const bySession = liveStatuses.get(key) ?? new Map<string, LiveStatus>()
    bySession.set(event.sessionID, { status, observedAt: now })
    liveStatuses.set(key, bySession)
  }

  // External-store subscribers must only be notified after the related status cache is coherent.
  if (invalidates) invalidateSessionIndex()
}

/** A reconnect means lifecycle edges may have been missed; discard transient authority and re-read. */
export function noteSessionIndexStreamConnected(
  config: Pick<ServerConfig, "host" | "port" | "username" | "backend">
): void {
  liveStatuses.delete(endpointKey(config))
  invalidateSessionIndex()
}

export function liveSessionIndexStatus(
  config: Pick<ServerConfig, "host" | "port" | "username" | "backend">,
  sessionID: string,
  now = Date.now()
): SessionStatus | undefined {
  const key = endpointKey(config)
  pruneLiveStatuses(key, now)
  return liveStatuses.get(key)?.get(sessionID)?.status
}
