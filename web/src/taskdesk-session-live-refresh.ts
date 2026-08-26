import { App as CapacitorApp } from "@capacitor/app"
import { Capacitor, type PluginListenerHandle } from "@capacitor/core"
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

const FOREGROUND_DEDUP_MS = 500
const DEFAULT_LIFECYCLE_SETTLE_DELAYS_MS = [900] as const
// OMP can emit its final session.updated before the JSONL writer has made the last assistant words
// durable. One follow-up read was therefore occasionally still too early, leaving the mounted reply
// truncated until navigation forced a fresh load. Keep a short, finite convergence window for OMP
// only; all other harnesses retain the single existing settle read.
const OMP_LIFECYCLE_SETTLE_DELAYS_MS = [350, 900, 1_800, 3_200] as const

function isAttentionEvent(type: string): boolean {
  return type.startsWith("permission.") || type.startsWith("question.")
}

/**
 * Drive Session freshness from the existing per-agent event stream without turning every streamed
 * token into a full workspace refresh. Message chunks refresh only the selected transcript tail;
 * lifecycle events refresh the lightweight index and, for the selected Session, its detail data.
 *
 * Android can suspend the WebView while the native SSE reader keeps consuming events. Those events
 * are then legitimately absent from the renderer when the app comes back, so waiting for the next
 * event or interval can leave an already-finished Conversation painted as still working. Foreground
 * transitions therefore force an authoritative index/detail/transcript reconciliation immediately.
 * Polling remains the slow fallback while the page stays visible.
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
  let foregroundTimer: Timer | undefined
  let lifecycleSettleTimer: Timer | undefined
  let lifecycleSettleGeneration = 0
  let lastForegroundRefreshAt = 0
  let appStateHandle: PluginListenerHandle | undefined

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

  /**
   * A harness may publish its lifecycle edge before the final assistant envelope is durable through
   * `/session/:id/message`. Keep bounded, coalesced settle reads after the latest lifecycle edge so
   * the already-mounted Session gets another authoritative chance without permanent fast polling.
   *
   * OMP gets a few additional reads because its JSONL durability can lag the ACP lifecycle edge by
   * more than the original 900ms. The selected Session identity is captured so leaving that Session
   * cancels the old convergence chain instead of refreshing whichever Session was opened next.
   */
  const settleAfterLifecycle = () => {
    const selectedAtSchedule = getSelected()
    if (closed || !selectedAtSchedule) return
    if (lifecycleSettleTimer !== undefined) clearTimeout(lifecycleSettleTimer)
    const generation = ++lifecycleSettleGeneration
    const target = targets.find((candidate) => candidate.key === selectedAtSchedule.targetKey)
    const delays = target?.config.backend === "omp"
      ? OMP_LIFECYCLE_SETTLE_DELAYS_MS
      : DEFAULT_LIFECYCLE_SETTLE_DELAYS_MS

    const scheduleAttempt = (index: number) => {
      lifecycleSettleTimer = setTimeout(() => {
        lifecycleSettleTimer = undefined
        if (closed || lifecycleSettleGeneration !== generation) return
        const selectedNow = getSelected()
        if (
          !selectedNow
          || selectedNow.targetKey !== selectedAtSchedule.targetKey
          || selectedNow.sessionID !== selectedAtSchedule.sessionID
        ) return

        onMessage()
        const finalAttempt = index === delays.length - 1
        if (finalAttempt) onIndex()
        if (!finalAttempt) scheduleAttempt(index + 1)
      }, delays[index])
    }

    scheduleAttempt(0)
  }

  const reconcileAfterForeground = () => {
    if (closed) return
    const now = Date.now()
    if (foregroundTimer !== undefined || now - lastForegroundRefreshAt < FOREGROUND_DEDUP_MS) return
    foregroundTimer = setTimeout(() => {
      foregroundTimer = undefined
      if (closed) return
      lastForegroundRefreshAt = Date.now()
      // The index callback owns the authoritative Conversation re-read. The selected transcript and
      // attention callbacks are fired too so callers that keep those surfaces independent recover in
      // the same foreground turn instead of waiting for another SSE event or polling interval.
      onIndex()
      if (getSelected()) {
        onMessage()
        onDetail()
      }
    }, 0)
  }

  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") reconcileAfterForeground()
  }
  const onPageShow = () => reconcileAfterForeground()

  if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibilityChange)
  if (typeof window !== "undefined") window.addEventListener("pageshow", onPageShow)

  // `visibilitychange` is normally delivered by Android WebView, but appStateChange is the native
  // lifecycle authority. Listen to both and deduplicate them because device/ROM behavior differs.
  if (Capacitor.getPlatform() === "android") {
    void CapacitorApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) reconcileAfterForeground()
    }).then((handle) => {
      if (closed) void handle.remove()
      else appStateHandle = handle
    }).catch(() => undefined)
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

      // OpenCode's authoritative turn lifecycle is session.status. The deprecated session.idle event
      // is still accepted because older OpenCode releases emit it. The immediate tail read covers the
      // normal case; the bounded settle read covers real servers where transcript durability lags the
      // lifecycle edge and no convenient final message.updated is emitted.
      if (event.type === "session.status" || event.type === "session.idle") {
        throttle("index", 120, onIndex)
        if (selectedEvent) {
          throttle("message", 80, onMessage)
          settleAfterLifecycle()
        }
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

      // ACP-backed harnesses use session.updated for both the busy edge and the final idle edge. The
      // final edge may be the only signal after the last streamed chunk, so treating it as index-only
      // can leave the mounted transcript on a stale prefix until navigation forces a fresh read.
      if (event.type === "session.updated") {
        throttle("index", 450, onIndex)
        if (selectedEvent) {
          throttle("message", 80, onMessage)
          throttle("detail", 450, onDetail)
          settleAfterLifecycle()
        }
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
      if (selected?.targetKey === target.key) {
        // A reconnect proves that an event gap may have happened. Re-read the selected native tail
        // once instead of waiting for a future token that may never arrive after a completed turn.
        throttle("message", 100, onMessage)
        throttle("detail", 100, onDetail)
      }
    }
  }))

  return {
    close() {
      if (closed) return
      closed = true
      lifecycleSettleGeneration += 1
      if (messageTimer !== undefined) clearTimeout(messageTimer)
      if (indexTimer !== undefined) clearTimeout(indexTimer)
      if (detailTimer !== undefined) clearTimeout(detailTimer)
      if (foregroundTimer !== undefined) clearTimeout(foregroundTimer)
      if (lifecycleSettleTimer !== undefined) clearTimeout(lifecycleSettleTimer)
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibilityChange)
      if (typeof window !== "undefined") window.removeEventListener("pageshow", onPageShow)
      if (appStateHandle) void appStateHandle.remove()
      for (const subscription of subscriptions) subscription.close()
    }
  }
}
