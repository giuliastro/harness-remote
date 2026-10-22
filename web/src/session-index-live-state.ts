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
// OpenCode session.error is a lifecycle event, not guaranteed to be durable in the message endpoint
// immediately. Keep the exact provider error across ordinary Session navigation long enough for the
// durable transcript to catch up. A later busy/retry edge clears it immediately.
export const LIVE_SESSION_ERROR_GRACE_MS = 2 * 60_000

type LiveStatus = { status: SessionStatus; observedAt: number }
type LiveError = { message: string; observedAt: number }
type SessionIndexConfig = Pick<ServerConfig, "host" | "port" | "username" | "backend" | "agentId">

type LiveEvent = {
  type: string
  sessionID?: string
  status?: string
  statusMessage?: string
  statusAttempt?: number
  statusNext?: number
  errorMessage?: string
}

const liveStatuses = new Map<string, Map<string, LiveStatus>>()
const liveErrors = new Map<string, Map<string, LiveError>>()
const invalidationListeners = new Set<() => void>()
let invalidationRevision = 0

function endpointKey(config: SessionIndexConfig): string {
  const host = config.host.trim().replace(/\/+$/, "").toLowerCase()
  // A Harness machine can expose multiple routed agents of the same backend. The agent id is part of
  // transport identity just like backend/host/port: retry/error state from one OpenCode agent must
  // never project onto a different OpenCode agent that happens to share the daemon endpoint.
  return `${host}:${config.port}|${config.username.trim()}|${config.backend}|${config.agentId?.trim() || ""}`
}

function pruneLiveStatuses(key: string, now: number): void {
  const bySession = liveStatuses.get(key)
  if (!bySession) return
  for (const [sessionID, entry] of bySession) {
    if (now - entry.observedAt > LIVE_SESSION_STATUS_GRACE_MS) bySession.delete(sessionID)
  }
  if (bySession.size === 0) liveStatuses.delete(key)
}

function pruneLiveErrors(key: string, now: number): void {
  const bySession = liveErrors.get(key)
  if (!bySession) return
  for (const [sessionID, entry] of bySession) {
    if (now - entry.observedAt > LIVE_SESSION_ERROR_GRACE_MS) bySession.delete(sessionID)
  }
  if (bySession.size === 0) liveErrors.delete(key)
}

function deleteStatus(key: string, sessionID: string): boolean {
  const bySession = liveStatuses.get(key)
  if (!bySession?.delete(sessionID)) return false
  if (bySession.size === 0) liveStatuses.delete(key)
  return true
}

function deleteError(key: string, sessionID: string): boolean {
  const bySession = liveErrors.get(key)
  if (!bySession?.delete(sessionID)) return false
  if (bySession.size === 0) liveErrors.delete(key)
  return true
}

function deleteSessionState(key: string, sessionID: string): boolean {
  // Do not short-circuit: a Session can legitimately hold both a transient status and a terminal
  // error bridge at once. Both must be retired when durable state becomes authoritative.
  const statusDeleted = deleteStatus(key, sessionID)
  const errorDeleted = deleteError(key, sessionID)
  return statusDeleted || errorDeleted
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

/**
 * The live cache is a bridge across event/index races, not durable Session truth. The selected native
 * controller is stronger once it has accepted a new turn or reconciled a terminal transcript. These
 * explicit retirement helpers let that controller stop an old retry/error from resurfacing later.
 */
export function clearSessionIndexLiveError(
  config: SessionIndexConfig,
  sessionID: string
): void {
  if (deleteError(endpointKey(config), sessionID)) invalidateSessionIndex()
}

export function clearSessionIndexLiveState(
  config: SessionIndexConfig,
  sessionID: string
): void {
  if (deleteSessionState(endpointKey(config), sessionID)) invalidateSessionIndex()
}

/**
 * Drop every transient busy/idle/retry status at once so the next Session-index read speaks for
 * native truth. A foregrounded phone may have slept through the terminal edge of a long turn: its
 * last streamed status is a bridge across a short event/index race, not a claim about a Session that
 * finished minutes ago, and the status cache would otherwise outvote the fresh index for its grace.
 * Terminal errors are deliberately left in place - they outlive navigation until durable truth
 * catches up, exactly like a stream reconnect.
 */
export function clearSessionIndexLiveStatuses(): void {
  if (liveStatuses.size === 0) return
  liveStatuses.clear()
  invalidateSessionIndex()
}

export function noteSessionIndexLiveEvent(
  config: SessionIndexConfig,
  event: LiveEvent,
  now = Date.now()
): void {
  const invalidates = sessionIndexLifecycleEvent(event.type)
  if (!event.sessionID) {
    if (invalidates) invalidateSessionIndex()
    return
  }

  const key = endpointKey(config)
  pruneLiveStatuses(key, now)
  pruneLiveErrors(key, now)
  if (event.type === "session.deleted") {
    deleteSessionState(key, event.sessionID)
    if (invalidates) invalidateSessionIndex()
    return
  }

  let status: SessionStatus | undefined
  if (event.type === "session.idle") status = { type: "idle" }
  else if (event.type === "session.status" && event.status) {
    status = {
      type: event.status,
      ...(event.statusAttempt !== undefined ? { attempt: event.statusAttempt } : {}),
      ...(event.statusMessage ? { message: event.statusMessage } : {}),
      ...(event.statusNext !== undefined ? { next: event.statusNext } : {})
    }
  }

  if (status) {
    const bySession = liveStatuses.get(key) ?? new Map<string, LiveStatus>()
    bySession.set(event.sessionID, { status, observedAt: now })
    liveStatuses.set(key, bySession)
    // A real retry/busy edge proves that an earlier terminal-looking OpenCode error was not final.
    if (config.backend === "opencode" && (status.type === "busy" || status.type === "retry")) deleteError(key, event.sessionID)
  }

  // Error-envelope timing and retry semantics here are OpenCode-specific. ACP backends keep their
  // established durable adapter/transcript authority and must not inherit this temporary overlay.
  if (config.backend === "opencode" && event.type === "session.error" && event.errorMessage) {
    // session.error is newer authority than a preceding retry/busy edge. Drop that older status so
    // the failure is visible immediately; a later real busy/retry edge can still retract it.
    deleteStatus(key, event.sessionID)
    const bySession = liveErrors.get(key) ?? new Map<string, LiveError>()
    bySession.set(event.sessionID, { message: event.errorMessage, observedAt: now })
    liveErrors.set(key, bySession)
  }

  // External-store subscribers must only be notified after the related lifecycle cache is coherent.
  if (invalidates) invalidateSessionIndex()
}

/**
 * A newly connected stream may have missed status edges, so its short-lived busy/idle authority is
 * discarded and the index is re-read. Do not discard a terminal session.error here: opening another
 * Session creates another subscription too, and treating that ordinary remount as a reconnect used
 * to erase the only copy of a provider failure before the transcript had persisted it. A later real
 * busy/retry edge retracts the error, and the bounded error grace prevents it from living forever.
 */
export function noteSessionIndexStreamConnected(
  config: SessionIndexConfig
): void {
  const key = endpointKey(config)
  liveStatuses.delete(key)
  if (config.backend === "opencode") pruneLiveErrors(key, Date.now())
  invalidateSessionIndex()
}

export function liveSessionIndexError(
  config: SessionIndexConfig,
  sessionID: string,
  now = Date.now()
): string | undefined {
  if (config.backend !== "opencode") return undefined
  const key = endpointKey(config)
  pruneLiveErrors(key, now)
  return liveErrors.get(key)?.get(sessionID)?.message
}

export function liveSessionIndexStatus(
  config: SessionIndexConfig,
  sessionID: string,
  now = Date.now()
): SessionStatus | undefined {
  const key = endpointKey(config)
  pruneLiveStatuses(key, now)
  if (config.backend === "opencode") pruneLiveErrors(key, now)
  const status = liveStatuses.get(key)?.get(sessionID)?.status
  const error = config.backend === "opencode" ? liveErrors.get(key)?.get(sessionID)?.message : undefined
  // A terminal lifecycle error must beat a trailing idle status in the rail. A later busy/retry
  // edge clears the cached error above, so automatic provider recovery still wins immediately.
  if (error && !status?.type?.match(/^(busy|retry)$/)) return { type: "error", message: error }
  return status
}
