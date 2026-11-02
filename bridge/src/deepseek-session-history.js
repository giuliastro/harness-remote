import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import * as zlib from "node:zlib"

const ZSTD_MAGIC = 0xfd2fb528
const SESSION_FILE = "session.v4.jsonl.zstd"

function zstdFrameEnd(buffer, start) {
  if (start + 5 > buffer.length || buffer.readUInt32LE(start) !== ZSTD_MAGIC) return undefined
  let offset = start + 4
  const descriptor = buffer[offset++]
  const contentSizeFlag = (descriptor >> 6) & 3
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictionaryFlag = descriptor & 3
  if (!singleSegment) offset += 1
  offset += dictionaryFlag === 3 ? 4 : dictionaryFlag
  let contentSizeBytes = [0, 2, 4, 8][contentSizeFlag]
  if (contentSizeFlag === 0 && singleSegment) contentSizeBytes = 1
  offset += contentSizeBytes
  if (offset > buffer.length) return undefined
  while (true) {
    if (offset + 3 > buffer.length) return undefined
    const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
    offset += 3
    const last = header & 1
    const type = (header >> 1) & 3
    const size = header >> 3
    offset += type === 1 ? 1 : size
    if (offset > buffer.length) return undefined
    if (last) break
  }
  if (checksum) offset += 4
  return offset <= buffer.length ? offset : undefined
}

/**
 * DSH appends one complete JSON line per zstd frame. Node's zstd helpers decode only the first
 * frame, so walk the frame headers instead of guessing at magic-byte boundaries inside compressed
 * data. A file written by an older DSH version simply fails to parse and falls back to ACP replay.
 */
export function decodeDeepseekJournal(buffer) {
  if (typeof zlib.zstdDecompressSync !== "function" || buffer.length < 4 || buffer.readUInt32LE(0) !== ZSTD_MAGIC) return undefined
  const chunks = []
  let offset = 0
  while (offset < buffer.length) {
    const end = zstdFrameEnd(buffer, offset)
    if (!end || end <= offset) return undefined
    try {
      chunks.push(zlib.zstdDecompressSync(buffer.subarray(offset, end)))
    } catch {
      return undefined
    }
    offset = end
  }
  return Buffer.concat(chunks).toString("utf8")
}

function recordTime(record) {
  return Number.isFinite(record?.time) ? record.time : Date.now()
}

function contentParts(content, messageID, toolParts) {
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
    if (item?.type === "reasoning" && typeof item.text === "string" && item.text) {
      parts.push({ id: `${messageID}:reasoning:${index}`, messageID, type: "reasoning", text: item.text })
      return
    }
    if (item?.type === "tool-call" && typeof item.id === "string" && item.id) {
      const part = {
        id: `${messageID}:tool:${index}`,
        messageID,
        type: "tool",
        tool: typeof item.name === "string" && item.name ? item.name : "tool",
        callID: item.id,
        state: {
          status: "incomplete",
          input: item.arguments,
          title: typeof item.name === "string" ? item.name : undefined,
          time: {}
        }
      }
      toolParts.set(item.id, part)
      parts.push(part)
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

function modelFromAssistant(message) {
  const providerID = typeof message?.source?.provider === "string" ? message.source.provider : ""
  const modelID = typeof message?.source?.model === "string" ? message.source.model : ""
  return providerID && modelID ? { providerID, modelID } : undefined
}

/**
 * The DSH journal is append-only and records the visible conversation as `user/message`,
 * `assistant/message`, and `tool/result` entries. Context that DSH injects for itself (time,
 * skills, tool jobs, goals) is a user-role message with a different source kind; it must not open
 * a turn the user never wrote. Tool calls live inside the assistant message and their results
 * arrive later, so they are joined back into that message's Activity part.
 */
export function deepseekJournalMessages(text, sessionID) {
  const messages = []
  const toolParts = new Map()
  let model
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record?.type === "assistant/message") {
      const message = record.data?.message
      const messageID = typeof message?.id === "string" && message.id ? message.id : `${sessionID}:assistant:${record.seq}`
      const parts = contentParts(message?.content, messageID, toolParts)
      const created = recordTime(record)
      for (const part of parts) {
        if (part.type === "tool") part.state.time = { ...part.state.time, start: created }
      }
      const currentModel = modelFromAssistant(message)
      if (currentModel) model = currentModel
      if (parts.length === 0) continue
      messages.push({
        info: { id: messageID, role: "assistant", sessionID, time: { created } },
        parts
      })
      continue
    }
    if (record?.type === "tool/result") {
      const message = record.data?.message
      const part = toolParts.get(message?.toolCallId)
      if (!part) continue
      const output = toolResultText(message?.content)
      part.state.status = message?.isError === true ? "error" : "completed"
      if (output) part.state.output = output
      part.state.time = { ...part.state.time, end: recordTime(record) }
      continue
    }
    if (record?.type !== "user/message") continue
    if (record.data?.source?.kind !== "user") continue
    const messageID = typeof record.data?.id === "string" && record.data.id
      ? record.data.id
      : `${sessionID}:user:${record.seq}`
    const parts = contentParts(record.data?.content, messageID, toolParts)
    if (parts.length === 0) continue
    messages.push({
      info: { id: messageID, role: "user", sessionID, time: { created: recordTime(record) } },
      parts
    })
  }
  return { messages, model }
}

async function readJournal(file) {
  try {
    return decodeDeepseekJournal(await readFile(file))
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
}

function defaultSessionRoot() {
  return path.join(process.env.DSH_HOME || path.join(homedir(), ".dsh"), "sessions")
}

export function createDeepseekHistoryLoader(sessionRoot = defaultSessionRoot()) {
  const files = new Map()
  const cache = new Map()

  async function locateSession(sessionID) {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionID)) return undefined
    const known = files.get(sessionID)
    if (known) return known
    try {
      const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
      const entry = entries.find((candidate) => {
        if (!candidate.isFile() || candidate.name !== SESSION_FILE) return false
        const parent = candidate.parentPath ?? candidate.path
        return parent ? path.basename(parent) === sessionID : false
      })
      if (!entry) return undefined
      const parent = entry.parentPath ?? entry.path
      const file = path.join(parent, entry.name)
      files.set(sessionID, file)
      return file
    } catch (error) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
  }

  async function loadJournal(sessionID) {
    const file = await locateSession(sessionID)
    if (!file) return undefined
    const info = await stat(file)
    const cached = cache.get(sessionID)
    if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached
    const text = await readJournal(file)
    if (text === undefined) return undefined
    const parsed = deepseekJournalMessages(text, sessionID)
    const value = { ...parsed, mtimeMs: info.mtimeMs, size: info.size }
    cache.set(sessionID, value)
    return value
  }

  const loadDeepseekHistory = async (sessionID) => (await loadJournal(sessionID))?.messages ?? []

  loadDeepseekHistory.page = async (sessionID, { limit = 100, before } = {}) => {
    const journal = await loadJournal(sessionID)
    if (!journal) return undefined
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
    const end = before ? journal.messages.findIndex((message) => message?.info?.id === before) : journal.messages.length
    const safeEnd = end >= 0 ? end : journal.messages.length
    const start = Math.max(0, safeEnd - boundedLimit)
    return {
      messages: journal.messages.slice(start, safeEnd),
      before: start > 0 ? journal.messages[start]?.info?.id ?? null : null,
      hasMore: start > 0,
      ...(journal.model ? { model: journal.model } : {})
    }
  }

  return loadDeepseekHistory
}
