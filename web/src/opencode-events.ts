import { Capacitor, registerPlugin, type PluginListenerHandle } from "@capacitor/core"
import { parseOpenCodeEvent, parseSSEFrame } from "./sse-parser.ts"
import type { ParsedOpenCodeEvent } from "./sse-parser.ts"
export { parseOpenCodeEvent, parseSSEFrame }
export type { ParsedOpenCodeEvent }

export type EventStreamScope = "project" | "global"
export function streamURL(serverURL: string, scope: EventStreamScope, directory?: string): string {
  const url = new URL(scope === "global" ? "/global/event" : "/event", serverURL)
  if (scope === "project" && directory) url.searchParams.set("directory", directory)
  return url.toString()
}

export type EventStreamStatus =
  | { type: "connected" }
  | { type: "reconnecting", delayMs: number }
  | { type: "connection-error", error: string }
  | { type: "parse-error", data: string }
  | { type: "closed" }

type EventSourceMessage = { data: string }

type EventSourceLike = {
  onopen: ((event: Event) => unknown) | null
  onmessage: ((event: EventSourceMessage) => unknown) | null
  onerror: ((event: Event) => unknown) | null
  close(): void
}

type ReconnectConfig = {
  initialDelayMs?: number
  maxDelayMs?: number
}

type TimerID = ReturnType<typeof setTimeout>

type EventSubscriptionOptions = {
  url: string
  reconnect?: ReconnectConfig
  createEventSource?: (url: string) => EventSourceLike
  schedule?: (callback: () => void, delayMs: number) => TimerID
  cancel?: (timerID: TimerID) => void
  onEvent: (event: Extract<ParsedOpenCodeEvent, { ok: true }>) => void
  onStatus?: (status: EventStreamStatus) => void
  logger?: (message: string) => void
}

function validDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "EventSource creation failed"
}

/** OpenCode global SSE wraps the event payload in { directory, payload }. */
export function eventPayload(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null
  const envelope = data as Record<string, unknown>
  const payload = envelope.payload
  if (payload && typeof payload === "object" && !Array.isArray(payload)) return payload as Record<string, unknown>
  return envelope
}

export function eventType(data: unknown): string | null {
  const payload = eventPayload(data)
  return typeof payload?.type === "string" ? payload.type : null
}

type FetchEventSubscriptionOptions = {
  url: string
  headers?: Record<string, string>
  reconnect?: ReconnectConfig
  fetchFn?: typeof fetch
  /** Abort and reconnect when no bytes arrive for this long. Defaults to 30s (server beats every 10s). */
  stallTimeoutMs?: number
  onEvent: (event: Extract<ParsedOpenCodeEvent, { ok: true }>) => void
  onStatus?: (status: EventStreamStatus) => void
  logger?: (message: string) => void
}

/**
 * Authenticated SSE transport. Unlike EventSource it can send Basic-Auth headers.
 * It deliberately keeps the UI on its existing polling fallback if the stream is unavailable.
 */
export function createFetchOpenCodeEventSubscription(options: FetchEventSubscriptionOptions): { close(): void } {
  const initialDelayMs = validDelay(options.reconnect?.initialDelayMs, 1_000)
  const maxDelayMs = Math.max(initialDelayMs, validDelay(options.reconnect?.maxDelayMs, 30_000))
  const fetchFn = options.fetchFn ?? fetch
  const stallTimeoutMs = validDelay(options.stallTimeoutMs, 30_000)
  const logger = options.logger ?? ((message: string) => console.debug(message))
  let controller: AbortController | undefined
  let reconnectTimer: TimerID | undefined
  let reconnectDelayMs = initialDelayMs
  let closed = false

  const publishStatus = (status: EventStreamStatus) => options.onStatus?.(status)
  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return
    const delayMs = reconnectDelayMs
    reconnectDelayMs = Math.min(maxDelayMs, reconnectDelayMs * 2)
    publishStatus({ type: "reconnecting", delayMs })
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      connect()
    }, delayMs)
  }

  const connect = async () => {
    if (closed) return
    const currentController = new AbortController()
    controller = currentController
    try {
      const response = await fetchFn(options.url, {
        headers: { Accept: "text/event-stream", ...options.headers },
        signal: currentController.signal
      })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const contentType = response.headers.get("content-type") ?? ""
      if (!contentType.toLowerCase().includes("text/event-stream")) {
        throw new Error(`Expected text/event-stream, received ${contentType || "no content type"}`)
      }
      reconnectDelayMs = initialDelayMs
      publishStatus({ type: "connected" })
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      // A TCP connection can die silently (sleep/resume, NAT or proxy timeout) without ever
      // rejecting the pending read or delivering `done`. Without this watchdog the stream would
      // sit in `connected` forever, which also suppresses the caller's polling fallback. The
      // server emits a heartbeat every 10s, so a long gap means the connection is gone.
      let stallTimer: TimerID | undefined
      const disarmStall = () => {
        if (stallTimer !== undefined) clearTimeout(stallTimer)
        stallTimer = undefined
      }
      const armStall = () => {
        disarmStall()
        stallTimer = setTimeout(() => {
          stallTimer = undefined
          logger(`OpenCode SSE stalled for ${stallTimeoutMs}ms, reconnecting`)
          // Abort frees the socket; cancel guarantees the pending read settles even if the
          // transport does not propagate the abort signal into the body stream.
          currentController.abort()
          reader.cancel().catch(() => undefined)
        }, stallTimeoutMs)
      }
      try {
        while (!closed && controller === currentController) {
          armStall()
          const { done, value } = await reader.read()
          disarmStall()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.search(/\r?\n\r?\n/)
          while (boundary !== -1) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
            const event = parseSSEFrame(frame)
            if (event?.ok) options.onEvent(event)
            if (event && !event.ok) publishStatus({ type: "parse-error", data: event.raw })
            boundary = buffer.search(/\r?\n\r?\n/)
          }
        }
      } finally {
        disarmStall()
      }
    } catch (error) {
      if (!closed && controller === currentController && !(error instanceof DOMException && error.name === "AbortError")) {
        const message = errorMessage(error)
        publishStatus({ type: "connection-error", error: message })
        logger(`OpenCode SSE connection failed: ${message}`)
      }
    }
    if (!closed && controller === currentController) scheduleReconnect()
  }

  connect().catch(() => undefined)
  return {
    close() {
      if (closed) return
      closed = true
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      controller?.abort()
      controller = undefined
      publishStatus({ type: "closed" })
    }
  }
}

type NativeLiveEventsPlugin = {
  start(options: { url: string; username: string; password: string }): Promise<void>
  stop(): Promise<void>
  addListener(eventName: "event", listenerFunc: (event: { data?: string }) => void): Promise<PluginListenerHandle>
  addListener(eventName: "status", listenerFunc: (status: EventStreamStatus) => void): Promise<PluginListenerHandle>
}

const NativeLiveEvents = registerPlugin<NativeLiveEventsPlugin>("LiveEvents")

export function isNativeEventTransport(): boolean {
  return Capacitor.getPlatform() === "android"
}

/** Android WebView cannot reliably keep a fetch ReadableStream open; use a direct native HttpURLConnection SSE client. */
export function createNativeOpenCodeEventSubscription(options: {
  url: string
  username: string
  password: string
  onEvent: (event: Extract<ParsedOpenCodeEvent, { ok: true }>) => void
  onStatus?: (status: EventStreamStatus) => void
}): { close(): void } {
  let closed = false
  let handles: PluginListenerHandle[] = []
  void (async () => {
    try {
      const eventHandle = await NativeLiveEvents.addListener("event", ({ data }) => {
        if (closed || !data) return
        const event = parseOpenCodeEvent(data)
        if (event.ok) options.onEvent(event)
        else options.onStatus?.({ type: "parse-error", data })
      })
      const statusHandle = await NativeLiveEvents.addListener("status", (status) => {
        if (!closed) options.onStatus?.(status)
      })
      handles = [eventHandle, statusHandle]
      if (closed) {
        await Promise.all(handles.map((handle) => handle.remove()))
        return
      }
      await NativeLiveEvents.start({ url: options.url, username: options.username, password: options.password })
    } catch (error) {
      if (!closed) options.onStatus?.({ type: "connection-error", error: errorMessage(error) })
    }
  })()
  return {
    close() {
      if (closed) return
      closed = true
      void NativeLiveEvents.stop().catch(() => undefined)
      void Promise.all(handles.map((handle) => handle.remove())).catch(() => undefined)
      options.onStatus?.({ type: "closed" })
    }
  }
}

/**
 * Isolated EventSource prototype for unauthenticated servers and unit tests.
 * Authenticated app integration uses createFetchOpenCodeEventSubscription above.
 */
export function createOpenCodeEventSubscription(options: EventSubscriptionOptions): { close(): void } {
  const initialDelayMs = validDelay(options.reconnect?.initialDelayMs, 1_000)
  const maxDelayMs = Math.max(initialDelayMs, validDelay(options.reconnect?.maxDelayMs, 30_000))
  const createEventSource: (url: string) => EventSourceLike = options.createEventSource
    ?? ((url: string) => new EventSource(url) as EventSourceLike)
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs))
  const cancel = options.cancel ?? ((timerID) => clearTimeout(timerID))
  const logger = options.logger ?? ((message: string) => console.debug(message))

  let source: EventSourceLike | undefined
  let reconnectTimer: TimerID | undefined
  let reconnectDelayMs = initialDelayMs
  let closed = false

  const publishStatus = (status: EventStreamStatus) => options.onStatus?.(status)

  const scheduleReconnect = () => {
    if (closed || reconnectTimer !== undefined) return
    const delayMs = reconnectDelayMs
    reconnectDelayMs = Math.min(maxDelayMs, reconnectDelayMs * 2)
    publishStatus({ type: "reconnecting", delayMs })
    logger(`OpenCode SSE reconnect scheduled in ${delayMs}ms`)
    reconnectTimer = schedule(() => {
      reconnectTimer = undefined
      connect()
    }, delayMs)
  }

  const connect = () => {
    if (closed) return
    logger(`OpenCode SSE connecting: ${options.url}`)
    let eventSource: EventSourceLike
    try {
      eventSource = createEventSource(options.url)
    } catch (error) {
      const message = errorMessage(error)
      publishStatus({ type: "connection-error", error: message })
      logger(`OpenCode SSE connection failed: ${message}`)
      scheduleReconnect()
      return
    }

    source = eventSource
    const isCurrent = () => !closed && source === eventSource
    eventSource.onopen = () => {
      if (!isCurrent()) return
      reconnectDelayMs = initialDelayMs
      publishStatus({ type: "connected" })
      logger("OpenCode SSE connected")
    }
    eventSource.onmessage = (message) => {
      if (!isCurrent()) return
      const event = parseOpenCodeEvent(message.data)
      if (!event.ok) {
        publishStatus({ type: "parse-error", data: message.data })
        logger(`OpenCode SSE ignored an unparseable ${event.name} event`)
        return
      }
      options.onEvent(event)
    }
    eventSource.onerror = () => {
      if (!isCurrent()) return
      eventSource.close()
      source = undefined
      scheduleReconnect()
    }
  }

  connect()

  return {
    close() {
      if (closed) return
      closed = true
      if (reconnectTimer !== undefined) cancel(reconnectTimer)
      reconnectTimer = undefined
      source?.close()
      source = undefined
      publishStatus({ type: "closed" })
      logger("OpenCode SSE closed")
    }
  }
}
