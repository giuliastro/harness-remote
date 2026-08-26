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

function canonicalText(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : ""
}

/**
 * ACP can replay one logical assistant turn as one envelope while OMP journals several adjacent
 * assistant records. Branch matching therefore compares coalesced conversational turns rather than
 * transport message ids or raw record counts. Reasoning is deliberately ignored: text/file content
 * and user/assistant boundaries are the stable overlap between ACP replay and the JSONL journal.
 */
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

    const previous = turns.at(-1)
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

/*
 * How long a directory listing may be reused before another lookup miss rescans.
 *
 * Short enough that a Session created moments ago is still found, long enough that opening many
 * Sessions in a row does not walk the tree once per Session.
 */
const OMP_SESSION_LISTING_TTL_MS = 1_000

export function createOmpHistoryLoader(sessionRoot = path.join(homedir(), ".omp", "agent", "sessions")) {
  const sessionFiles = new Map()
  const confirmedSelections = new Map()
  const leafHints = new Map()
  const replayNeeded = new Set()
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

  function confirmedSelection(records, sessionID) {
    const state = confirmedSelections.get(sessionID)
    if (!state) return undefined
    if (records.length < state.recordCount) {
      confirmedSelections.delete(sessionID)
      replayNeeded.add(sessionID)
      return undefined
    }

    if (state.leaf !== null && !records.some((record) => record.id === state.leaf)) {
      confirmedSelections.delete(sessionID)
      replayNeeded.add(sessionID)
      return undefined
    }

    if (records.length === state.recordCount) return state.leaf

    // Any newly appended user/assistant record can represent a new turn, retry, interruption or
    // sibling branch. Do not guess which one OMP selected. A metadata-only append (model/session_exit)
    // cannot change visible conversation truth and may advance the cached leaf safely.
    if (records.slice(state.recordCount).some(conversationalRecord)) {
      replayNeeded.add(sessionID)
      return undefined
    }

    if (state.leaf === null) return confirm(sessionID, null, records.length)

    const entries = new Map(records.map((record) => [record.id, record]))
    const descendants = terminalLeaves(records).filter((leaf) => isDescendantOrSame(entries, leaf, state.leaf))
    const nextLeaf = descendants.length === 1 ? descendants[0] : state.leaf
    return confirm(sessionID, nextLeaf, records.length)
  }

  function selectionWithoutReplay(records, sessionID, activeSessionLeaf) {
    rememberHint(sessionID, records, activeSessionLeaf)
    const known = confirmedSelection(records, sessionID)
    if (known !== undefined) return known

    const leaves = terminalLeaves(records)
    if (leaves.length === 0) return confirm(sessionID, null, records.length)
    if (leaves.length === 1) return confirm(sessionID, leaves[0], records.length)

    // The undo/redo extension is optional and may be absent or stale. In an ambiguous tree it is a
    // hint, not permission to replace OMP's native branch choice. Fall through to ACP session/load,
    // which replays the branch OMP itself currently considers active.
    replayNeeded.add(sessionID)
    return undefined
  }

  function chooseReplayCandidate(records, sessionID, replayedMessages) {
    const replay = replayTurns(replayedMessages)
    if (!replay.length) return undefined
    const entries = new Map(records.map((record) => [record.id, record]))
    const candidates = records.map((record, index) => ({
      leaf: record.id,
      index,
      turns: branchReplayTurns(records, sessionID, record.id)
    }))

    let matched = candidates.filter((candidate) => sameTurns(candidate.turns, replay))
    if (!matched.length) {
      // Some OMP ACP versions replay only a recent suffix. Accept that only when it still identifies
      // one branch unambiguously; never use a longest/latest heuristic to pick among siblings.
      matched = candidates.filter((candidate) => endsWithTurns(candidate.turns, replay))
    }
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
        return related.sort((left, right) => right.index - left.index)[0].leaf
      }
    }

    if (matched.length === 1) return matched[0].leaf
    if (matched.every((candidate) => matched.every((other) => comparableOnOneBranch(entries, candidate.leaf, other.leaf)))) {
      return matched.sort((left, right) => right.index - left.index)[0].leaf
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

  /**
   * Reconcile an ACP replay with the JSONL tree. ACP owns branch selection; JSONL then restores the
   * persistent ids, red failed attempts, model changes and paging information ACP omits. This is the
   * v2 behavior made explicit instead of relying on a Send to incidentally warm AcpService first.
   */
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

  /** How often the session tree was walked, and how many files that walk is currently serving. */
  loadOmpHistory.diagnostics = () => ({
    source: "omp-session-jsonl+native-acp-branch",
    listingScans,
    listedFiles: listing.length,
    resolvedSessions: sessionFiles.size,
    confirmedBranches: confirmedSelections.size,
    replayNeeded: replayNeeded.size,
    listingAgeMs: listedAt ? Date.now() - listedAt : null
  })

  // The extension is deliberately optional. The loader handles unambiguous journals directly and
  // requests ACP replay only when native branch truth is actually needed.
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
