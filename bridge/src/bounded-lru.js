export class BoundedLru {
  #entries = new Map()
  #weight = 0

  constructor({
    maxEntries = 8,
    maxWeight = Infinity,
    weightOf = () => 1,
    canEvict = () => true,
    onEvict = () => {}
  } = {}) {
    if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new Error("maxEntries must be a positive integer")
    if (!(maxWeight > 0)) throw new Error("maxWeight must be greater than zero")
    if (typeof weightOf !== "function") throw new Error("weightOf must be a function")
    if (typeof canEvict !== "function") throw new Error("canEvict must be a function")
    if (typeof onEvict !== "function") throw new Error("onEvict must be a function")
    this.maxEntries = maxEntries
    this.maxWeight = maxWeight
    this.weightOf = weightOf
    this.canEvict = canEvict
    this.onEvict = onEvict
  }

  get size() {
    return this.#entries.size
  }

  get weight() {
    return this.#weight
  }

  has(key) {
    return this.#entries.has(key)
  }

  peek(key) {
    return this.#entries.get(key)?.value
  }

  get(key) {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key, value) {
    const weight = this.#weightFor(value, key)
    const previous = this.#entries.get(key)
    if (previous) {
      this.#weight -= previous.weight
      this.#entries.delete(key)
    }
    this.#entries.set(key, { value, weight, grown: 0 })
    this.#weight += weight
    this.#evict()
    return this
  }

  refresh(key) {
    const entry = this.#entries.get(key)
    if (!entry) return false
    const weight = this.#weightFor(entry.value, key)
    this.#weight += weight - entry.weight
    entry.weight = weight
    entry.grown = 0
    this.#evict()
    return true
  }

  // Reported growth counts at once; re-weighing waits until it reaches half the last weigh.
  grow(key, weight) {
    const entry = this.#entries.get(key)
    if (!entry) return false
    weight = Number(weight) || 0
    entry.weight += weight
    entry.grown += weight
    this.#weight += weight
    if (entry.grown * 2 >= entry.weight - entry.grown) this.refresh(key)
    else this.#evict()
    return true
  }

  refreshAll() {
    for (const [key, entry] of this.#entries) {
      const weight = this.#weightFor(entry.value, key)
      this.#weight += weight - entry.weight
      entry.weight = weight
      entry.grown = 0
    }
    this.#evict()
  }

  delete(key) {
    const entry = this.#entries.get(key)
    if (!entry) return false
    this.#entries.delete(key)
    this.#weight -= entry.weight
    return true
  }

  clear() {
    this.#entries.clear()
    this.#weight = 0
  }

  keys() {
    return this.#entries.keys()
  }

  values() {
    return Array.from(this.#entries.values(), (entry) => entry.value).values()
  }

  entries() {
    return Array.from(this.#entries, ([key, entry]) => [key, entry.value]).values()
  }

  #weightFor(value, key) {
    return Math.max(0, Number(this.weightOf(value, key)) || 0)
  }

  #evict() {
    while (this.#entries.size > this.maxEntries || this.#weight > this.maxWeight) {
      // Which bound forced this eviction has to be read before the entry is removed, because
      // removing it is what brings the weight back under budget.
      const reason = this.#weight > this.maxWeight ? "weight" : "entries"
      let victim
      for (const [key, entry] of this.#entries) {
        if (this.canEvict(key, entry.value)) {
          victim = key
          break
        }
      }
      if (victim === undefined) break
      const entry = this.#entries.get(victim)
      if (!entry) break
      this.delete(victim)
      this.onEvict(victim, entry.value, entry.weight, reason)
    }
  }
}
