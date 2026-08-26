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
    // OMP stores what it re-encoded and keeps no filename, so the mime comes from the record
    // and the app renders the thumbnail without a label.
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

/**
 * A turn that failed is journalled as an assistant message with no content and the provider's own
 * sentence in `errorMessage`. Skipping those for having no parts made a rate-limited or unpaid
 * session look like it had simply lost its replies: the transcript showed the prompts and nothing
 * back, with no way to tell a failure from a missing message.
 */
function messageError(message) {
  const detail = typeof message?.errorMessage === "string" ? message.errorMessage.trim() : ""
  if (!detail) return undefined
  return { name: "HarnessTurnError", message: detail }
}

function messageEnvelope(record, sessionID) {
  if (record?.type !== "message") return undefined
  const role = record.message?.role
  if (role !== "user" && role !== "assistant") return undefined
  const messageID = record.id
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
  return Buffer.from(JSON.stringify({ beforeID, target }), "utf8").toString("base64url")
}

function decodeVisiblePageCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"))
    if (typeof parsed?.beforeID !== "string" || !parsed.beforeID || typeof parsed?.target !== "string" || !parsed.target) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

/**
 * OMP's undo extension normally tells us the selected leaf. Without it, a JSONL journal still
 * contains enough ordering information for standalone/history-only consumers to choose the newest
 * terminal node. Production Session-first explicitly disables that fallback: a newer sibling may be
 * an abandoned failed/retried turn and must never replace the extension's authoritative branch.
 */
function inferLatestTerminalLeaf(records) {
  const parents = new Set(records
    .map((record) => record.parentId)
    .filter((parentID) => typeof parentID === "string" && parentID))
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const id = records[index].id
    if (!parents.has(id)) return id
  }
  return undefined
}

async function readOmpRecords(file) {
  const records = []
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    try {
      const record = JSON.parse(line)
      if (typeof record?.id === "string") records.push(record)
    } catch {
      // One malformed journal line must not make a valid preceding transcript unavailable.
    }
  }
  return records
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
 * The selected OMP branch is the conversation truth, but a failed attempt is still user-visible
 * history: OMP can retry the same user node by creating a successful sibling, which would otherwise
 * make the earlier red error disappear the moment the Session is reopened. Preserve only assistant
 * failures attached to user prompts that are on the selected branch, and only failures journalled no
 * later than the selected leaf. Normal assistant siblings remain excluded, so this cannot resurrect
 * an abandoned answer or create the duplicate replies seen after failed turns.
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

  // Journal append order is the real chronological order across sibling attempts. Filtering the
  // original records instead of appending the failures after the branch keeps error -> retry ->
  // success in the same order OMP actually wrote it.
  return records.filter((record, index) => index <= selectedLeafIndex && visibleIDs.has(record.id))
}

function visibleBranchMessages(records, sessionID, selectedLeaf) {
  return visibleBranchRecords(records, selectedLeaf).flatMap((record) => {
    const message = messageEnvelope(record, sessionID)
    return message ? [message] : []
  })
}

function pageVisibleBranch(records, sessionID, { limit = 100, before, activeSessionLeaf } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  if (activeSessionLeaf === null) return { messages: [], before: null, hasMore: false }

  const decoded = before ? decodeVisiblePageCursor(before) : undefined
  if (before && !decoded) throw new Error("Invalid OMP history cursor")
  const selectedLeaf = decoded?.target ?? activeSessionLeaf
  if (typeof selectedLeaf !== "string" || !selectedLeaf) throw new Error("OMP active session leaf is missing from transcript")

  const messages = visibleBranchMessages(records, sessionID, selectedLeaf)
  const requestedEnd = decoded
    ? messages.findIndex((message) => message.info.id === decoded.beforeID)
    : messages.length
  if (decoded && requestedEnd < 0) throw new Error("Invalid OMP history cursor")
  const end = requestedEnd >= 0 ? requestedEnd : messages.length
  const start = Math.max(0, end - boundedLimit)
  const page = messages.slice(start, end)
  return {
    messages: page,
    before: start > 0 && page.length > 0 ? encodeVisiblePageCursor(page[0].info.id, selectedLeaf) : null,
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

/**
 * Resolve the model selected for the visible branch. A failed assistant attempt is valid model
 * evidence even when OMP then retries the same user node as a sibling: ignoring it can make a Session
 * that just answered with the chosen model reopen as Harness default after an earlier red error.
 */
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

/*
 * How long a directory listing may be reused before another lookup miss rescans.
 *
 * Short enough that a Session created moments ago is still found, long enough that opening many
 * Sessions in a row does not walk the tree once per Session.
 */
const OMP_SESSION_LISTING_TTL_MS = 1_000

export function createOmpHistoryLoader(sessionRoot = path.join(homedir(), ".omp", "agent", "sessions")) {
  const sessionFiles = new Map()
  let listing = []
  let listedAt = 0
  let listingInFlight
  let listingScans = 0

  /*
   * The recursive walk already enumerates every Session file, so keep what it read.
   *
   * Discarding it meant each new Session opened paid its own full walk of the OMP session tree, so a
   * machine with a lot of history spent O(Sessions) tree walks just to find files it had already
   * seen - which is what made opening Sessions progressively slower. The listing is retained instead
   * and searched in memory; only a miss against a stale listing walks the tree again.
   *
   * Session ids may themselves contain underscores, so files are matched by suffix rather than by
   * trying to recover an id from a file name.
   */
  async function refreshListing() {
    if (listingInFlight) return listingInFlight
    listingInFlight = (async () => {
      try {
        listingScans += 1
        const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
        listing = entries
          .filter((candidate) => candidate.isFile() && candidate.name.endsWith(".jsonl"))
          .map((candidate) => ({ name: candidate.name, file: path.join(candidate.parentPath ?? candidate.path, candidate.name) }))
        listedAt = Date.now()
      } catch (error) {
        if (error?.code === "ENOENT") {
          listing = []
          listedAt = Date.now()
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
    if (!file && Date.now() - listedAt >= OMP_SESSION_LISTING_TTL_MS) {
      await refreshListing()
      file = find()
    }
    if (!file) return undefined
    sessionFiles.set(sessionID, file)
    return file
  }

  const loadOmpHistory = async function loadOmpHistory(sessionID, { activeSessionLeaf } = {}) {
    const file = await locateSession(sessionID)
    if (!file) return []
    const records = await readOmpRecords(file)

    let selectedLeaf = activeSessionLeaf
    if (selectedLeaf === undefined) {
      // The production profile sets pageRequiresActiveLeaf on this same function. In that mode a
      // missing extension state is not permission to guess: AcpService keeps its last known snapshot
      // and retries observationally instead of opening an arbitrary terminal sibling.
      if (loadOmpHistory.pageRequiresActiveLeaf === true) return []
      selectedLeaf = inferLatestTerminalLeaf(records)
      if (!selectedLeaf) return []
    }

    return visibleBranchMessages(records, sessionID, selectedLeaf)
  }

  /** How often the session tree was walked, and how many files that walk is currently serving. */
  loadOmpHistory.diagnostics = () => ({
    source: "omp-session-jsonl",
    listingScans,
    listedFiles: listing.length,
    resolvedSessions: sessionFiles.size,
    listingAgeMs: listedAt ? Date.now() - listedAt : null
  })
  // Standalone/history-only consumers may infer a terminal leaf. The production profile overrides
  // this flag to true, which makes both full loads and pages require extension-provided branch truth.
  loadOmpHistory.pageRequiresActiveLeaf = false
  loadOmpHistory.deferAcpReplayWithoutActiveLeaf = true
  loadOmpHistory.page = async (sessionID, options = {}) => {
    const file = await locateSession(sessionID)
    if (!file) return { messages: [], before: null, hasMore: false }
    const records = await readOmpRecords(file)
    let activeSessionLeaf = options.activeSessionLeaf
    if (activeSessionLeaf === undefined) {
      if (loadOmpHistory.pageRequiresActiveLeaf === true) return { messages: [], before: null, hasMore: false }
      activeSessionLeaf = inferLatestTerminalLeaf(records)
    }
    if (activeSessionLeaf === undefined) return { messages: [], before: null, hasMore: false }
    const page = pageVisibleBranch(records, sessionID, { ...options, activeSessionLeaf })
    const model = activeSessionLeaf === null ? undefined : branchModel(records, activeSessionLeaf)
    return { ...page, ...(model ? { model } : {}) }
  }

  return loadOmpHistory
}
