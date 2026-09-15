import { api } from "./api"
import { createDesktopOpenCodeEventSubscription, isDesktopPlatform } from "./desktopBridge"
import {
  createFetchOpenCodeEventSubscription,
  createNativeOpenCodeEventSubscription,
  eventPayload,
  eventType,
  isNativeEventTransport,
  type EventStreamStatus
} from "./opencode-events"
import { noteSessionIndexLiveEvent, noteSessionIndexStreamConnected } from "./session-index-live-state"
import type { ServerConfig } from "./types"

export type TaskDeskLiveEvent = {
  type: string
  sessionID?: string
  status?: string
}

type Subscription = { close(): void }

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/** Normalize bridge-native and OpenCode event envelopes into the fields TaskDesk needs. */
export function taskDeskLiveEvent(name: string | undefined, data: unknown): TaskDeskLiveEvent | null {
  const payload = eventPayload(data)
  if (!payload) return name ? { type: name } : null
  const properties = object(payload.properties)
  const info = object(properties?.info)
  const session = object(properties?.session)
  const part = object(properties?.part)
  const status = object(properties?.status)
  const type = eventType(data) ?? text(payload.type) ?? name
  if (!type) return null
  const sessionID = text(payload.sessionId)
    ?? text(payload.sessionID)
    ?? text(properties?.sessionId)
    ?? text(properties?.sessionID)
    ?? text(info?.sessionID)
    ?? text(info?.id)
    ?? text(session?.id)
    // Older OpenCode message.part.updated envelopes put the Session identity only on the part.
    // Keep this as transport normalization; the mature v3 renderer still owns reasoning semantics.
    ?? text(part?.sessionId)
    ?? text(part?.sessionID)
  const statusType = text(status?.type)
  return {
    type,
    ...(sessionID ? { sessionID } : {}),
    ...(statusType ? { status: statusType } : {})
  }
}

/**
 * Use the transport already proven by Classic on each platform. Browser and Electron fetch streams
 * can carry auth headers, Android uses the native SSE plugin, and Electron main owns desktop sockets.
 */
export function subscribeTaskDeskLiveEvents({
  config,
  onEvent,
  onStatus
}: {
  config: ServerConfig
  onEvent: (event: TaskDeskLiveEvent) => void
  onStatus?: (status: EventStreamStatus) => void
}): Subscription {
  const emit = (name: string | undefined, data: unknown) => {
    const normalized = taskDeskLiveEvent(name, data)
    if (!normalized) return
    noteSessionIndexLiveEvent(config, normalized)
    onEvent(normalized)
  }
  const emitStatus = (status: EventStreamStatus) => {
    // A newly-connected stream may have missed a complete turn while it was down. Force the next
    // machine reconciliation to invalidate the Session index instead of trusting pre-gap row state.
    if (status.type === "connected") noteSessionIndexStreamConnected(config)
    onStatus?.(status)
  }

  if (isDesktopPlatform()) {
    return createDesktopOpenCodeEventSubscription({
      config,
      scope: "global",
      onEvent: (event) => emit(event.name, event.data),
      onStatus: emitStatus
    })
  }

  const stream = api.eventStream(config)
  if (isNativeEventTransport()) {
    return createNativeOpenCodeEventSubscription({
      url: stream.url,
      username: config.username,
      password: config.password,
      backend: config.backend,
      onEvent: (event) => emit(event.name, event.data),
      onStatus: emitStatus
    })
  }

  return createFetchOpenCodeEventSubscription({
    url: stream.url,
    headers: stream.headers,
    onEvent: (event) => emit(event.name, event.data),
    onStatus: emitStatus
  })
}
