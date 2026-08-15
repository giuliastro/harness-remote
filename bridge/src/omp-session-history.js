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
    return []
  })
}

export function createOmpHistoryLoader(sessionRoot = path.join(homedir(), ".omp", "agent", "sessions")) {
  const sessionFiles = new Map()

  async function locateSession(sessionID) {
    const known = sessionFiles.get(sessionID)
    if (known) return known
    if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) return undefined
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

  return async function loadOmpHistory(sessionID, { activeSessionLeaf } = {}) {
    // JSONL is append-only: its final record may belong to an abandoned branch.
    // Without an authoritative selected leaf, ACP replay is safer than guessing.
    if (activeSessionLeaf === undefined) return []
    const file = await locateSession(sessionID)
    if (!file) return []
    const records = []
    const entries = new Map()
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (typeof record?.id === "string") {
        records.push(record)
        entries.set(record.id, record)
      }
    }

    const selected = []
    if (activeSessionLeaf === null) {
      // The extension selected the session root.
    } else if (entries.has(activeSessionLeaf)) {
      const branch = []
      const visited = new Set()
      let entry = entries.get(activeSessionLeaf)
      while (entry && !visited.has(entry.id)) {
        visited.add(entry.id)
        branch.push(entry)
        entry = typeof entry.parentId === "string" ? entries.get(entry.parentId) : undefined
      }
      selected.push(...branch.reverse())
    } else {
      throw new Error("OMP active session leaf is missing from transcript")
    }

    const messages = []
    for (const record of selected) {
      if (record.type !== "message") continue
      const role = record.message?.role
      if (role !== "user" && role !== "assistant") continue
      const messageID = record.id ?? `${sessionID}:${messages.length}`
      const parts = messageParts(record.message.content, messageID)
      if (parts.length === 0) continue
      const created = Date.parse(record.timestamp ?? "")
      messages.push({
        info: {
          id: messageID,
          role,
          sessionID,
          time: { created: Number.isFinite(created) ? created : Date.now() }
        },
        parts
      })
    }
    return messages
  }
}
