import path from "node:path"
import { JsonFileStore } from "./json-file-store.js"
import { normalizePortableHandoffState } from "./portable-handoff-state.js"

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

function invalidLink(message) {
  const error = new Error(message)
  error.code = "invalid_request"
  return error
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
 * exact bounded context string and runtime-neutral task/evidence/control state used for that handoff
 * so the UI can explain the boundary after reopening.
 *
 * Cross-machine links are replicated metadata, not shared authority: a daemon stores an edge only
 * when at least one endpoint belongs to that daemon. The same A -> B edge may therefore be present
 * on machine A and machine B, while an unrelated machine C must reject it.
 */
export class SessionLinkStore {
  #machineID
  #stateDirectory
  #path
  #store
  #loaded = false
  #links = new Map()

  constructor({ machineID, stateDirectory }) {
    this.#machineID = machineID
    this.#stateDirectory = stateDirectory
    this.#path = path.join(stateDirectory, "session-links.json")
    this.#store = new JsonFileStore({ filePath: this.#path, stateDirectory })
  }

  #isLocalLink(source, target) {
    return source.machineID === this.#machineID || target.machineID === this.#machineID
  }

  async #load() {
    if (this.#loaded) return
    this.#loaded = true
    const parsed = await this.#store.read()
    if (parsed?.version !== VERSION || parsed?.machineID !== this.#machineID || !Array.isArray(parsed.links)) return
    for (const link of parsed.links) {
      if (!link || typeof link !== "object" || link.type !== "handoff") continue
      if (!validIdentity(link.source) || !validIdentity(link.target)) continue
      if (!this.#isLocalLink(link.source, link.target)) continue
      let portableState
      try { portableState = normalizePortableHandoffState(link.portableState) } catch { portableState = undefined }
      const normalized = {
        type: "handoff",
        source: link.source,
        target: link.target,
        createdAt: link.createdAt,
        ...(typeof link.transferredContext === "string" && link.transferredContext ? { transferredContext: link.transferredContext } : {}),
        ...(portableState ? { portableState } : {})
      }
      this.#links.set(linkKey(link.source, link.target), normalized)
    }
  }

  async #persist() {
    await this.#store.write({
      version: VERSION,
      machineID: this.#machineID,
      links: [...this.#links.values()]
    })
  }

  #serial(operation) {
    return this.#store.serial(operation)
  }

  async addHandoff({ source, target, createdAt = new Date().toISOString(), transferredContext, portableState }) {
    if (!validIdentity(source) || !validIdentity(target)) throw new Error("Native Session link requires complete source and target identities")
    if (!this.#isLocalLink(source, target)) {
      throw invalidLink("Native Session link must include a Session owned by this machine")
    }
    const context = normalizedTransferredContext(transferredContext)
    const state = normalizePortableHandoffState(portableState)
    return this.#serial(async () => {
      await this.#load()
      const key = linkKey(source, target)
      const existing = this.#links.get(key)
      if (existing) {
        const sameContext = !context || existing.transferredContext === context
        const sameState = !state || JSON.stringify(existing.portableState) === JSON.stringify(state)
        if (sameContext && sameState) return structuredClone(existing)
        const updated = {
          ...existing,
          ...(context ? { transferredContext: context } : {}),
          ...(state ? { portableState: state } : {})
        }
        this.#links.set(key, updated)
        await this.#persist()
        return structuredClone(updated)
      }
      const link = {
        type: "handoff",
        source: structuredClone(source),
        target: structuredClone(target),
        createdAt,
        ...(context ? { transferredContext: context } : {}),
        ...(state ? { portableState: state } : {})
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
