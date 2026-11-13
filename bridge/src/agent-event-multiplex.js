import http from "node:http"

export const AGENT_EVENT_MULTIPLEX_PATH = "/v1/events/agents"
export const AGENT_EVENT_NAME = "hr.agent-event"
export const AGENT_STATUS_NAME = "hr.agent-status"
const MAX_AGENTS = 32
const RECONNECT_MIN_MS = 500
const RECONNECT_MAX_MS = 10_000
const HEARTBEAT_MS = 10_000

/**
 * One SSE response carrying the live events of several harnesses.
 *
 * A browser allows six concurrent HTTP/1.1 connections per origin. With one event stream per
 * harness, a machine with six or more harnesses filled every slot and the browser queued every
 * other request - the Session list, status reads, transcripts - behind streams that never end.
 * This endpoint keeps one connection per machine: it subscribes to each harness's own
 * `/v1/agents/<id>/global/event` inside the daemon and forwards each upstream frame verbatim, tagged
 * with its harness, so clients parse it exactly as before.
 *
 * Each frame is `event: hr.agent-event` with `{ agentID, frame }`; per-harness connection changes
 * are `event: hr.agent-status` with `{ agentID, status: "connected" | "disconnected" }`.
 */
export function parseRequestedAgents(searchParams, knownAgentIDs) {
  const known = new Set(knownAgentIDs)
  const requested = (searchParams.get("agents") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
  return [...new Set(requested)].filter((agentID) => known.has(agentID)).slice(0, MAX_AGENTS)
}

function frameEvent(name, payload) {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`
}

export function serveAgentEventMultiplex({
  request,
  response,
  agentIDs,
  upstream,
  heartbeatMs = HEARTBEAT_MS,
  reconnectMinMs = RECONNECT_MIN_MS,
  reconnectMaxMs = RECONNECT_MAX_MS,
  requestImpl = http.request
}) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive"
  })
  response.write(": connected through Harness daemon multiplex\n\n")
  let closed = false
  const write = (chunk) => {
    if (closed || response.destroyed || response.writableEnded) return
    try { response.write(chunk) } catch { /* the client is gone; close() follows */ }
  }
  const heartbeat = setInterval(() => write(": daemon ping\n\n"), heartbeatMs)
  heartbeat.unref?.()

  const streams = agentIDs.map((agentID) => {
    const state = { agentID, request: undefined, timer: undefined, attempt: 0, connected: false, buffer: "" }
    const setConnected = (connected) => {
      if (state.connected === connected) return
      state.connected = connected
      write(frameEvent(AGENT_STATUS_NAME, { agentID, status: connected ? "connected" : "disconnected" }))
    }
    const scheduleReconnect = () => {
      if (closed || state.timer) return
      const delay = Math.min(reconnectMaxMs, reconnectMinMs * 2 ** state.attempt)
      state.attempt += 1
      state.timer = setTimeout(() => {
        state.timer = undefined
        open()
      }, delay)
      state.timer.unref?.()
    }
    const ended = () => {
      if (!state.request) return
      state.request.destroy()
      state.request = undefined
      state.buffer = ""
      setConnected(false)
      scheduleReconnect()
    }
    const open = () => {
      if (closed) return
      const outgoing = requestImpl({
        host: upstream.host,
        port: upstream.port,
        method: "GET",
        path: `/v1/agents/${encodeURIComponent(agentID)}/global/event`,
        headers: { Accept: "text/event-stream", ...(upstream.authorization ? { Authorization: upstream.authorization } : {}) }
      }, (incoming) => {
        if (incoming.statusCode !== 200) {
          incoming.resume?.()
          ended()
          return
        }
        state.attempt = 0
        setConnected(true)
        incoming.setEncoding?.("utf8")
        incoming.on("data", (chunk) => {
          state.buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
          let boundary = state.buffer.search(/\r?\n\r?\n/)
          while (boundary !== -1) {
            const frame = state.buffer.slice(0, boundary)
            state.buffer = state.buffer.slice(boundary).replace(/^\r?\n\r?\n/, "")
            // Comments (heartbeats, connect banners) carry nothing a client acts on; this response
            // already sends its own heartbeat.
            if (frame.split(/\r?\n/).some((line) => line && !line.startsWith(":"))) {
              write(frameEvent(AGENT_EVENT_NAME, { agentID, frame }))
            }
            boundary = state.buffer.search(/\r?\n\r?\n/)
          }
          if (state.buffer.length > 4_000_000) state.buffer = ""
        })
        incoming.once("end", ended)
        incoming.once("aborted", ended)
        incoming.once("error", ended)
      })
      state.request = outgoing
      outgoing.once("error", ended)
      outgoing.end()
    }
    return { state, open }
  })

  const close = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    for (const { state } of streams) {
      clearTimeout(state.timer)
      state.request?.destroy()
      state.request = undefined
    }
  }
  request.once("aborted", close)
  response.once("close", close)
  for (const stream of streams) stream.open()
  return close
}
