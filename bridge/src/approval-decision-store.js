import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"

const VERSION = 1
export const APPROVAL_DECISION_LIMIT = 1_000
const MAX_ID_LENGTH = 512
const MAX_DIRECTORY_LENGTH = 4_096
const MAX_ACTION_LENGTH = 2_000
const MAX_EXPLANATION_LENGTH = 2_000
const MAX_BOUNDARY_ITEMS = 64
const MAX_BOUNDARY_ITEM_LENGTH = 1_000
const DECISIONS = new Set(["once", "always", "reject"])

function boundedText(value, label, maxLength, { optional = false } = {}) {
  if ((value === undefined || value === null || value === "") && optional) return undefined
  if (typeof value !== "string") throw new Error(`${label} must be text`)
  const normalized = value.trim()
  if (!normalized && !optional) throw new Error(`${label} is required`)
  if (normalized.length > maxLength) throw new Error(`${label} is too long`)
  return normalized || undefined
}

function normalizedIdentity(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Approval decision requires a native Session identity")
  return {
    machineID: boundedText(value.machineID, "machineID", MAX_ID_LENGTH),
    agentID: boundedText(value.agentID, "agentID", MAX_ID_LENGTH),
    sessionID: boundedText(value.sessionID, "sessionID", MAX_ID_LENGTH),
    directory: boundedText(value.directory, "directory", MAX_DIRECTORY_LENGTH)
  }
}

function identityKey(identity) {
  return `${identity.machineID}\u0000${identity.agentID}\u0000${identity.sessionID}`
}

function recordKey(record) {
  return `${identityKey(record)}\u0000${record.requestID}`
}

function normalizedBoundary(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw new Error("Approval boundary must be an array")
  if (value.length > MAX_BOUNDARY_ITEMS) throw new Error("Approval boundary has too many entries")
  return value.map((entry) => boundedText(entry, "Approval boundary entry", MAX_BOUNDARY_ITEM_LENGTH))
}

function normalizedDecision(value) {
  if (!DECISIONS.has(value)) throw new Error("Approval decision must be once, always or reject")
  return value
}

function normalizedTimestamp(value) {
  const candidate = boundedText(value, "decidedAt", 100)
  if (!Number.isFinite(Date.parse(candidate))) throw new Error("Approval decision timestamp is invalid")
  return candidate
}

function normalizedRecord(value, machineID) {
  const identity = normalizedIdentity(value)
  if (identity.machineID !== machineID) throw new Error("Approval decision must stay inside its machine scope")
  const decision = normalizedDecision(value.decision)
  return {
    type: "authorization-decision",
    ...identity,
    requestID: boundedText(value.requestID, "requestID", MAX_ID_LENGTH),
    requestedAction: boundedText(value.requestedAction, "requestedAction", MAX_ACTION_LENGTH),
    boundary: normalizedBoundary(value.boundary),
    decision,
    semantics: decision === "once" ? "one-shot" : decision === "always" ? "harness-reusable" : "denied",
    decidedAt: normalizedTimestamp(value.decidedAt),
    ...(boundedText(value.explanation, "explanation", MAX_EXPLANATION_LENGTH, { optional: true }) ? {
      explanation: boundedText(value.explanation, "explanation", MAX_EXPLANATION_LENGTH, { optional: true })
    } : {})
  }
}

/**
 * Machine-scoped audit/control metadata for permission decisions already accepted by the native
 * harness. This store is deliberately not an authorization source: callers may display/recover the
 * record, but must never replay it or treat an absent/present record as permission to act.
 */
export class ApprovalDecisionStore {
  #machineID
  #stateDirectory
  #path
  #loaded = false
  #records = new Map()
  #mutation = Promise.resolve()
  #limit

  constructor({ machineID, stateDirectory, limit = APPROVAL_DECISION_LIMIT }) {
    this.#machineID = machineID
    this.#stateDirectory = stateDirectory
    this.#path = path.join(stateDirectory, "approval-decisions.json")
    this.#limit = Number.isInteger(limit) && limit > 0 ? limit : APPROVAL_DECISION_LIMIT
  }

  async #load() {
    if (this.#loaded) return
    this.#loaded = true
    try {
      const parsed = JSON.parse(await readFile(this.#path, "utf8"))
      if (parsed?.version !== VERSION || parsed?.machineID !== this.#machineID || !Array.isArray(parsed.records)) return
      for (const candidate of parsed.records) {
        try {
          const record = normalizedRecord(candidate, this.#machineID)
          this.#records.set(recordKey(record), record)
        } catch {
          // One stale/invalid entry must not make every otherwise valid audit record unreadable.
        }
      }
      this.#trim()
    } catch (error) {
      if (error?.code === "ENOENT") return
      if (error instanceof SyntaxError) {
        await rename(this.#path, `${this.#path}.corrupt-${Date.now()}`)
        return
      }
      throw error
    }
  }

  #trim() {
    if (this.#records.size <= this.#limit) return
    const ordered = [...this.#records.entries()].sort(([, left], [, right]) => Date.parse(left.decidedAt) - Date.parse(right.decidedAt))
    for (const [key] of ordered.slice(0, Math.max(0, ordered.length - this.#limit))) this.#records.delete(key)
  }

  async #persist() {
    await mkdir(this.#stateDirectory, { recursive: true })
    const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({
      version: VERSION,
      machineID: this.#machineID,
      records: [...this.#records.values()]
    }), { mode: 0o600 })
    await rename(temporary, this.#path)
  }

  #serial(operation) {
    const next = this.#mutation.then(operation, operation)
    this.#mutation = next.catch(() => undefined)
    return next
  }

  async record(input) {
    const candidate = normalizedRecord(input, this.#machineID)
    return this.#serial(async () => {
      await this.#load()
      const key = recordKey(candidate)
      const existing = this.#records.get(key)
      if (existing) {
        if (existing.decision !== candidate.decision) {
          throw new Error("Approval request already has a different recorded decision")
        }
        return structuredClone(existing)
      }
      this.#records.set(key, candidate)
      this.#trim()
      await this.#persist()
      return structuredClone(candidate)
    })
  }

  async listFor(identity) {
    const normalized = normalizedIdentity(identity)
    if (normalized.machineID !== this.#machineID) throw new Error("Approval decision lookup must target this machine")
    await this.#load()
    const key = identityKey(normalized)
    return [...this.#records.values()]
      .filter((record) => identityKey(record) === key)
      .sort((left, right) => Date.parse(right.decidedAt) - Date.parse(left.decidedAt))
      .map((record) => structuredClone(record))
  }
}
