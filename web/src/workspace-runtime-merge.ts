/*
 * Workspace poll reconciliation.
 *
 * The Conversation workspace re-discovers every configured machine on a 10s cadence. Before this
 * module the poll replaced the whole runtime list with freshly allocated objects even when nothing
 * had changed, so every ten seconds:
 *
 * - the `conversations`/`projects`/`agents` arrays got new identities, which invalidated the
 *   downstream memos and re-rendered the open Conversation, its transcript and its toolbar;
 * - a machine that was already known to be offline was flipped back to `loading`, so the sidebar
 *   flashed "Connecting..." and then "Machine offline" again on every tick;
 * - a slower `listTasks` response could overwrite a Conversation that the open detail view had
 *   already reconciled to a newer state, briefly moving Working back to Ready.
 *
 * Reconciliation is deliberately structural and pure: identity is reused when the payload is
 * equivalent, and a locally-known Conversation wins only when it is strictly newer than the one the
 * list returned.
 */

type Fingerprintable = object | null | undefined

const fingerprints = new WeakMap<object, string>()
const reuseListRevisions = new WeakMap<object[], number>()
let reuseListRevision = 0

/** Stable structural fingerprint, cached per object so a retained value is only serialized once. */
export function fingerprint(value: Fingerprintable): string {
  if (value === null || value === undefined) return String(value)
  const cached = fingerprints.get(value)
  if (cached !== undefined) return cached
  const computed = JSON.stringify(value) ?? ""
  fingerprints.set(value, computed)
  return computed
}

/**
 * Force the next structural list reconciliation to publish a fresh identity even when its payload is
 * unchanged. This is intentionally generic: callers use it only when out-of-band state affects a
 * child read model that keys its refresh from the surrounding list identity.
 */
export function invalidateReuseListIdentity(): void {
  reuseListRevision += 1
}

function rememberReuseRevision<T extends object>(list: T[]): T[] {
  reuseListRevisions.set(list, reuseListRevision)
  return list
}

/** Returns `previous` when the two lists are structurally equal, so React memos can bail out. */
export function reuseList<T extends object>(previous: T[] | undefined, next: T[]): T[] {
  if (!previous) return rememberReuseRevision(next)
  const previousRevision = reuseListRevisions.get(previous)
  if (previousRevision !== undefined && previousRevision !== reuseListRevision) {
    return rememberReuseRevision(next)
  }
  if (previous.length !== next.length) return rememberReuseRevision(next)
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] === next[index]) continue
    if (fingerprint(previous[index]) !== fingerprint(next[index])) return rememberReuseRevision(next)
  }
  return rememberReuseRevision(previous)
}

type TimestampedRecord = { id: string; updatedAt?: string }

function newerThan(left: TimestampedRecord, right: TimestampedRecord): boolean {
  const leftTime = Date.parse(left.updatedAt || "")
  const rightTime = Date.parse(right.updatedAt || "")
  return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime > rightTime
}

/**
 * Merges a polled Conversation list onto what the client already knows.
 *
 * Server order is authoritative. Identity is reused for an unchanged Conversation, and a known
 * Conversation is kept when it is strictly newer than the polled one — the open detail view
 * reconciles its own Conversation far more often than the workspace poll runs, and a slow list
 * response must never move it backwards.
 */
export function mergeRecords<T extends TimestampedRecord>(previous: T[] | undefined, next: T[]): T[] {
  if (!previous) return next
  if (previous.length === 0) return next.length === 0 ? previous : next
  const known = new Map(previous.map((record) => [record.id, record]))
  let changed = previous.length !== next.length
  const merged = next.map((incoming, index) => {
    const current = known.get(incoming.id)
    if (!current) {
      changed = true
      return incoming
    }
    const resolved = fingerprint(current) === fingerprint(incoming) || newerThan(current, incoming)
      ? current
      : incoming
    if (resolved !== previous[index]) changed = true
    return resolved
  })
  return changed ? merged : previous
}
