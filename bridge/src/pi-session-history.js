import { createReadStream } from "node:fs"
import { appendFile, readdir } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { homedir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline"

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

    const messages = []
    for (const record of branch) {
      if (record.type !== "message") continue
      const role = record.message?.role
      if (role !== "user" && role !== "assistant") continue
      const messageID = record.id
      const parts = messageParts(record.message?.content, messageID)
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
