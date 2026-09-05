/**
 * Machine snapshots used to refresh on a fixed 10s timer even though every machine already carries
 * a live event stream, so an agent that finished a turn took up to ten seconds to show it. These
 * rules let the stream drive the refresh and keep the timer as the fallback it was meant to be.
 */

/** A machine is flapping: probe aggressively until it settles either way. */
export const MACHINE_RECONNECT_POLL_MS = 1_500
/** No live stream (transport down, or a platform without one): the historical cadence. */
export const MACHINE_NORMAL_POLL_MS = 10_000
/** Every machine is streaming, so this is only a safety net against a missed event. */
export const MACHINE_STREAM_POLL_MS = 60_000
/**
 * One agent turn emits a burst of part/message events. Refreshing per event would hammer
 * /v1/machine, so collapse a burst into one leading and one trailing refresh.
 */
export const MACHINE_LIVE_REFRESH_BURST_MS = 400
/**
 * A stream in any of these states is recovering or flapping. While recovery is in flight, poll
 * machine snapshots aggressively instead of waiting out the normal cadence.
 */
export function isStreamReconnecting(status: string | { type: string } | undefined | null): boolean {
  if (!status) return false
  const type = typeof status === "string" ? status : status.type
  return type === "reconnecting" || type === "connection-error" || type === "closed"
}

export function machinePollIntervalMs({
  reconnecting,
  machineCount,
  connectedStreamCount
}: {
  reconnecting: boolean
  machineCount: number
  connectedStreamCount: number
}): number {
  if (reconnecting) return MACHINE_RECONNECT_POLL_MS
  // Partial coverage still needs the normal cadence: the machines without a stream are exactly the
  // ones whose state changes would otherwise go unnoticed.
  if (machineCount > 0 && connectedStreamCount >= machineCount) return MACHINE_STREAM_POLL_MS
  return MACHINE_NORMAL_POLL_MS
}

/**
 * Scheduler seam. Generic in the handle so no platform timer type leaks into this contract: the
 * browser hands back a number and node a Timeout, and tests hand back whatever they count with.
 */
export interface RefreshTimers<Handle> {
  set(callback: () => void, delayMs: number): Handle
  clear(handle: Handle): void
}

export interface BurstLimiter {
  /** Run now if idle, otherwise replace the trailing run scheduled for the end of the window. */
  request(run: () => void): void
  cancel(): void
}

const platformTimers: RefreshTimers<number> = {
  set: (callback, delayMs) => setTimeout(callback, delayMs) as unknown as number,
  clear: (handle) => clearTimeout(handle)
}

/**
 * Leading-edge rate limiter: the first request runs immediately so the UI reacts to an event
 * without waiting out a debounce, and anything arriving during the cooldown collapses into a single
 * trailing run. Retaining only the newest callback matches the coalesced tail refresh already used
 * for transcripts.
 */
export function createBurstLimiter<Handle = number>(
  windowMs: number,
  timers: RefreshTimers<Handle> = platformTimers as unknown as RefreshTimers<Handle>
): BurstLimiter {
  let cooldown: Handle | undefined
  let queued: (() => void) | undefined

  const startCooldown = () => {
    cooldown = timers.set(() => {
      cooldown = undefined
      const run = queued
      queued = undefined
      if (!run) return
      run()
      startCooldown()
    }, windowMs)
  }

  return {
    request(run: () => void) {
      if (cooldown === undefined) {
        run()
        startCooldown()
        return
      }
      queued = run
    },
    cancel() {
      if (cooldown !== undefined) timers.clear(cooldown)
      cooldown = undefined
      queued = undefined
    }
  }
}
