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

function isBranchEntry(record) {
  // OMP 18.x physically starts every JSONL with a fixed-width `title` slot and then a logical
  // `session` header. The header has the Session id but is metadata, not a node in the parentId tree.
  // Treating it as a node creates a fake second terminal leaf for every otherwise-linear Session.
  return Boolean(
    record
    && typeof record.id === "string"
    && Object.prototype.hasOwnProperty.call(record, "parentId")
  )
}

async function readOmpRecords(file) {
  const records = []
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    try {
      const record = JSON.parse(line)
      if (isBranchEntry(record)) records.push(record)
    } catch {
      // One malformed journal line must not make a valid preceding transcript unavailable.
    }
  }
  return records
}

function terminalLeaves(records) {
  const parents = new Set(records
    .map((record) => record.parentId)
    .filter((parentID) => typeof parentID === "string" && parentID))
  return records.map((record) => record.id).filter((id) => !parents.has(id))
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

function isDescendantOrSame(entries, leaf, ancestor) {
  if (leaf === ancestor) return true
  const visited = new Set()
  let entry = entries.get(leaf)
  while (entry && !visited.has(entry.id)) {
    if (entry.id === ancestor) return true
    visited.add(entry.id)
    entry = typeof entry.parentId === "string" ? entries.get(entry.parentId) : undefined
  }
  return false
}

function comparableOnOneBranch(entries, left, right) {
  return isDescendantOrSame(entries, left, right) || isDescendantOrSame(entries, right, left)
}

function conversationalRecord(record) {
  return record?.type === "message" && (record.message?.role === "user" || record.message?.role === "assistant")
}

function conversationTip(entries, leaf) {
  const visited = new Set()
  let entry = entries.get(leaf)
  while (entry && !visited.has(entry.id)) {
    if (conversationalRecord(entry)) return entry.id
    visited.add(entry.id)
    entry = typeof entry.parentId === "string" ? entries.get(entry.parentId) : undefined
  }
  return null
}

/**
 * Return the one terminal leaf that represents a single conversational line, ignoring metadata-only
 * terminal siblings such as session_exit/title changes. This is deliberately stricter than "latest
 * leaf": sibling assistant attempts remain ambiguous and require OMP's own ACP replay.
 */
function linearTerminalLeaf(records, { descendantOf } = {}) {
  const entries = new Map(records.map((record) => [record.id, record]))
  const leaves = terminalLeaves(records).filter((leaf) => !descendantOf || isDescendantOrSame(entries, leaf, descendantOf))
  if (leaves.length === 0) return null
  if (leaves.length === 1) return leaves[0]

  const tips = leaves.map((leaf, index) => ({ leaf, index, tip: conversationTip(entries, leaf) }))
  const conversationalTips = [...new Set(tips.map((candidate) => candidate.tip).filter(Boolean))]
  if (conversationalTips.length === 0) return tips[tips.length - 1].leaf

  const deepest = conversationalTips.filter((candidate) =>
    conversationalTips.every((other) => isDescendantOrSame(entries, candidate, other))
  )
  if (deepest.length !== 1) return undefined

  const matching = tips.filter((candidate) => candidate.tip === deepest[0])
  return matching[matching.length - 1]?.leaf
}

/**
 * The selected OMP branch is the conversation truth, but a failed attempt is still user-visible
 * history. Preserve failed assistant siblings attached to selected user prompts while excluding
 * successful abandoned siblings.
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

function canonicalText(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : ""
}

function replayTurns(messages) {
  const turns = []
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message?.info || message.info.error) continue
    const role = message.info.role
    if (role !== "user" && role !== "assistant") continue
    const text = canonicalText((message.parts ?? [])
      .filter((part) => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join(""))
    const files = (message.parts ?? [])
      .filter((part) => part?.type === "file")
      .map((part) => `${part.mime ?? ""}:${typeof part.url === "string" ? part.url.length : 0}`)
      .join(",")
    if (!text && !files) continue

    const previous = turns[turns.length - 1]
    if (previous?.role === role) {
      previous.text += text
      previous.files += files
    } else {
      turns.push({ role, text, files })
    }
  }
  return turns.map((turn) => `${turn.role}\u0000${turn.text}\u0000${turn.files}`)
}

function branchReplayTurns(records, sessionID, selectedLeaf) {
  return replayTurns(selectedBranchRecords(records, selectedLeaf).flatMap((record) => {
    const message = messageEnvelope(record, sessionID)
    return message ? [message] : []
  }))
}

function sameTurns(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function endsWithTurns(full, suffix) {
  if (!suffix.length || suffix.length > full.length) return false
  const offset = full.length - suffix.length
  return suffix.every((value, index) => value === full[offset + index])
}

export function createOmpHistoryLoader(sessionRoot = path.join(homedir(), ".omp", "agent", "sessions")) {
  const sessionFiles = new Map()
  const confirmedSelections = new Map()
  const leafHints = new Map()
  const replayNeeded = new Set()
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
      // Do not cache a negative lookup. OMP creates the JSONL lazily: session/new can return before
      // the file exists, and the first prompt can create it milliseconds after a prior directory scan.
      // PI already rescans on an unknown Session; OMP must do the same or the first completed answer
      // remains invisible until a later reopen happens to outlive the old listing cache.
      await refreshListing()
      file = find()
    }
    if (!file) return undefined
    sessionFiles.set(sessionID, file)
    return file
  }

  function rememberHint(sessionID, records, activeSessionLeaf) {
    if (activeSessionLeaf === null) {
      leafHints.set(sessionID, null)
      return
    }
    if (typeof activeSessionLeaf !== "string") return
    if (records.some((record) => record.id === activeSessionLeaf)) leafHints.set(sessionID, activeSessionLeaf)
  }

  function confirm(sessionID, leaf, recordCount) {
    confirmedSelections.set(sessionID, { leaf, recordCount })
    replayNeeded.delete(sessionID)
    return leaf
  }

  function requireReplay(sessionID) {
    replayNeeded.add(sessionID)
    return undefined
  }

  function confirmedSelection(records, sessionID) {
    const state = confirmedSelections.get(sessionID)
    if (!state) return undefined
    if (records.length < state.recordCount) {
      confirmedSelections.delete(sessionID)
      return requireReplay(sessionID)
    }
    if (state.leaf !== null && !records.some((record) => record.id === state.leaf)) {
      confirmedSelections.delete(sessionID)
      return requireReplay(sessionID)
    }
    if (records.length === state.recordCount) return state.leaf

    if (state.leaf === null) {
      const selected = linearTerminalLeaf(records)
      return selected === undefined ? requireReplay(sessionID) : confirm(sessionID, selected, records.length)
    }

    // PI's normal lifecycle is linear and OMP is the same until the user actually branches/retries.
    // A user -> assistant continuation that uniquely descends from the already-confirmed leaf is safe
    // to advance directly. Only genuinely competing conversational descendants need session/load.
    const entries = new Map(records.map((record) => [record.id, record]))
    const newConversation = records.slice(state.recordCount).filter(conversationalRecord)
    if (newConversation.some((record) => !isDescendantOrSame(entries, record.id, state.leaf))) {
      return requireReplay(sessionID)
    }
    const selected = linearTerminalLeaf(records, { descendantOf: state.leaf })
    return selected === undefined ? requireReplay(sessionID) : confirm(sessionID, selected, records.length)
  }

  function selectionWithoutReplay(records, sessionID, activeSessionLeaf) {
    rememberHint(sessionID, records, activeSessionLeaf)
    const known = confirmedSelection(records, sessionID)
    if (known !== undefined) return known
    if (confirmedSelections.has(sessionID) && replayNeeded.has(sessionID)) return undefined

    const selected = linearTerminalLeaf(records)
    if (selected !== undefined) return confirm(sessionID, selected, records.length)

    // omp-undo-redo remains optional. Its leaf can help disambiguate candidates after native replay,
    // but it never becomes a prerequisite or sole authority for an ambiguous conversation tree.
    return requireReplay(sessionID)
  }

  function chooseReplayCandidate(records, sessionID, replayedMessages) {
    const replay = replayTurns(replayedMessages)
    if (!replay.length) return undefined
    const entries = new Map(records.map((record) => [record.id, record]))
    const candidates = terminalLeaves(records).map((leaf, index) => ({
      leaf,
      index,
      turns: branchReplayTurns(records, sessionID, leaf)
    }))

    let matched = candidates.filter((candidate) => sameTurns(candidate.turns, replay))
    if (!matched.length) matched = candidates.filter((candidate) => endsWithTurns(candidate.turns, replay))
    if (!matched.length) return undefined

    const hint = leafHints.get(sessionID)
    if (typeof hint === "string") {
      const hinted = matched.find((candidate) => candidate.leaf === hint)
      if (hinted) return hinted.leaf
    }

    const prior = confirmedSelections.get(sessionID)?.leaf
    if (typeof prior === "string") {
      const related = matched.filter((candidate) => comparableOnOneBranch(entries, candidate.leaf, prior))
      if (related.length === 1) return related[0].leaf
      if (related.length > 1 && related.every((candidate) => related.every((other) => comparableOnOneBranch(entries, candidate.leaf, other.leaf)))) {
        return related[related.length - 1].leaf
      }
    }

    if (matched.length === 1) return matched[0].leaf
    if (matched.every((candidate) => matched.every((other) => comparableOnOneBranch(entries, candidate.leaf, other.leaf)))) {
      return matched[matched.length - 1].leaf
    }
    return undefined
  }

  const loadOmpHistory = async function loadOmpHistory(sessionID, { activeSessionLeaf } = {}) {
    const file = await locateSession(sessionID)
    if (!file) return []
    const records = await readOmpRecords(file)
    const selectedLeaf = selectionWithoutReplay(records, sessionID, activeSessionLeaf)
    if (selectedLeaf === undefined) return []
    return visibleBranchMessages(records, sessionID, selectedLeaf)
  }

  loadOmpHistory.reconcileReplay = async (sessionID, replayedMessages) => {
    const file = await locateSession(sessionID)
    if (!file) return undefined
    const records = await readOmpRecords(file)
    const selectedLeaf = chooseReplayCandidate(records, sessionID, replayedMessages)
    if (selectedLeaf === undefined) return undefined
    confirm(sessionID, selectedLeaf, records.length)
    return selectedLeaf
  }

  loadOmpHistory.needsReplay = (sessionID) => replayNeeded.has(sessionID)

  loadOmpHistory.diagnostics = () => ({
    source: "omp-session-jsonl+native-acp-branch",
    listingScans,
    listedFiles: listing.length,
    resolvedSessions: sessionFiles.size,
    confirmedBranches: confirmedSelections.size,
    replayNeeded: replayNeeded.size
  })

  loadOmpHistory.pageRequiresActiveLeaf = false
  loadOmpHistory.deferAcpReplayWithoutActiveLeaf = false
  loadOmpHistory.page = async (sessionID, options = {}) => {
    const file = await locateSession(sessionID)
    if (!file) return { messages: [], before: null, hasMore: false }
    const records = await readOmpRecords(file)

    let activeSessionLeaf
    if (options.before) {
      const decoded = decodeVisiblePageCursor(options.before)
      if (!decoded) throw new Error("Invalid OMP history cursor")
      activeSessionLeaf = decoded.target
    } else {
      activeSessionLeaf = selectionWithoutReplay(records, sessionID, options.activeSessionLeaf)
      if (activeSessionLeaf === undefined) return undefined
    }

    const page = pageVisibleBranch(records, sessionID, { ...options, activeSessionLeaf })
    const model = activeSessionLeaf === null ? undefined : branchModel(records, activeSessionLeaf)
    return { ...page, ...(model ? { model } : {}) }
  }

  return loadOmpHistory
}
