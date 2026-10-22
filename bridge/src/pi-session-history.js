import { createReadStream } from "node:fs"
import { appendFile, open, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"
import { scanLinesBackward } from "./backward-line-scan.js"

function defaultSessionRoot() {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return process.env.PI_CODING_AGENT_SESSION_DIR
  const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent")
  return path.join(agentDir, "sessions")
}

function messageParts(content, messageID) {
  if (typeof content === "string") return content ? [{ id: `${messageID}:text:0`, messageID, type: "text", text: content }] : []
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
      return [{ id: `${messageID}:file:${index}`, messageID, type: "file", mime, url: `data:${mime};base64,${item.data}` }]
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
  if (message?.role === "assistant" && message.stopReason === "aborted") return undefined
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
  // A Stop is journalled as an aborted reply: not an error, but the turn did not finish.
  const interrupted = role === "assistant" && record.message?.stopReason === "aborted"
  if (parts.length === 0 && !error && !interrupted) return undefined
  const created = Date.parse(record.timestamp ?? "")
  return {
    info: {
      id: messageID,
      role,
      sessionID,
      time: { created: Number.isFinite(created) ? created : Date.now() },
      ...(error ? { error } : {}),
      ...(interrupted ? { interrupted: true } : {})
    },
    parts
  }
}

function modelSelection(providerID, modelID) {
  if (typeof providerID !== "string" || !providerID || typeof modelID !== "string" || !modelID) return undefined
  return { providerID, modelID }
}

/** PI persists both explicit model_change entries and provider/model on terminal assistant messages. */
function modelSelectionFromRecord(record) {
  if (record?.type === "model_change") return modelSelection(record.provider, record.modelId)
  if (record?.type === "message" && record.message?.role === "assistant") {
    return modelSelection(record.message.provider, record.message.model)
  }
  return undefined
}

function thinkingLevelFromRecord(record) {
  return record?.type === "thinking_level_change" && typeof record.thinkingLevel === "string" && record.thinkingLevel
    ? record.thinkingLevel
    : undefined
}

async function readRecords(file) {
  const records = []
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
  for await (const line of lines) {
    try {
      const record = JSON.parse(line)
      if (record && typeof record === "object") records.push(record)
    } catch {
      // PI deliberately skips malformed journal lines while listing sessions. Mirror that behavior.
    }
  }
  return records
}

function encodePageCursor(offset, target) {
  return Buffer.from(JSON.stringify({ offset, target }), "utf8").toString("base64url")
}

function decodePageCursor(value) {
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"))
    if (!Number.isSafeInteger(parsed?.offset) || parsed.offset < 0 || typeof parsed?.target !== "string" || !parsed.target) {
      return undefined
    }
    return parsed
  } catch {
    return undefined
  }
}

function parseRecordBuffer(buffer) {
  if (buffer.length > 0 && buffer[buffer.length - 1] === 0x0d) buffer = buffer.subarray(0, -1)
  try {
    const record = JSON.parse(buffer.toString("utf8"))
    return record && typeof record === "object" ? record : undefined
  } catch {
    return undefined
  }
}

async function readPiPage(file, sessionID, { limit = 100, before } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
  const handle = await open(file, "r")
  try {
    const { size } = await handle.stat()
    const decoded = before ? decodePageCursor(before) : undefined
    if (before && (!decoded || decoded.offset > size)) throw new Error("Invalid PI history cursor")

    const from = decoded?.offset ?? size
    let target = decoded?.target
    let seekLeaf = !target
    let matchedRequestedTarget = !target
    const messages = []
    let resumeCursor = null
    let hasMore = false
    let done = false
    let selectedModel
    let selectedVariant

    const visit = (line, offset) => {
      const record = parseRecordBuffer(line)
      if (!record || typeof record.id !== "string") return
      if (seekLeaf) {
        target = record.id
        seekLeaf = false
        matchedRequestedTarget = true
      }
      if (record.id !== target) return
      matchedRequestedTarget = true
      // We are walking the selected branch newest -> oldest. The first model / thinking entries
      // encountered are therefore the settings that own this native Session at its current leaf.
      selectedModel ??= modelSelectionFromRecord(record)
      selectedVariant ??= thinkingLevelFromRecord(record)
      target = typeof record.parentId === "string" && record.parentId ? record.parentId : undefined
      const message = messageEnvelope(record, sessionID)
      if (message) {
        if (messages.length < boundedLimit) {
          messages.push(message)
          if (messages.length === boundedLimit && target) resumeCursor = encodePageCursor(offset, target)
        } else {
          hasMore = true
          done = true
        }
      }
      if (!target) done = true
    }

    for await (const { line, offset } of scanLinesBackward(handle, { from })) {
      if (done) break
      visit(line, offset)
    }

    if (decoded && !matchedRequestedTarget) throw new Error("Invalid PI history cursor")
    const model = selectedModel
      ? { ...selectedModel, ...(selectedVariant ? { variant: selectedVariant } : {}) }
      : undefined
    return {
      messages: messages.slice(0, boundedLimit).reverse(),
      before: hasMore ? resumeCursor : null,
      hasMore,
      ...(model ? { model } : {})
    }
  } finally {
    await handle.close()
  }
}

export function createPiHistoryLoader(sessionRoot = defaultSessionRoot()) {
  const sessionFiles = new Map()

  async function locateSession(sessionID) {
    const known = sessionFiles.get(sessionID)
    if (known) return known
    if (!/^[A-Za-z0-9._-]+$/.test(sessionID)) return undefined
    try {
      const suffix = `_${sessionID}.jsonl`
      const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
      const entry = entries.find((candidate) => candidate.isFile() && candidate.name.endsWith(suffix))
      if (!entry) return undefined
      const file = path.join(entry.parentPath ?? entry.path, entry.name)
      sessionFiles.set(sessionID, file)
      return file
    } catch (error) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
  }

  const loadPiHistory = async (sessionID) => {
    const file = await locateSession(sessionID)
    if (!file) return []
    const records = await readRecords(file)
    const byID = new Map(records.filter((record) => typeof record.id === "string").map((record) => [record.id, record]))
    const leaf = [...records].reverse().find((record) => typeof record.id === "string")
    const branch = []
    const visited = new Set()
    let current = leaf
    while (current && !visited.has(current.id)) {
      visited.add(current.id)
      branch.push(current)
      current = typeof current.parentId === "string" ? byID.get(current.parentId) : undefined
    }
    branch.reverse()

    return branch.flatMap((record) => {
      const message = messageEnvelope(record, sessionID)
      return message ? [message] : []
    })
  }

  loadPiHistory.page = async (sessionID, options = {}) => {
    const file = await locateSession(sessionID)
    if (!file) return { messages: [], before: null, hasMore: false }
    return readPiPage(file, sessionID, options)
  }

  // PI's JSONL journal remains the source of truth for transcript reads even after ACP takes
  // ownership for models/prompts. A live ACP session is lifecycle state, not history authority.
  loadPiHistory.authoritativeHistory = true
  loadPiHistory.claimOnLoad = true
  loadPiHistory.renameSession = async (sessionID, title) => {
    const file = await locateSession(sessionID)
    if (!file) throw new Error("PI session journal not found")
    const records = await readRecords(file)
    const ids = new Set(records.flatMap((record) => typeof record.id === "string" ? [record.id] : []))
    const parent = [...records].reverse().find((record) => typeof record.id === "string")
    let id
    do id = randomUUID().slice(0, 8)
    while (ids.has(id))
    const name = title.replace(/[\r\n]+/g, " ").trim()
    const entry = {
      type: "session_info",
      id,
      parentId: parent?.id ?? null,
      timestamp: new Date().toISOString(),
      name
    }
    await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8")
  }

  return loadPiHistory
}
