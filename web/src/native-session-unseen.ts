/**
 * Which finished Sessions the user has not clicked yet.
 *
 * A Session is marked when the rail sees it go from working to ready - the one already open too -
 * and stays marked until the user clicks it; the open one clears at the user's next interaction
 * with the page instead. Only that observed edge counts: comparing harness
 * timestamps flagged old Sessions whenever a harness moved its `updated` time without a new turn
 * (opening a Session, or a listing with no time at all), so the marks are deliberately in-memory
 * and start empty on every load.
 */

export type SessionRailState = "working" | "attention" | "stopped" | "ready"

/**
 * The marked Sessions after one rail update. A Session that leaves ready - a new turn, an input
 * request - drops its mark, because its row then shows that state instead.
 */
export function nextFinishedKeys(
  finished: ReadonlySet<string>,
  previous: ReadonlyMap<string, SessionRailState>,
  current: ReadonlyMap<string, SessionRailState>
): ReadonlySet<string> {
  const next = new Set<string>()
  for (const key of finished) {
    const state = current.get(key)
    // A Session missing from this update (an unloaded page, a filter) keeps its mark.
    if (state === undefined || state === "ready") next.add(key)
  }
  for (const [key, state] of current) {
    if (state === "ready" && previous.get(key) === "working") next.add(key)
  }
  if (next.size === finished.size && [...next].every((key) => finished.has(key))) return finished
  return next
}

/** The marked Sessions once the user has clicked `key`. */
export function withoutFinishedKey(finished: ReadonlySet<string>, key: string): ReadonlySet<string> {
  if (!finished.has(key)) return finished
  const next = new Set(finished)
  next.delete(key)
  return next
}
