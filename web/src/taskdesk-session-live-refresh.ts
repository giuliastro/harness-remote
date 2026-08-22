import type { SavedServerProfile } from "./serverProfiles"
import { subscribeTaskDeskLiveEvents } from "./taskdesk-live-events"
import type { ServerConfig } from "./types"

export type SessionLiveTarget = {
  key: string
  profile: SavedServerProfile
  config: ServerConfig
}

export type SelectedLiveSession = {
  targetKey: string
  sessionID: string
}

type Timer = ReturnType<typeof setTimeout>

function isAttentionEvent(type: string): boolean {
  return type.startsWith("permission.") || type.startsWith("question.")
}

/**
 * Drive Session freshness from the existing per-agent event stream without turning every streamed
 * token into a full workspace refresh. Message chunks refresh only the selected transcript tail;
 * lifecycle events refresh the lightweight index and, for the selected Session, its detail data.
 * Polling remains a slow reconciliation fallback in the owning React component.
 */
export function startTaskDeskSessionLiveRefresh({
  targets,
  getSelected,
  onMessage,
  onIndex,
  onDetail
}: {
  targets: SessionLiveTarget[]
  getSelected: () => SelectedLiveSession | null
  onMessage: () => void
  onIndex: () => void
  onDetail: () => void
}): { close(): void } {
  let closed = false
  let messageTimer: Timer | undefined
  let indexTimer: Timer | undefined
  let detailTimer: Timer | undefined

  const throttle = (kind: "message" | "index" | "detail", delay: number, callback: () => void) => {
    if (closed) return
    const current = kind === "message" ? messageTimer : kind === "index" ? indexTimer : detailTimer
    if (current !== undefined) return
    const timer = setTimeout(() => {
      if (kind === "message") messageTimer = undefined
      else if (kind === "index") indexTimer = undefined
      else detailTimer = undefined
      if (!closed) callback()
    }, delay)
    if (kind === "message") messageTimer = timer
    else if (kind === "index") indexTimer = timer
    else detailTimer = timer
  }

  const subscriptions = targets.map((target) => subscribeTaskDeskLiveEvents({
    profile: target.profile,
    config: target.config,
    onEvent: (event) => {
      const selected = getSelected()
      const selectedEvent = Boolean(
        selected
        && selected.targetKey === target.key
        && event.sessionID
        && selected.sessionID === event.sessionID
      )

      if (event.type === "message.updated" || event.type === "message.part.updated" || event.type === "message.part.delta") {
        if (selectedEvent) throttle("message", 140, onMessage)
        return
      }

      // OpenCode and ACP adapters can expose permission/question lifecycle events with different
      // suffixes. They all mean the selected conversation detail must be re-read immediately.
      if (isAttentionEvent(event.type)) {
        if (selectedEvent) throttle("detail", 80, onDetail)
        return
      }

      if (event.type === "todo.updated") {
        if (selectedEvent) throttle("detail", 300, onDetail)
        return
      }

      if (event.type === "session.updated") {
        throttle("index", 450, onIndex)
        if (selectedEvent) throttle("detail", 450, onDetail)
        return
      }

      if (event.type === "session.created" || event.type === "session.deleted") {
        throttle("index", 250, onIndex)
        return
      }

      if (event.type === "session.error" && selectedEvent) {
        throttle("message", 140, onMessage)
        throttle("detail", 250, onDetail)
      }
    },
    onStatus: (status) => {
      if (status.type !== "connected") return
      throttle("index", 100, onIndex)
      const selected = getSelected()
      if (selected?.targetKey === target.key) throttle("detail", 100, onDetail)
    }
  }))

  return {
    close() {
      if (closed) return
      closed = true
      if (messageTimer !== undefined) clearTimeout(messageTimer)
      if (indexTimer !== undefined) clearTimeout(indexTimer)
      if (detailTimer !== undefined) clearTimeout(detailTimer)
      for (const subscription of subscriptions) subscription.close()
    }
  }
}
