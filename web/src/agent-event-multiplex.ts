import { createFetchOpenCodeEventSubscription, parseSSEFrame, type EventStreamStatus } from "./opencode-events"

/**
 * Browser-only: every per-harness live stream of one machine shares a single connection.
 *
 * A browser allows six concurrent HTTP/1.1 connections per origin, and an SSE stream holds one for
 * as long as the page lives. With one stream per harness, a machine with six harnesses used every
 * slot, so the Session list, status reads and transcripts queued behind streams that never end:
 * Sessions took minutes to appear and notifications never fired. The daemon's `/v1/events/agents`
 * endpoint forwards each harness's frames tagged with its id; here they are handed back to the
 * per-harness subscribers exactly as a direct stream would have delivered them.
 *
 * A daemon without the endpoint answers 404; that machine then falls back to one stream per harness.
 */

type SSEEvent = { name?: string; data: unknown }

export type MultiplexedAgentSubscription = {
  /** The daemon root, without any `/v1/agents/<id>` scope. */
  machineURL: string
  headers?: Record<string, string>
  agentID: string
  onEvent: (event: SSEEvent) => void
  onStatus?: (status: EventStreamStatus) => void
  /** A direct per-harness stream, used when the daemon has no multiplex endpoint. */
  fallback: () => { close(): void }
}

type Subscriber = MultiplexedAgentSubscription & { closed: boolean; direct?: { close(): void } }

type Group = {
  key: string
  machineURL: string
  headers?: Record<string, string>
  subscribers: Set<Subscriber>
  transport?: { close(): void }
  transportAgents: string
  reopenTimer?: ReturnType<typeof setTimeout>
  agentConnected: Map<string, boolean>
  unsupported: boolean
}

type Connect = typeof createFetchOpenCodeEventSubscription

const MULTIPLEX_PATH = "/v1/events/agents"
const REOPEN_DEBOUNCE_MS = 40

function groupKey(machineURL: string, headers?: Record<string, string>): string {
  const normalized = Object.entries(headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .sort(([left], [right]) => left.localeCompare(right))
  return `${machineURL}\u0000${JSON.stringify(normalized)}`
}

export function createAgentEventMultiplexer(connect: Connect = createFetchOpenCodeEventSubscription) {
  const groups = new Map<string, Group>()

  const safely = (callback: () => void) => {
    try { callback() } catch { /* one subscriber must not break the others */ }
  }

  const agentsOf = (group: Group) => [...new Set([...group.subscribers].map((subscriber) => subscriber.agentID))].sort()

  const goDirect = (group: Group) => {
    group.unsupported = true
    group.transport?.close()
    group.transport = undefined
    group.transportAgents = ""
    for (const subscriber of group.subscribers) {
      if (!subscriber.closed && !subscriber.direct) subscriber.direct = subscriber.fallback()
    }
  }

  const open = (group: Group) => {
    group.reopenTimer = undefined
    const agents = agentsOf(group)
    const signature = agents.join(",")
    if (group.unsupported || signature === group.transportAgents) return
    group.transport?.close()
    group.transport = undefined
    group.transportAgents = signature
    group.agentConnected.clear()
    if (agents.length === 0) return
    const url = new URL(group.machineURL)
    url.pathname = `${url.pathname.replace(/\/$/, "")}${MULTIPLEX_PATH}`
    url.search = ""
    url.searchParams.set("agents", signature)
    group.transport = connect({
      url: url.toString(),
      headers: group.headers,
      onEvent: (event) => {
        const payload = event.data as { agentID?: unknown; frame?: unknown; status?: unknown } | undefined
        const agentID = typeof payload?.agentID === "string" ? payload.agentID : ""
        if (!agentID) return
        if (event.name === "hr.agent-status") {
          const connected = payload?.status === "connected"
          group.agentConnected.set(agentID, connected)
          const status: EventStreamStatus = connected ? { type: "connected" } : { type: "reconnecting", delayMs: 1_000 }
          for (const subscriber of group.subscribers) {
            if (subscriber.agentID === agentID && !subscriber.closed) safely(() => subscriber.onStatus?.(status))
          }
          return
        }
        if (event.name !== "hr.agent-event" || typeof payload?.frame !== "string") return
        const inner = parseSSEFrame(payload.frame)
        if (!inner?.ok) return
        for (const subscriber of group.subscribers) {
          if (subscriber.agentID === agentID && !subscriber.closed) {
            safely(() => subscriber.onEvent({ name: inner.name, data: inner.data }))
          }
        }
      },
      onStatus: (status) => {
        if (status.type === "connection-error" && /\bHTTP (404|405)\b/.test(status.error)) {
          goDirect(group)
          return
        }
        // The multiplex itself connecting says nothing about a harness; its own status frame does.
        if (status.type === "connected") return
        group.agentConnected.clear()
        for (const subscriber of group.subscribers) {
          if (!subscriber.closed) safely(() => subscriber.onStatus?.(status))
        }
      }
    })
  }

  const scheduleOpen = (group: Group) => {
    if (group.unsupported) return
    if (group.reopenTimer) clearTimeout(group.reopenTimer)
    // Navigation mounts and unmounts several subscriptions in one render; reconnect once for all.
    group.reopenTimer = setTimeout(() => open(group), REOPEN_DEBOUNCE_MS)
  }

  return {
    subscribe(subscription: MultiplexedAgentSubscription): { close(): void } {
      const key = groupKey(subscription.machineURL, subscription.headers)
      let group = groups.get(key)
      if (!group) {
        group = {
          key,
          machineURL: subscription.machineURL,
          headers: subscription.headers,
          subscribers: new Set(),
          transportAgents: "",
          agentConnected: new Map(),
          unsupported: false
        }
        groups.set(key, group)
      }
      const subscriber: Subscriber = { ...subscription, closed: false }
      group.subscribers.add(subscriber)
      if (group.unsupported) {
        subscriber.direct = subscription.fallback()
      } else {
        if (group.agentConnected.get(subscription.agentID)) {
          safely(() => subscription.onStatus?.({ type: "connected" }))
        }
        scheduleOpen(group)
      }
      const owner = group
      return {
        close() {
          if (subscriber.closed) return
          subscriber.closed = true
          subscriber.direct?.close()
          owner.subscribers.delete(subscriber)
          if (owner.subscribers.size === 0) {
            if (owner.reopenTimer) clearTimeout(owner.reopenTimer)
            owner.transport?.close()
            groups.delete(owner.key)
            return
          }
          scheduleOpen(owner)
        }
      }
    }
  }
}
