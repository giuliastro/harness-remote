import { createReadStream } from "node:fs"
import { access, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

/*
 * Read one OMP Session straight out of the journal OMP itself writes.
 *
 * Every rule below is taken from oh-my-pi 18.x rather than inferred from observed output, because
 * the previous readers guessed at the parts of the format that only appear in old or branched
 * Sessions - which is exactly where they produced empty transcripts:
 *
 * - `packages/coding-agent/src/session/session-entries.ts` defines the file's three record kinds:
 *   a fixed-width `type:"title"` slot on line 1, a `type:"session"` header on line 2, then the
 *   append-only `SessionEntry` list. Only entries carry `parentId`; the header carries an `id` but
 *   is not part of the branch graph.
 * - `SessionEntryIndex` in `session-manager.ts` selects the persisted branch: `insert()` assigns
 *   `#leaf = entry.id` for every entry it reads, so after `rebuild()` the leaf is simply the last
 *   entry in file order, and `pathTo()` walks `parentId` back from it.
 * - `session-migrations.ts` shows that v1 journals have no `id`/`parentId` at all. OMP adds them in
 *   memory (and rewrites the file) the first time it opens such a Session, so a reader that
 *   requires ids reports a v1 Session as empty until something else makes OMP migrate it.
 * - `session/messages.ts` marks a user turn `synthetic`/`steering` when it was injected rather than
 *   typed, and `shouldRenderAbortReason()` suppresses the two abort reasons OMP stores on an
 *   assistant message but never shows.
 */

/** `SILENT_ABORT_MARKER` / `USER_INTERRUPT_LABEL` from OMP's session/messages.ts. */
const SILENT_ABORT_MARKER = "__omp.silent_abort__"
const USER_INTERRUPT_LABEL = "Interrupted by user"
/** `AIError.Flag.SilentAbort` / `AIError.Flag.UserInterrupt` from OMP's ai/error/flags.ts. */
const ERROR_FLAG_SILENT_ABORT = 0x0200_0000
const ERROR_FLAG_USER_INTERRUPT = 0x0400_0000

/** `blob:sha256:<hash>` externalised image payloads from OMP's blob-store.ts. */
const BLOB_REF_PREFIX = "blob:sha256:"

function isSuppressedAbort(message) {
  const errorId = Number.isInteger(message?.errorId) ? message.errorId : 0
  if ((errorId & ERROR_FLAG_SILENT_ABORT) !== 0 || (errorId & ERROR_FLAG_USER_INTERRUPT) !== 0) return true
  return message?.errorMessage === SILENT_ABORT_MARKER || message?.errorMessage === USER_INTERRUPT_LABEL
}

/**
 * A turn that failed is journalled as an assistant message with the provider's own sentence in
 * `errorMessage`. Skipping those made a rate-limited or unpaid Session look like it had simply lost
 * its replies. The two abort reasons OMP's own renderers suppress are suppressed here too: showing
 * them turned every Stop into a red "Interrupted by user" banner in the reopened transcript.
 */
/** A Stop by the user, as opposed to OMP's silent internal abort. Shown as a neutral interruption. */
function isUserInterrupt(message) {
  const errorId = Number.isInteger(message?.errorId) ? message.errorId : 0
  return (errorId & ERROR_FLAG_USER_INTERRUPT) !== 0 || message?.errorMessage === USER_INTERRUPT_LABEL
}

function messageError(message) {
  if (isSuppressedAbort(message)) return undefined
  const detail = typeof message?.errorMessage === "string" ? message.errorMessage.trim() : ""
  if (!detail) return undefined
  return { name: "HarnessTurnError", message: detail }
}

function imagePart(item, messageID, index) {
  if (typeof item?.data !== "string" || !item.data) return undefined
  // An externalised payload is a reference into OMP's blob store, not base64. Rendering it as a
  // data URL produced a permanently broken thumbnail, so the part is dropped instead.
  if (item.data.startsWith(BLOB_REF_PREFIX)) return undefined
  const mime = typeof item.mimeType === "string" && item.mimeType ? item.mimeType : "image/png"
  return { id: `${messageID}:file:${index}`, messageID, type: "file", mime, url: `data:${mime};base64,${item.data}` }
}

/** Content blocks shared by user and assistant messages (`TextContent` / `ImageContent`). */
function contentParts(content, messageID) {
  if (typeof content === "string") {
    return content ? [{ id: `${messageID}:text:0`, messageID, type: "text", text: content }] : []
  }
  if (!Array.isArray(content)) return []
  const parts = []
  content.forEach((item, index) => {
    if (item?.type === "text" && typeof item.text === "string" && item.text) {
      parts.push({ id: `${messageID}:text:${index}`, messageID, type: "text", text: item.text })
      return
    }
    if (item?.type === "thinking" && typeof item.thinking === "string" && item.thinking) {
      parts.push({ id: `${messageID}:reasoning:${index}`, messageID, type: "reasoning", text: item.thinking })
      return
    }
    if (item?.type === "toolCall" && typeof item.id === "string" && item.id) {
      parts.push({
        id: `${messageID}:tool:${index}`,
        messageID,
        type: "tool",
        tool: typeof item.name === "string" ? item.name : "tool",
        callID: item.id,
        state: {
          // Every tool call in the journal belongs to a turn OMP already finished writing. A call
          // whose `toolResult` never landed is reported as `incomplete` rather than invented as a
          // success or a failure, which is the same rule the live path settles turns with.
          status: "incomplete",
          input: item.arguments,
          title: typeof item.name === "string" ? item.name : undefined,
          time: {}
        }
      })
      return
    }
    if (item?.type === "image") {
      const part = imagePart(item, messageID, index)
      if (part) parts.push(part)
    }
  })
  return parts
}

function toolResultText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("\n")
}

function entryTimestamp(record) {
  const created = Date.parse(record?.timestamp ?? "")
  return Number.isFinite(created) ? created : undefined
}

/**
 * Build the visible transcript for one already-selected branch.
 *
 * Tool activity is reconstructed here rather than left to ACP replay: an assistant message carries
 * its `toolCall` blocks and the matching `toolResult` arrives as its own entry further down the
 * branch, so the two are joined back into one Activity part. Without this a reopened OMP Session
 * showed the answers with none of the work that produced them.
 */
function branchMessages(branch, sessionID) {
  const messages = []
  const toolParts = new Map()
  let fallbackTime = 0

  for (const record of branch) {
    if (record.type !== "message") continue
    const message = record.message
    const role = message?.role
    const messageID = record.id
    const created = entryTimestamp(record) ?? (fallbackTime += 1)
    fallbackTime = Math.max(fallbackTime, created)

    if (role === "toolResult") {
      const part = toolParts.get(message.toolCallId)
      if (!part) continue
      const output = toolResultText(message.content)
      part.state.status = message.isError === true ? "error" : "completed"
      if (output) part.state.output = output
      part.state.time = { ...part.state.time, end: created }
      continue
    }

    // `developer`, `custom` and the pre-v3 `hookMessage` are harness/extension injections rather
    // than conversation. ACP replay flattens all of them into `user_message_chunk`s, which is one
    // more reason replay cannot serve as a transcript: each would open a turn nobody wrote.
    if (role !== "user" && role !== "assistant") continue
    // `synthetic` marks a turn the harness injected (auto-continue) and `steering` a mid-turn
    // nudge OMP documents as "never rendered". Either one would open a conversation turn the user
    // did not write, which is what makes turn boundaries unusable for the app above.
    if (role === "user" && (message.synthetic === true || message.steering === true)) continue

    const parts = contentParts(message.content, messageID)
    const error = role === "assistant" ? messageError(message) : undefined
    const interrupted = role === "assistant" && isUserInterrupt(message)
    if (parts.length === 0 && !error && !interrupted) continue
    for (const part of parts) {
      if (part.type === "tool") {
        part.state.time = { start: created }
        toolParts.set(part.callID, part)
      }
    }
    messages.push({
      info: {
        id: messageID,
        role,
        sessionID,
        time: { created },
        ...(error ? { error } : {}),
        ...(interrupted ? { interrupted: true } : {})
      },
      parts
    })
  }
  return messages
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
 * Resolve the model selected on one exact branch, including journals predating `model_change`.
 *
 * `EPHEMERAL_MODEL_CHANGE_ROLE` ("fallback") and the role-scoped entries OMP writes for its smol
 * and slow models describe a different slot, so only the default role moves the picker.
 */
function branchModel(branch) {
  let selected
  for (const record of branch) {
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

/**
 * Read one journal into the branch graph OMP itself keeps in memory.
 *
 * The two records that are not `SessionEntry`s are dropped here: the fixed-width title slot carries
 * no `id` at all, and the `type:"session"` header carries one but no `parentId`. Treating the
 * header as a graph node is what made a Session whose entries were unreadable (a v1 journal) select
 * the header as its leaf and render an empty conversation.
 */
async function readJournal(file) {
  const entries = []
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    let record
    try {
      record = JSON.parse(line)
    } catch {
      // One malformed journal line must not make a valid preceding transcript unavailable.
      continue
    }
    if (!record || typeof record !== "object") continue
    if (record.type === "title") continue
    if (record.type === "session") continue
    entries.push(record)
  }

  // v1 journals predate the entry tree entirely. OMP reconstructs it linearly on load
  // (migrateV1ToV2) and rewrites the file; until that happens this is the only way to read one.
  // The ids are derived from file position so two reads of the same unmigrated file agree, and so
  // do a read before and a read after a Session that has not been touched since.
  //
  // The absence of ids is the signature, not the header's version field: OMP writes the version
  // onto the header only as it migrates, and a journal that already carries an entry tree must
  // keep the ids it was written with whatever its header says.
  if (entries.length > 0 && entries.every((entry) => typeof entry.id !== "string")) {
    let previous = null
    entries.forEach((entry, index) => {
      entry.id = `omp-v1:${index}`
      entry.parentId = previous
      previous = entry.id
    })
  }

  const byId = new Map()
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry)
  }
  return { entries, byId }
}

/** `SessionEntryIndex.pathTo()`: walk `parentId` back from the leaf and return it root-first. */
function branchTo(byId, leaf) {
  const branch = []
  const visited = new Set()
  let entry = byId.get(leaf)
  while (entry && !visited.has(entry.id)) {
    visited.add(entry.id)
    branch.push(entry)
    entry = typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined
  }
  return branch.reverse()
}

/**
 * `SessionEntryIndex.rebuild()` assigns the leaf on every insert, so OMP's own persisted branch is
 * the last entry in file order. The optional undo/redo extension publishes the live leaf while OMP
 * is running, which is the only case where the two can differ; `null` means it selected the root.
 */
function resolveBranch(journal, activeSessionLeaf) {
  if (activeSessionLeaf === null) return []
  // A leaf the extension published for a journal that has since been rewritten - compaction and
  // `/clear` both drop entries - is stale, not a reason to refuse the Session. Falling back to the
  // entry order lands on exactly the branch OMP itself would resume, so a stale extension can no
  // longer make a real conversation unreadable.
  if (typeof activeSessionLeaf === "string" && journal.byId.has(activeSessionLeaf)) {
    return branchTo(journal.byId, activeSessionLeaf)
  }
  const leaf = journal.entries.at(-1)?.id
  return leaf ? branchTo(journal.byId, leaf) : []
}

/*
 * How long a directory listing may be reused before another lookup miss rescans.
 *
 * Short enough that a Session created moments ago is still found - OMP creates the journal lazily,
 * so the file for a Session this bridge just started can legitimately appear after the first
 * miss - and long enough that opening many Sessions in a row does not walk the tree once each.
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
    // A remembered path is re-checked rather than trusted forever: OMP moves a Session's journal
    // when its workspace moves, and a cached path that no longer exists otherwise reports a real
    // Session as permanently empty.
    if (known) {
      try {
        await access(known)
        return known
      } catch {
        sessionFiles.delete(sessionID)
      }
    }
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

  async function readBranch(sessionID, activeSessionLeaf) {
    const file = await locateSession(sessionID)
    if (!file) return undefined
    const journal = await readJournal(file)
    return resolveBranch(journal, activeSessionLeaf)
  }

  const loadOmpHistory = async function loadOmpHistory(sessionID, { activeSessionLeaf } = {}) {
    const branch = await readBranch(sessionID, activeSessionLeaf)
    if (!branch) return []
    return branchMessages(branch, sessionID)
  }

  /** How often the session tree was walked, and how many files that walk is currently serving. */
  loadOmpHistory.diagnostics = () => ({
    source: "omp-session-jsonl",
    listingScans,
    listedFiles: listing.length,
    resolvedSessions: sessionFiles.size,
    listingAgeMs: listedAt ? Date.now() - listedAt : null
  })

  // The branch is resolved from the journal's own entry order, so paging never has to wait for the
  // optional extension - or for an ACP session/load, which OMP answers by replaying the whole
  // transcript back over the wire under freshly minted message ids.
  loadOmpHistory.pageRequiresActiveLeaf = false

  /**
   * OMP's ACP `session/load` is a replay, not a read: `AcpAgent.loadSession` calls
   * `#replaySessionHistory`, which re-emits every stored message under a new `crypto.randomUUID()`.
   * There is therefore no ACP fallback that could stand in for an unreadable journal, and a failed
   * read must surface as a failure rather than as an empty conversation.
   */
  loadOmpHistory.journalOnly = true

  loadOmpHistory.page = async (sessionID, options = {}) => {
    const messages = await loadOmpHistory(sessionID, options)
    const limit = Math.max(1, Math.min(500, Number(options.limit) || 100))
    const requestedEnd = options.before
      ? messages.findIndex((message) => message.info.id === options.before)
      : messages.length
    const end = requestedEnd >= 0 ? requestedEnd : messages.length
    const start = Math.max(0, end - limit)
    const model = await loadOmpHistory.sessionModel(sessionID, options)
    return {
      messages: messages.slice(start, end),
      before: start > 0 ? messages[start]?.info?.id ?? null : null,
      hasMore: start > 0,
      ...(model ? { model } : {})
    }
  }

  /**
   * The model selected on the Session's own branch.
   *
   * The picker needs this for a Session this bridge has never opened, and OMP will not report a
   * `model` config option without opening one. Reading it from the branch keeps opening a Session
   * free of side effects, and keeps the answer identical to the one OMP would resume with.
   */
  loadOmpHistory.sessionModel = async (sessionID, { activeSessionLeaf } = {}) => {
    try {
      const branch = await readBranch(sessionID, activeSessionLeaf)
      return branch?.length ? branchModel(branch) : undefined
    } catch {
      return undefined
    }
  }

  return loadOmpHistory
}
