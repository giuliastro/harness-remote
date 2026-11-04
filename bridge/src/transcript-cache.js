import { BoundedLru } from "./bounded-lru.js"

/*
 * The real memory bound is DEFAULT_MAX_WEIGHT. The entry cap only exists so a pathological number of
 * tiny transcripts cannot grow the map without limit.
 *
 * It used to be 8, which was sized for conversation-first: a user worked in a handful of
 * Conversations, so eight was generous. Session-first inverts that - Home lists every native Session
 * on the machine and invites hopping between them - so the ninth Session a user opened evicted the
 * first, and going back re-read that harness's journal or re-ran session/load from scratch. The cap
 * was doing the evicting while the weight budget sat almost entirely unused, which is why switching
 * between many Sessions felt slow for no visible reason.
 *
 * Keep the weight budget as the governing bound and let the entry cap sit far enough above normal
 * navigation that it stops being the thing that evicts.
 */
const DEFAULT_MAX_ENTRIES = 64
const DEFAULT_MAX_WEIGHT = 24 * 1024 * 1024

export function partWeight(part) {
  if (!part || typeof part !== "object") return 0
  let weight = 64
  if (typeof part.text === "string") weight += part.text.length
  if (typeof part.url === "string") weight += part.url.length
  if (typeof part.filename === "string") weight += part.filename.length
  if (typeof part.mime === "string") weight += part.mime.length
  if (part.state && typeof part.state === "object") {
    try { weight += JSON.stringify(part.state).length } catch {}
  }
  return weight
}

export function transcriptWeight(messages) {
  if (!Array.isArray(messages)) return 0
  let weight = 0
  for (const message of messages) {
    weight += 160
    if (typeof message?.info?.error?.message === "string") weight += message.info.error.message.length
    for (const part of message?.parts ?? []) weight += partWeight(part)
  }
  return weight
}

export class TranscriptCache {
  #lru
  #evictions = 0
  #hits = 0
  #misses = 0
  #weightEvictions = 0

  constructor({
    maxEntries = DEFAULT_MAX_ENTRIES,
    maxWeight = DEFAULT_MAX_WEIGHT,
    isProtected = () => false,
    onEvict = () => {}
  } = {}) {
    this.#lru = new BoundedLru({
      maxEntries,
      maxWeight,
      weightOf: transcriptWeight,
      canEvict: (key) => !isProtected(key),
      onEvict: (key, value, weight, reason) => {
        this.#evictions += 1
        // Which bound is doing the evicting is the whole diagnosis: eviction under the memory budget
        // is the cache working, eviction with the budget nearly empty is the entry cap thrashing.
        if (reason === "weight") this.#weightEvictions += 1
        onEvict(key, value, weight)
      }
    })
  }

  get size() { return this.#lru.size }
  get weight() { return this.#lru.weight }
  has(key) { return this.#lru.has(key) }

  get(key) {
    const value = this.#lru.get(key)
    if (value === undefined) {
      this.#misses += 1
      return value
    }
    this.#hits += 1
    return value
  }

  set(key, value) {
    // Callers set back the array they just read to edit in place; its growth arrives through grow().
    if (this.#lru.peek(key) !== value) this.#lru.set(key, value)
    return this
  }

  grow(key, weight) { return this.#lru.grow(key, weight) }

  delete(key) { return this.#lru.delete(key) }
  clear() { this.#lru.clear() }
  keys() { return this.#lru.keys() }
  values() { return this.#lru.values() }
  entries() { return this.#lru.entries() }

  refresh(key) { return this.#lru.refresh(key) }

  stats() {
    this.#lru.refreshAll()
    return {
      entries: this.#lru.size,
      weight: this.#lru.weight,
      evictions: this.#evictions,
      // Evictions forced by the memory budget rather than by the entry cap. A high `evictions` with
      // `weightEvictions` at zero means Sessions are being dropped while memory is still free.
      weightEvictions: this.#weightEvictions,
      hits: this.#hits,
      misses: this.#misses,
      maxEntries: this.#lru.maxEntries,
      maxWeight: this.#lru.maxWeight
    }
  }
}
