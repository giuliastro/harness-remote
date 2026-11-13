/**
 * Turns successive `/session/status` snapshots of one harness into turn outcomes.
 *
 * Only an observed edge counts: a Session must be seen working before it can be reported ready or
 * failed. The first snapshot of a harness is a baseline, so opening the app never announces the
 * Sessions that were already idle, and a Session absent from a snapshot is left alone rather than
 * read as finished. One turn produces at most one outcome, however many polls observe its end.
 */
export type SessionOutcome = { kind: "ready" | "failed"; sessionID: string }

type SessionStatusSnapshot = Record<string, { type?: string } | string | undefined>

const WORKING = new Set(["busy", "retry", "starting", "working", "running"])
const FAILED = new Set(["error", "failed"])

export function sessionStatusType(value: SessionStatusSnapshot[string]): string {
  const raw = typeof value === "string" ? value : value?.type
  return typeof raw === "string" ? raw.trim().toLowerCase() : ""
}

export class SessionOutcomeTracker {
  private readonly scopes = new Map<string, Map<string, string>>()

  /** Record a snapshot for one harness scope and return the turns that just ended in it. */
  observe(scope: string, snapshot: SessionStatusSnapshot): SessionOutcome[] {
    const previous = this.scopes.get(scope)
    const next = new Map<string, string>()
    const outcomes: SessionOutcome[] = []
    for (const [sessionID, value] of Object.entries(snapshot)) {
      const status = sessionStatusType(value)
      if (!status) continue
      next.set(sessionID, status)
      const before = previous?.get(sessionID)
      if (!before || !WORKING.has(before) || WORKING.has(status)) continue
      if (FAILED.has(status)) outcomes.push({ kind: "failed", sessionID })
      else outcomes.push({ kind: "ready", sessionID })
    }
    // Keep a working Session that dropped out of this snapshot: a status list can omit a Session for
    // one read, and forgetting it would lose the end of its turn.
    if (previous) {
      for (const [sessionID, status] of previous) {
        if (!next.has(sessionID) && WORKING.has(status)) next.set(sessionID, status)
      }
    }
    this.scopes.set(scope, next)
    return outcomes
  }

  /** Forget scopes that no longer exist (machine removed, harness gone). */
  retain(scopes: Iterable<string>): void {
    const keep = new Set(scopes)
    for (const scope of [...this.scopes.keys()]) if (!keep.has(scope)) this.scopes.delete(scope)
  }

  hasWork(scope: string): boolean {
    const statuses = this.scopes.get(scope)
    if (!statuses) return false
    for (const status of statuses.values()) if (WORKING.has(status)) return true
    return false
  }
}
