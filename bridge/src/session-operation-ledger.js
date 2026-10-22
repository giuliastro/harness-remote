import path from "node:path"
import { JsonFileStore } from "./json-file-store.js"

const VERSION = 1
const MAX_OPERATIONS = 1024

function ledgerError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function operationKey(agentID, sessionID, clientRequestId) {
  return `${agentID}\u0000${sessionID}\u0000${clientRequestId}`
}

/**
 * Durable idempotency ledger for user-visible native Session mutations.
 *
 * Pending is persisted before a mutation is dispatched. Accepted is persisted before the HTTP
 * success is returned. Accepted entries may also retain a small JSON result, which lets mutations
 * that create a native resource return that exact resource again after the client loses the first
 * HTTP response. After a daemon restart a pending/uncertain entry is deliberately not replayed: it
 * is safer to ask the client to reconcile the native Session than to repeat coding work or a
 * lifecycle mutation whose first delivery may already have succeeded.
 */
export class SessionOperationLedger {
  #machineID
  #stateDirectory
  #path
  #store
  #loaded = false
  #operations = new Map()

  constructor({ machineID, stateDirectory }) {
    this.#machineID = machineID
    this.#stateDirectory = stateDirectory
    this.#path = path.join(stateDirectory, "session-operations.json")
    this.#store = new JsonFileStore({ filePath: this.#path, stateDirectory })
  }

  async #load() {
    if (this.#loaded) return
    this.#loaded = true
    const parsed = await this.#store.read({
      onCorrupt: "error",
      onError: () => {
        throw ledgerError("operation_ledger_unreadable", "Native Session operation ledger is unreadable")
      }
    })
    if (!parsed) return
    if (parsed.version !== VERSION || parsed.machineID !== this.#machineID || !Array.isArray(parsed.operations)) return
    for (const entry of parsed.operations) {
      if (!entry || typeof entry !== "object") continue
      if (!["pending", "accepted", "uncertain"].includes(entry.state)) continue
      if (![entry.agentID, entry.sessionID, entry.clientRequestId, entry.signature].every((value) => typeof value === "string" && value)) continue
      this.#operations.set(operationKey(entry.agentID, entry.sessionID, entry.clientRequestId), entry)
    }
  }

  /**
   * Bounded, credential-free view of the mutation ledger.
   *
   * Only counts and the unresolved entries are exposed, and never a prompt body or signature: an
   * unresolved entry is what blocks a client from sending a different prompt for that Session, so
   * being able to see the age of the oldest one is what makes a wedged Session diagnosable.
   */
  diagnostics({ maxUnresolved = 20 } = {}) {
    const now = Date.now()
    const counts = { pending: 0, accepted: 0, uncertain: 0 }
    const unresolved = []
    for (const entry of this.#operations.values()) {
      if (entry.state in counts) counts[entry.state] += 1
      if (entry.state === "accepted") continue
      const updatedAt = Date.parse(entry.updatedAt ?? "")
      unresolved.push({
        agentID: entry.agentID,
        sessionID: entry.sessionID,
        state: entry.state,
        ageMs: Number.isFinite(updatedAt) ? Math.max(0, now - updatedAt) : null
      })
    }
    unresolved.sort((left, right) => (right.ageMs ?? 0) - (left.ageMs ?? 0))
    return {
      loaded: this.#loaded,
      total: this.#operations.size,
      maxOperations: MAX_OPERATIONS,
      counts,
      unresolvedCount: unresolved.length,
      oldestUnresolvedMs: unresolved[0]?.ageMs ?? null,
      unresolved: unresolved.slice(0, maxUnresolved)
    }
  }

  #trim() {
    if (this.#operations.size <= MAX_OPERATIONS) return
    const accepted = [...this.#operations.entries()]
      .filter(([, entry]) => entry.state === "accepted")
      .sort(([, left], [, right]) => String(left.updatedAt).localeCompare(String(right.updatedAt)))
    while (this.#operations.size > MAX_OPERATIONS && accepted.length) {
      const [key] = accepted.shift()
      this.#operations.delete(key)
    }
  }

  async #persist() {
    this.#trim()
    await this.#store.write({
      version: VERSION,
      machineID: this.#machineID,
      operations: [...this.#operations.values()]
    })
  }

  #serial(operation) {
    return this.#store.serial(operation)
  }

  async begin({ agentID, sessionID, clientRequestId, signature }) {
    return this.#serial(async () => {
      await this.#load()
      const key = operationKey(agentID, sessionID, clientRequestId)
      const existing = this.#operations.get(key)
      if (existing) {
        if (existing.signature !== signature) {
          throw ledgerError("idempotency_conflict", "clientRequestId was already used for a different native Session operation")
        }
        return { duplicate: true, state: existing.state, entry: structuredClone(existing) }
      }
      const now = new Date().toISOString()
      const entry = {
        agentID,
        sessionID,
        clientRequestId,
        signature,
        state: "pending",
        createdAt: now,
        updatedAt: now
      }
      this.#operations.set(key, entry)
      await this.#persist()
      return { duplicate: false, state: entry.state, entry: structuredClone(entry) }
    })
  }

  async accept({ agentID, sessionID, clientRequestId, result }) {
    return this.#serial(async () => {
      await this.#load()
      const key = operationKey(agentID, sessionID, clientRequestId)
      const entry = this.#operations.get(key)
      if (!entry) throw ledgerError("operation_missing", "Native Session operation is missing")
      entry.state = "accepted"
      if (result !== undefined) entry.result = structuredClone(result)
      entry.updatedAt = new Date().toISOString()
      await this.#persist()
      return structuredClone(entry)
    })
  }

  async fail({ agentID, sessionID, clientRequestId, ambiguous = false, result }) {
    return this.#serial(async () => {
      await this.#load()
      const key = operationKey(agentID, sessionID, clientRequestId)
      const entry = this.#operations.get(key)
      if (!entry) return
      if (ambiguous) {
        entry.state = "uncertain"
        if (result !== undefined) entry.result = structuredClone(result)
        entry.updatedAt = new Date().toISOString()
      } else {
        this.#operations.delete(key)
      }
      await this.#persist()
    })
  }

  async get({ agentID, sessionID, clientRequestId }) {
    await this.#load()
    const entry = this.#operations.get(operationKey(agentID, sessionID, clientRequestId))
    return entry ? structuredClone(entry) : undefined
  }
}

export async function runIdempotentMutation({
  operationLedger,
  identity,
  signature,
  dispatch,
  reconcile
}) {
  const started = await operationLedger.begin({ ...identity, signature })
  if (started.duplicate) {
    if (started.state === "uncertain" && typeof reconcile === "function") {
      try {
        const recovered = await reconcile(started.entry.result)
        if (recovered) {
          await operationLedger.accept({ ...identity, result: recovered })
          return { status: "accepted", duplicate: true, result: recovered }
        }
      } catch {
        // Reconciliation is read-only. A temporary read failure must leave the original uncertain
        // entry untouched rather than replaying a resource-creating mutation.
      }
    }
    return { status: started.state, duplicate: true, result: started.entry.result }
  }

  let dispatched = false
  let checkpointedResult
  const checkpoint = async (result) => {
    await operationLedger.accept({ ...identity, result })
    checkpointedResult = result
  }

  try {
    const result = await dispatch({ checkpoint })
    dispatched = true
    const acceptedResult = result === undefined ? checkpointedResult : result
    if (result !== undefined || checkpointedResult === undefined) {
      await operationLedger.accept({ ...identity, result })
    }
    return { status: "accepted", duplicate: false, result: acceptedResult }
  } catch (error) {
    if (checkpointedResult !== undefined) {
      // Resource identity is already durable. Any later title/model/link enrichment failure cannot
      // turn the creation back into "unknown"; retries must return this exact resource.
      return { status: "accepted", duplicate: false, result: checkpointedResult }
    }
    const ambiguous = dispatched || error?.ambiguous === true
    // Once dispatch has returned, the native resource may exist even if persisting `accepted`
    // failed. Keep that operation uncertain so a retry can only reconcile; never delete the ledger
    // entry and accidentally permit a second target Session.
    await operationLedger.fail({
      ...identity,
      ambiguous,
      ...(error?.recovery !== undefined ? { result: error.recovery } : {})
    })
    if (ambiguous) return { status: "uncertain", duplicate: false }
    throw error
  }
}
