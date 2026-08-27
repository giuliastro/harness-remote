import { createReadStream } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

function messageParts(content, messageID) {
  if (typeof content === "string") return [{ id: `${messageID}:text:0`, messageID, type: "text", text: content }]
  if (!Array.isArray(content)) return []
  return content.flatMap((item, index) => {
    if (item?.type === "text" && typeof item.text === "string" && item.text) {
      return [{ id: `${messageID}:text:${index}`, messageID, type: "text", text: item.text }]
    }
    if (item?.type === "thinking" && typeof item.thinking === "string" && item.thinking) {
      return [{ id: `${messageID}:reasoning:${index}`, messageID, type: "reasoning", text: item.thinking }]
    }
    if (item?.type === "image" && typeof item.data === "string" && item.data) {
      const mime = typeof item.mimeType === "string" && item.mimeType ? item.mimeType : "image/png"
      return [{
        id: `${messageID}:file:${index}`,
        messageID,
        type: "file",
        mime,
        url: `data:${mime};base64,${item.data}`
      }]
    }
    return []
  })
}

function messageError(message) {
  const detail = typeof message?.errorMessage === "string" ? message.errorMessage.trim() : ""
  if (!detail) return undefined
  return { name: "HarnessTurnError", message: detail }
}

function messageEnvelope(record, sessionID) {
  if (record?.type !== "message") return undefined
  const role = record.message?.role
  if (role !== "user" && role !== "assistant") return undefined
  const messageID = record.__hrMessageID ?? record.id
  if (typeof messageID !== "string") return undefined
  const parts = messageParts(record.message?.content, messageID)
  const error = messageError(record.message)
  if (parts.length === 0 && !error) return undefined
  const created = Date.parse(record.timestamp ?? "")
  return {
    info: {
      id: messageID,
      role,
      sessionID,
      time: { created: Number.isFinite(created) ? created : Date.now() },
      ...(error ? { error } : {})
    },
    parts
  }
}

function encodeVisiblePageCursor(beforeID, target) {
  return Buffer.from(JSON.stringify({ beforeID, ...(target ? { target } : {}) }), "utf8").toString("base64url")
}

function decodeVisiblePageCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"))
    if (typeof parsed?.beforeID !== "string" || !parsed.beforeID) return undefined
    if (parsed.target !== undefined && (typeof parsed.target !== "string" || !parsed.target)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

function journalEntry(record) {
  return Boolean(record && record.type !== "title" && record.type !== "session")
}

/**
 * OMP v1 journals predate the id/parentId tree. OMP itself migrates them on native load by assigning
 * every non-header entry an id and linking it to the previous entry. Reading must emulate that shape
 * in memory instead of forcing session/load just to make an old transcript visible.
 *
 * Once this bridge has observed a Session as legacy, public message ids stay index based even after
 * OMP later rewrites the same file with random migration ids on the first real writer acquisition.
 * That keeps the browser from seeing the whole history as a second conversation during the rewrite.
 */
function normalizeEntries(raw, sessionID, legacySessions) {
  const header = raw.find((record) => record?.type === "session")
  const source = raw.filter(journalEntry)
  const headerVersion = header ? Number(header.version ?? 1) : undefined
  const legacyOnDisk = (headerVersion !== undefined && headerVersion < 2) || source.some((record) =>
    typeof record?.id !== "string" || !Object.prototype.hasOwnProperty.call(record, "parentId")
  )
  if (legacyOnDisk) legacySessions.add(sessionID)
  const stableLegacyIDs = legacySessions.has(sessionID)

  let previousID = null
  return source.map((record, index) => {
    const id = legacyOnDisk ? `hr-legacy-entry-${index}` : record.id
    const parentId = legacyOnDisk ? previousID : record.parentId
    previousID = id
    const messageID = stableLegacyIDs ? `omp-legacy:${sessionID}:${index}` : id
    const message = record?.type === "message" && record.message?.role === "hookMessage"
      ? { ...record.message, role: "custom" }
      : record.message
    return {
      ...record,
      id,
      parentId,
      ...(message ? { message } : {}),
      __hrMessageID: messageID,
      __hrIndex: index
    }
  })
}

async function readOmpJournal(file, sessionID, legacySessions) {
  const raw = []
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    try {
      raw.push(JSON.parse(line))
    } catch {
      // A malformed trailing line must not hide the valid journal before it.
    }
  }
  return normalizeEntries(raw, sessionID, legacySessions)
}

function selectedBranchRecords(records, selectedLeaf) {
  if (selectedLeaf === null) return []
  const entries = new Map(records.map((record) => [record.id, record]))
  if (!entries.has(selectedLeaf)) throw new Error("OMP active session leaf is missing from transcript")

  const branch = []
  const visited = new Set()
  let entry = entries.get(selectedLeaf)
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id)
    branch.push(entry)
    entry = typeof entry.parentId === "string" ? entries.get(entry.parentId) : undefined
  }
  return branch.reverse()
}

/**
 * OMP's SessionEntryIndex.rebuild() inserts the journal in file order and sets the active leaf to
 * each inserted entry, so reopening a persisted Session selects the last non-header entry. An
 * optional live extension leaf may refine that while the same OMP process is still running, but it
 * is never required for ordinary reads.
 */
function persistedLeaf(records, activeSessionLeaf) {
  if (typeof activeSessionLeaf === "string" && records.some((record) => record.id === activeSessionLeaf)) {
    return activeSessionLeaf
  }
  return records.at(-1)?.id ?? null
}

/**
 * A failed assistant attempt attached to a user prompt on the selected branch is visible history,
 * even if a later successful sibling became selected. Successful abandoned siblings stay hidden.
 */
function visibleBranchRecords(records, selectedLeaf) {
  const branch = selectedBranchRecords(records, selectedLeaf)
  if (selectedLeaf === null) return branch

  const branchIDs = new Set(branch.map((record) => record.id))
  const visibleUserIDs = new Set(branch
    .filter((record) => record.type === "message" && record.message?.role === "user")
    .map((record) => record.id))
  const selectedLeafIndex = records.findIndex((record) => record.id === selectedLeaf)
  const visibleIDs = new Set(branchIDs)

  for (let index = 0; index <= selectedLeafIndex; index += 1) {
    const record = records[index]
    if (
      record?.type === "message"
      && record.message?.role === "assistant"
      && typeof record.parentId === "string"
      && visibleUserIDs.has(record.parentId)
      && messageError(record.message)
    ) {
      visibleIDs.add(record.id)
    }
  }

  return records.filter((record, index) => index <= selectedLeafIndex && visibleIDs.has(record.id))
}

function visibleBranchMessages(records, sessionID, selectedLeaf) {
  return visibleBranchRecords(records, selectedLeaf).flatMap((record) => {
    const message = messageEnvelope(record, sessionID)
    return message ? [message] : []
  })
}

function pageVisibleBranch(records, sessionID, { limit = 100, before, selectedLeaf, stableLegacyIDs = false } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  if (selectedLeaf === null) return { messages: [], before: null, hasMore: false }

  const messages = visibleBranchMessages(records, sessionID, selectedLeaf)
  const decoded = before ? decodeVisiblePageCursor(before) : undefined
  if (before && !decoded) throw new Error("Invalid OMP history cursor")
  const requestedEnd = decoded
    ? messages.findIndex((message) => message.info.id === decoded.beforeID)
    : messages.length
  if (decoded && requestedEnd < 0) throw new Error("Invalid OMP history cursor")
  const end = requestedEnd >= 0 ? requestedEnd : messages.length
  const start = Math.max(0, end - boundedLimit)
  const page = messages.slice(start, end)
  return {
    messages: page,
    before: start > 0 && page.length > 0
      ? encodeVisiblePageCursor(page[0].info.id, stableLegacyIDs ? undefined : selectedLeaf)
      : null,
    hasMore: start > 0
  }
}

function modelSelection(providerID, modelID) {
  if (typeof providerID !== "string" || !providerID || typeof modelID !== "string" || !modelID) return undefined
  return { providerID, modelID }
}

function modelSelectionFromWireName(value) {
  if (typeof value !== "string") return undefined
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return modelSelection(value.slice(0, separator), value.slice(separator + 1))
}

function branchModel(records, selectedLeaf) {
  let selected
  for (const record of visibleBranchRecords(records, selectedLeaf)) {
    if (record.type === "model_change" && (record.role === undefined || record.role === "default")) {
      selected = modelSelectionFromWireName(record.model) ?? selected
      continue
    }
    if (record.type === "session_init") {
      selected = modelSelectionFromWireName(record.resolvedModel) ?? selected
      continue
    }
    if (record.type === "message" && record.message?.role === "assistant") {
      selected = modelSelection(record.message.provider, record.message.model) ?? selected
    }
  }
  return selected
}

function semanticPart(part) {
  if (!part || typeof part !== "object") return ""
  if (part.type === "text" || part.type === "reasoning") return `${part.type}:${part.text ?? ""}`
  if (part.type === "file") return `file:${part.mime ?? ""}:${part.url ?? ""}`
  if (part.type === "tool") return `tool:${part.tool ?? ""}:${JSON.stringify(part.state ?? {})}`
  return JSON.stringify(part)
}

function semanticMessage(message) {
  return JSON.stringify({
    role: message?.info?.role,
    error: message?.info?.error?.message ?? "",
    parts: (message?.parts ?? []).map(semanticPart)
  })
}

function visibleText(message) {
  return (message?.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

function simpleTailMessage(message) {
  return Boolean(message && !message.info?.error && (message.parts ?? []).every((part) =>
    part?.type === "text" || part?.type === "reasoning"
  ))
}

function tailPair(messages) {
  let userIndex = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info?.role === "user") {
      userIndex = index
      break
    }
  }
  if (userIndex < 0) return null
  const assistant = messages.slice(userIndex + 1).filter((message) => message?.info?.role === "assistant").at(-1)
  return assistant ? { user: messages[userIndex], assistant } : null
}

function sameTurnTime(left, right) {
  const a = Number(left?.info?.time?.created) || 0
  const b = Number(right?.info?.time?.created) || 0
  return !a || !b || Math.abs(a - b) <= 15_000
}

/**
 * While an OMP turn is live the ACP stream is useful for partial output, but completed messages are
 * durable only when OMP appends message_end to its JSONL. The bridge can therefore briefly hold an
 * ACP prefix after the journal already contains the complete assistant. Merge the two only at the
 * unambiguous current user/assistant pair so the complete journal tail wins without duplicating the
 * live identity. If the live stream is ahead of disk, keep the longer live text until disk catches up.
 */
export function mergeOmpLiveHistory(persisted, cached) {
  if (!persisted.length) return cached
  if (!cached.length) return persisted

  let persistedBase = persisted
  let dropCachedAssistantID
  let dropCachedUserID
  const durableTail = tailPair(persisted)
  const liveTail = tailPair(cached)
  if (
    durableTail && liveTail
    && simpleTailMessage(durableTail.user) && simpleTailMessage(liveTail.user)
    && simpleTailMessage(durableTail.assistant) && simpleTailMessage(liveTail.assistant)
    && visibleText(durableTail.user).trim()
    && visibleText(durableTail.user).trim() === visibleText(liveTail.user).trim()
    && sameTurnTime(durableTail.user, liveTail.user)
  ) {
    const durableAnswer = visibleText(durableTail.assistant)
    const liveAnswer = visibleText(liveTail.assistant)
    if (durableAnswer && liveAnswer && (
      durableAnswer === liveAnswer || durableAnswer.startsWith(liveAnswer) || liveAnswer.startsWith(durableAnswer)
    )) {
      dropCachedUserID = liveTail.user.info.id
      if (durableAnswer.length >= liveAnswer.length) {
        dropCachedAssistantID = liveTail.assistant.info.id
      } else {
        persistedBase = persisted.filter((message) => message !== durableTail.assistant)
      }
    }
  }

  const persistedIDs = new Set(persistedBase.map((message) => message.info.id))
  const remainingBySignature = new Map()
  for (const message of persistedBase) {
    const signature = semanticMessage(message)
    remainingBySignature.set(signature, (remainingBySignature.get(signature) ?? 0) + 1)
  }

  const cachedOnly = cached.filter((message) => {
    if (message.info.id === dropCachedAssistantID || message.info.id === dropCachedUserID) return false
    if (persistedIDs.has(message.info.id)) return false
    const signature = semanticMessage(message)
    const remaining = remainingBySignature.get(signature) ?? 0
    if (remaining === 0) return true
    remainingBySignature.set(signature, remaining - 1)
    return false
  })
  return [...persistedBase, ...cachedOnly].sort((left, right) =>
    (Number(left.info?.time?.created) || 0) - (Number(right.info?.time?.created) || 0)
  )
}

export function createOmpHistoryLoader(sessionRoot = path.join(homedir(), ".omp", "agent", "sessions")) {
  const sessionFiles = new Map()
  const legacySessions = new Set()
  let listing = []
  let listingInFlight
  let listingScans = 0

  async function refreshListing() {
    if (listingInFlight) return listingInFlight
    listingInFlight = (async () => {
      try {
        listingScans += 1
        const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
        listing = entries
          .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".jsonl"))
          .map((candidate) => ({ name: candidate.name, file: path.join(candidate.parentPath ?? candidate.path, candidate.name) }))
      } catch (error) {
        if (error?.code === "ENOENT") {
          listing = []
          return
        }
        throw error
      } finally {
        listingInFlight = undefined
      }
    })()
    return listingInFlight
  }

  async function locateSession(sessionID) {
    const known = sessionFiles.get(sessionID)
    if (known) return known
    if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined
    const suffix = `_${sessionID}.jsonl`
    const find = () => listing.find((candidate) => candidate.name.endsWith(suffix))?.file

    let file = find()
    if (!file) {
      // OMP creates a new JSONL lazily, so an unknown id must always get one immediate re-scan.
      await refreshListing()
      file = find()
    }
    if (!file) return undefined
    sessionFiles.set(sessionID, file)
    return file
  }

  async function recordsFor(sessionID) {
    const file = await locateSession(sessionID)
    if (!file) return []
    return readOmpJournal(file, sessionID, legacySessions)
  }

  const loadOmpHistory = async function loadOmpHistory(sessionID, { activeSessionLeaf } = {}) {
    const records = await recordsFor(sessionID)
    const leaf = persistedLeaf(records, activeSessionLeaf)
    return visibleBranchMessages(records, sessionID, leaf)
  }

  loadOmpHistory.diagnostics = () => ({
    source: "omp-session-jsonl-native-leaf",
    listingScans,
    listedFiles: listing.length,
    resolvedSessions: sessionFiles.size,
    legacySessions: legacySessions.size
  })

  // Like PI, OMP's append-only journal is transcript truth even after this bridge acquires the writer.
  // ACP remains lifecycle/config transport; it must never be required merely to read a Session.
  loadOmpHistory.authoritativeHistory = true
  loadOmpHistory.mergeLiveHistory = mergeOmpLiveHistory
  loadOmpHistory.pageRequiresActiveLeaf = false
  loadOmpHistory.deferAcpReplayWithoutActiveLeaf = true

  loadOmpHistory.page = async (sessionID, options = {}) => {
    const records = await recordsFor(sessionID)
    if (!records.length) return { messages: [], before: null, hasMore: false }

    const decoded = options.before ? decodeVisiblePageCursor(options.before) : undefined
    if (options.before && !decoded) throw new Error("Invalid OMP history cursor")
    const cursorLeaf = decoded?.target && records.some((record) => record.id === decoded.target)
      ? decoded.target
      : undefined
    const leaf = persistedLeaf(records, cursorLeaf ?? options.activeSessionLeaf)
    const page = pageVisibleBranch(records, sessionID, {
      ...options,
      selectedLeaf: leaf,
      stableLegacyIDs: legacySessions.has(sessionID)
    })
    const model = leaf === null ? undefined : branchModel(records, leaf)
    return { ...page, ...(model ? { model } : {}) }
  }

  return loadOmpHistory
}
