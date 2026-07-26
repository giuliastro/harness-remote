import { createReadStream } from "node:fs"
import { readdir } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

function messageText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text)
    .join("")
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

  return async function loadOmpHistory(sessionID) {
    const file = await locateSession(sessionID)
    if (!file) return []
    const messages = []
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (record?.type !== "message") continue
      const role = record.message?.role
      if (role !== "user" && role !== "assistant") continue
      const text = messageText(record.message.content)
      if (!text) continue
      const messageID = record.id ?? `${sessionID}:${messages.length}`
      const created = Date.parse(record.timestamp ?? "")
      messages.push({
        info: {
          id: messageID,
          role,
          sessionID,
          time: { created: Number.isFinite(created) ? created : Date.now() }
        },
        parts: [{ id: `${messageID}:text`, type: "text", text }]
      })
    }
    return messages
  }
}
