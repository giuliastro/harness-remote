import type { MachineSnapshot, ServerConfig, SessionStatus } from "./types.js"

/**
 * A Session row has two freshness sources: the native Session index and the live event stream.
 * The index is still the durable/read fallback, but a lifecycle edge must be allowed to invalidate
 * it immediately even when `/v1/machine` itself is structurally unchanged.
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

const revisions = new Map<string, number>()
const liveStatuses = new Map<string, Map<string, LiveStatus>>()

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

function bump(config: Pick<ServerConfig, "host" | "port" | "username" | "backend">): number {
  const key = endpointKey(config)
  const next = (revisions.get(key) ?? 0) + 1
  revisions.set(key, next)
  return next
}

export function sessionIndexLifecycleEvent(type: string): boolean {
  return SESSION_INDEX_LIFECYCLE_EVENTS.has(type)
}

export function sessionIndexLiveRevision(config: Pick<ServerConfig, "host" | "port" | "username" | "backend">): number {
  return revisions.get(endpointKey(config)) ?? 0
}

export function noteSessionIndexLiveEvent(
  config: Pick<ServerConfig, "host" | "port" | "username" | "backend">,
  event: { type: string; sessionID?: string; status?: string },
  now = Date.now()
): void {
  if (sessionIndexLifecycleEvent(event.type)) bump(config)
  if (!event.sessionID) return

  const key = endpointKey(config)
  pruneLiveStatuses(key, now)
  if (event.type === "session.deleted") {
    liveStatuses.get(key)?.delete(event.sessionID)
    if (liveStatuses.get(key)?.size === 0) liveStatuses.delete(key)
    return
  }

  let status: SessionStatus | undefined
  if (event.type === "session.idle") status = { type: "idle" }
  else if (event.type === "session.status" && event.status) status = { type: event.status }
  if (!status) return

  const bySession = liveStatuses.get(key) ?? new Map<string, LiveStatus>()
  bySession.set(event.sessionID, { status, observedAt: now })
  liveStatuses.set(key, bySession)
}

/** A reconnect means lifecycle edges may have been missed; discard transient event authority. */
export function noteSessionIndexStreamConnected(
  config: Pick<ServerConfig, "host" | "port" | "username" | "backend">
): void {
  liveStatuses.delete(endpointKey(config))
  bump(config)
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

/**
 * Client-only decoration used by workspace structural reconciliation. A Session lifecycle event can
 * change no field in `/v1/machine`; carrying this epoch makes that otherwise-identical snapshot a
 * real update, which in turn lets NativeSessionHome perform its authoritative Session-index read.
 */
export function withSessionIndexLiveRevision(
  config: Pick<ServerConfig, "host" | "port" | "username" | "backend">,
  snapshot: MachineSnapshot
): MachineSnapshot {
  return {
    ...snapshot,
    __clientSessionIndexRevision: sessionIndexLiveRevision(config)
  } as MachineSnapshot
}
