import http from "node:http"

const DEFAULT_RECONNECT_MIN_MS = 500
const DEFAULT_RECONNECT_MAX_MS = 10_000
const DEFAULT_HEARTBEAT_MS = 10_000

function internalAuthorization(host) {
  if (!host.username && !host.password) return undefined
  return `Basic ${Buffer.from(`${host.username ?? ""}:${host.password ?? ""}`).toString("base64")}`
}

/**
 * Fan one long-lived managed-agent SSE connection out to any number of app clients.
 *
 * OpenCode attaches one GlobalBus listener per `/global/event` subscriber. Android background /
 * foreground transitions and short network losses used to tear down and recreate the upstream
 * subscription for every phone reconnect. Keeping the upstream connection daemon-owned means a
 * client reconnect changes only the downstream set; it cannot multiply OpenCode listeners.
 */
export class ManagedEventFanout {
  constructor({
    host,
    path,
    ensureAvailable,
    requestImpl = http.request,
    reconnectMinMs = DEFAULT_RECONNECT_MIN_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
    heartbeatMs = DEFAULT_HEARTBEAT_MS
  }) {
    this.host = host
    this.path = path
    this.ensureAvailable = ensureAvailable
    this.requestImpl = requestImpl
    this.reconnectMinMs = reconnectMinMs
    this.reconnectMaxMs = reconnectMaxMs
    this.heartbeatMs = heartbeatMs
    this.clients = new Set()
    this.upstreamRequest = undefined
    this.upstreamResponse = undefined
    this.reconnectTimer = undefined
    this.connecting = false
    this.closed = false
    this.everStarted = false
    this.reconnectAttempt = 0
    this.reconnects = 0
    this.lastConnectedAt = null
    this.lastDisconnectedAt = null
    this.lastError = null
    this.heartbeat = setInterval(() => this.#broadcast(": daemon ping\n\n"), heartbeatMs)
    this.heartbeat.unref?.()
  }

  subscribe(request, response) {
    if (this.closed) throw new Error("Managed event fanout is closed")
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive"
    })
    response.write(": connected through Harness daemon\n\n")
    const client = { request, response }
    this.clients.add(client)
    this.everStarted = true

    let removed = false
    const remove = () => {
      if (removed) return
      removed = true
      this.clients.delete(client)
      request.off("aborted", remove)
      response.off("close", remove)
    }
    // IncomingMessage `close` can describe completion of the request body rather than the lifetime
    // of the streaming response. The downstream SSE is owned until the client aborts or the response
    // itself closes.
    request.once("aborted", remove)
    response.once("close", remove)

    this.#ensureUpstream()
    return remove
  }

  diagnostics() {
    return {
      path: this.path,
      downstreamClients: this.clients.size,
      upstreamStreams: this.upstreamRequest ? 1 : 0,
      connecting: this.connecting,
      reconnectScheduled: Boolean(this.reconnectTimer),
      reconnects: this.reconnects,
      lastConnectedAt: this.lastConnectedAt,
      lastDisconnectedAt: this.lastDisconnectedAt,
      lastError: this.lastError
    }
  }

  close() {
    if (this.closed) return
    this.closed = true
    clearInterval(this.heartbeat)
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.upstreamResponse?.destroy()
    this.upstreamRequest?.destroy()
    this.upstreamResponse = undefined
    this.upstreamRequest = undefined
    for (const client of this.clients) client.response.destroy()
    this.clients.clear()
  }

  #broadcast(chunk) {
    for (const client of [...this.clients]) {
      if (client.response.destroyed || client.response.writableEnded) {
        this.clients.delete(client)
        continue
      }
      try {
        client.response.write(chunk)
      } catch {
        this.clients.delete(client)
      }
    }
  }

  async #ensureUpstream() {
    if (this.closed || this.connecting || this.upstreamRequest || this.reconnectTimer || !this.everStarted) return
    this.connecting = true
    try {
      const availability = await this.ensureAvailable?.()
      if (availability && availability.ok === false) {
        throw availability.error ?? new Error("Managed agent is unavailable")
      }
      if (this.closed) return
      this.#openUpstream()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.#scheduleReconnect()
    } finally {
      this.connecting = false
    }
  }

  #openUpstream() {
    const authorization = internalAuthorization(this.host)
    const upstream = this.requestImpl({
      host: this.host.readinessHost ?? this.host.host ?? "127.0.0.1",
      port: this.host.port,
      method: "GET",
      path: this.path,
      headers: {
        Accept: "text/event-stream",
        ...(authorization ? { Authorization: authorization } : {})
      }
    }, (incoming) => {
      if (incoming.statusCode !== 200) {
        incoming.resume?.()
        this.#upstreamEnded(new Error(`Managed event stream returned HTTP ${incoming.statusCode ?? "unknown"}`))
        return
      }
      this.upstreamResponse = incoming
      this.reconnectAttempt = 0
      this.lastError = null
      this.lastConnectedAt = new Date().toISOString()
      incoming.on("data", (chunk) => this.#broadcast(chunk))
      incoming.once("end", () => this.#upstreamEnded(new Error("Managed event stream ended")))
      incoming.once("aborted", () => this.#upstreamEnded(new Error("Managed event stream was aborted")))
      incoming.once("error", (error) => this.#upstreamEnded(error))
    })
    this.upstreamRequest = upstream
    upstream.once("error", (error) => this.#upstreamEnded(error))
    upstream.end()
  }

  #upstreamEnded(error) {
    if (this.closed) return
    const hadConnection = Boolean(this.upstreamRequest || this.upstreamResponse)
    this.upstreamResponse?.destroy()
    this.upstreamRequest?.destroy()
    this.upstreamResponse = undefined
    this.upstreamRequest = undefined
    this.lastDisconnectedAt = new Date().toISOString()
    this.lastError = error instanceof Error ? error.message : String(error)
    if (hadConnection) this.reconnects += 1
    this.#scheduleReconnect()
  }

  #scheduleReconnect() {
    if (this.closed || this.reconnectTimer || !this.everStarted) return
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** this.reconnectAttempt)
    this.reconnectAttempt += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.#ensureUpstream()
    }, delay)
    this.reconnectTimer.unref?.()
  }
}