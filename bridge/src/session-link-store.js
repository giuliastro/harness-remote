import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

const VERSION = 1

function identityKey(identity) {
  return `${identity.machineID}\u0000${identity.agentID}\u0000${identity.sessionID}`
}

function linkKey(source, target) {
  return `${identityKey(source)}\u0001${identityKey(target)}`
}

function validIdentity(value) {
  return value
    && typeof value === "object"
    && [value.machineID, value.agentID, value.sessionID, value.directory].every((entry) => typeof entry === "string" && entry)
}

function normalizedTransferredContext(value) {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") throw new Error("Transferred Session context must be text")
  if (value.length > 12_000) throw new Error("Transferred Session context is too large")
  return value
}

/**
 * Small machine-scoped graph of explicit relationships between real harness-owned Sessions.
 *
 * A link does not own either Session or create a second conversation identity. It records that
 * Harness Remote deliberately handed work from one native Session to another and may retain the
 * exact bounded context string used for that handoff so the UI can explain it after reopening.
 *
 * Cross-machine links are replicated metadata, not shared authority: a daemon stores an edge only
 * when at least one endpoint belongs to that daemon. The same A -> B edge may therefore be present
 * on machine A and machine B, while an unrelated machine C must reject it.
 */
export class SessionLinkStore {
  #machineID
  #stateDirectory
  #path
  #loaded = false
  #links = new Map()
  #mutation = Promise.resolve()

  constructor({ machineID, stateDirectory }) {
    this.#machineID = machineID
    this.#stateDirectory = stateDirectory
    this.#path = path.join(stateDirectory, "session-links.json")
  }

  #isLocalLink(source, target) {
    return source.machineID === this.#machineID || target.machineID === this.#machineID
  }

  async #load() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"))
      if (parsed?.version !== VERSION || parsed?.machineID !== this.#machineID || !Array.isArray(parsed.links)) return
      for (const link of parsed.links) {
        if (!link || typeof link !== "object" || link.type !== "handoff") continue
        if (!validIdentity(link.source) || !validIdentity(link.target)) continue
        if (!this.#isLocalLink(link.source, link.target)) continue
        this.#links.set(linkKey(link.source, link.target), link)
      }
    } catch (error) {
      if (error?.code === "ENOENT") return
      if (error instanceof SyntaxError) {
        const backup = `${this.#path}.corrupt-${Date.now()}`
        await rename(this.#path, backup)
        return
      }
      throw error
    }
  }

  async #persist() {
    await mkdir(this.#stateDirectory, { recursive: true })
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({
      version: VERSION,
      machineID: this.#machineID,
      links: [...this.#links.values()]
    }), { mode: 0o600 })
    await rename(temporary, this.#path)
  }

  #serial(operation) {
    const next = this.#mutation.then(operation, operation)
    this.#mutation = next.catch(() => undefined)
    return next
  }

  async addHandoff({ source, target, createdAt = new Date().toISOString(), transferredContext }) {
    if (!validIdentity(source) || !validIdentity(target)) throw new Error("Native Session link requires complete source and target identities")
    if (!this.#isLocalLink(source, target)) {
      throw new Error("Native Session link must include a Session owned by this machine")
    }
    const context = normalizedTransferredContext(transferredContext)
    return this.#serial(async () => {
      await this.#load()
      const key = linkKey(source, target)
      const existing = this.#links.get(key)
      if (existing) {
        if (!context || existing.transferredContext === context) return structuredClone(existing)
        const updated = { ...existing, transferredContext: context }
        this.#links.set(key, updated)
        await this.#persist()
        return structuredClone(updated)
      }
      const link = {
        type: "handoff",
        source: structuredClone(source),
        target: structuredClone(target),
        createdAt,
        ...(context ? { transferredContext: context } : {})
      }
      this.#links.set(key, link)
      await this.#persist()
      return structuredClone(link)
    })
  }

  async listFor(identity) {
    if (!validIdentity(identity)) throw new Error("A complete native Session identity is required")
    if (identity.machineID !== this.#machineID) throw new Error("Native Session link lookup must target this machine")
    await this.#load()
    const key = identityKey(identity)
    return [...this.#links.values()]
      .filter((link) => identityKey(link.source) === key || identityKey(link.target) === key)
      .map((link) => structuredClone(link))
  }
}
