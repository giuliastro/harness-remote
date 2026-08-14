import { createReadStream } from "node:fs"
import { open, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

function messageParts(content, messageID) {
  if (typeof content === "string") return content ? [{ id: `${messageID}:text:0`, messageID, type: "text", text: content }] : []
  if (!Array.isArray(content)) return []
  return content.flatMap((item, index) => {
    if (item?.type === "text" && typeof item.text === "string" && item.text) return [{ id: `${messageID}:text:${index}`, messageID, type: "text", text: item.text }]
    if (item?.type === "thinking" && typeof item.thinking === "string" && item.thinking) return [{ id: `${messageID}:reasoning:${index}`, messageID, type: "reasoning", text: item.thinking }]
    if (item?.type === "image" && typeof item.data === "string" && item.data) {
      const mime = typeof item.mimeType === "string" && item.mimeType ? item.mimeType : "image/png"
      return [{ id: `${messageID}:file:${index}`, messageID, type: "file", mime, url: `data:${mime};base64,${item.data}` }]
    }
    return []
  })
}

async function sessionHeader(file) {
  let handle
  try {
    handle = await open(file, "r")
    const buffer = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const firstLine = buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/, 1)[0]
    return firstLine ? JSON.parse(firstLine) : undefined
  } catch { return undefined } finally { await handle?.close().catch(() => undefined) }
}

export function createPiHistoryLoader(sessionRoot = process.env.PI_CODING_AGENT_DIR ? path.join(process.env.PI_CODING_AGENT_DIR, "sessions") : path.join(homedir(), ".pi", "agent", "sessions")) {
  const sessionFiles = new Map()
  async function locateSession(sessionID) {
    const known = sessionFiles.get(sessionID)
    if (known) return known
    if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined
    try {
      const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
      const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => path.join(entry.parentPath ?? entry.path, entry.name))
      const suffix = `_${sessionID}.jsonl`
      const byName = files.find((file) => path.basename(file).endsWith(suffix))
      if (byName) { sessionFiles.set(sessionID, byName); return byName }
      for (const file of files) {
        const header = await sessionHeader(file)
        if (header?.type === "session" && header.id === sessionID) { sessionFiles.set(sessionID, file); return file }
      }
      return undefined
    } catch (error) {
      if (error?.code === "ENOENT") return undefined
      throw error
    }
  }
  return async function loadPiHistory(sessionID) {
    const file = await locateSession(sessionID)
    if (!file) return []
    const entries = new Map(); const order = []
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      let record
      try { record = JSON.parse(line) } catch { continue }
      if (typeof record?.id !== "string" || record.type === "session") continue
      entries.set(record.id, record); order.push(record.id)
    }
    const leafID = order.at(-1)
    if (!leafID) return []
    const branch = []; const visited = new Set(); let entry = entries.get(leafID)
    while (entry && !visited.has(entry.id)) { visited.add(entry.id); branch.push(entry); entry = typeof entry.parentId === "string" ? entries.get(entry.parentId) : undefined }
    branch.reverse()
    const messages = []
    for (const record of branch) {
      if (record.type !== "message") continue
      const role = record.message?.role
      if (role !== "user" && role !== "assistant") continue
      const messageID = record.id
      const parts = messageParts(record.message.content, messageID)
      if (parts.length === 0) continue
      const created = Date.parse(record.timestamp ?? "")
      messages.push({ info: { id: messageID, role, sessionID, time: { created: Number.isFinite(created) ? created : Date.now() } }, parts })
    }
    return messages
  }
}
