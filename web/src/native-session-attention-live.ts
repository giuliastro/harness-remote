import { nativeSessionConfig } from "./native-session-discovery"
import { subscribeTaskDeskLiveEvents } from "./taskdesk-live-events"
import type { MachineAgentHost, ServerConfig } from "./types"

export type NativeSessionAttentionLiveTarget = {
  key: string
  baseConfig: ServerConfig
  agent: MachineAgentHost
}

type Subscribe = typeof subscribeTaskDeskLiveEvents
type Timer = ReturnType<typeof setTimeout>

function supportsAttention(agent: MachineAgentHost): boolean {
  return agent.capabilities.questions === true || agent.capabilities.permissions === true
}

function isAttentionEvent(type: string): boolean {
  return type.startsWith("question.") || type.startsWith("permission.")
}

/**
 * Subscribe only to harnesses that advertise an explicit question/permission capability and turn
 * their lifecycle events into a small, coalesced attention-index refresh. This controller is
 * intentionally separate from the selected-Session live controller: refreshing attention must not
 * imply a transcript read, conversation reconciliation or any writer operation.
 */
export function startNativeSessionAttentionLiveRefresh({
  targets,
  onRefresh,
  subscribe = subscribeTaskDeskLiveEvents,
  delayMs = 100
}: {
  targets: NativeSessionAttentionLiveTarget[]
  onRefresh: (target: NativeSessionAttentionLiveTarget) => void
  subscribe?: Subscribe
  delayMs?: number
}): { close(): void } {
  let closed = false
  const timers = new Map<string, Timer>()

  const schedule = (target: NativeSessionAttentionLiveTarget) => {
    if (closed || timers.has(target.key)) return
    const timer = setTimeout(() => {
      timers.delete(target.key)
      if (!closed) onRefresh(target)
    }, Math.max(0, delayMs))
    timers.set(target.key, timer)
  }

  const subscriptions = targets
    .filter(({ agent }) => supportsAttention(agent))
    .map((target) => subscribe({
      config: nativeSessionConfig(target.baseConfig, target.agent),
      onEvent: (event) => {
        if (isAttentionEvent(event.type)) schedule(target)
      },
      // A reconnect proves an event gap may have happened while the transport was unavailable.
      // Re-read the tiny attention list once; do not wait for another permission/question edge.
      onStatus: (status) => {
        if (status.type === "connected") schedule(target)
      }
    }))

  return {
    close() {
      if (closed) return
      closed = true
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const subscription of subscriptions) subscription.close()
    }
  }
}
