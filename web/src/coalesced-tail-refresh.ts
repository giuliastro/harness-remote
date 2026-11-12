export type TailRefreshWork = () => Promise<void>

/**
 * A tail read that has not settled after this long is treated as stuck. Ordinary reads finish in
 * well under a second; the request layer's own deadline is 30 s, so this only ever fires for a read
 * that a lower layer failed to end.
 */
export const TAIL_REFRESH_STALL_MS = 35_000

/**
 * Serialize authoritative transcript-tail reads and retain one trailing read when events arrive
 * while a read is already in flight. The pending slot always keeps the newest work item, so a burst
 * of streamed chunks becomes at most one extra authoritative read instead of either overlapping
 * loads or silently dropping the final event.
 *
 * A read that never settles must not hold the queue forever: every later live event, poll and
 * foreground return used to wait behind it, freezing an open Session until the user navigated away
 * and back. After `stallMs` the drain stops waiting for it and runs the newest pending read. The
 * abandoned read may still finish later; applying a tail is idempotent, so that is harmless.
 */
export function createCoalescedTailRefresh(
  { stallMs = TAIL_REFRESH_STALL_MS }: { stallMs?: number } = {}
): (work: TailRefreshWork) => Promise<void> {
  let pending: TailRefreshWork | null = null
  let drainPromise: Promise<void> | null = null

  const settleOrStall = (work: TailRefreshWork) => new Promise<void>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      resolve()
    }, stallMs)
    const finish = (callback: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      callback()
    }
    let running: Promise<void>
    try {
      running = Promise.resolve(work())
    } catch (error) {
      finish(() => reject(error))
      return
    }
    running.then(() => finish(resolve), (error) => finish(() => reject(error)))
  })

  return function refresh(work: TailRefreshWork): Promise<void> {
    pending = work
    if (!drainPromise) {
      drainPromise = (async () => {
        let firstFailure: unknown
        while (pending) {
          const next = pending
          pending = null
          try {
            await settleOrStall(next)
          } catch (error) {
            if (firstFailure === undefined) firstFailure = error
          }
        }
        if (firstFailure !== undefined) throw firstFailure
      })().finally(() => {
        drainPromise = null
      })
    }
    return drainPromise
  }
}
