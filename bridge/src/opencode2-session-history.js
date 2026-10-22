import { spawn } from "node:child_process"
import { ownChildProcess } from "./managed-child-process.js"

// OpenCode's standalone export streams the JSON to stdout and can exit 0 with a truncated document
// when several exports of the same Session overlap, which happens while the app polls a live turn.
// A truncated read is not a real history failure, so concurrent reads of one Session are coalesced
// and a failed export is retried a few times before it is surfaced as an error.
const EXPORT_ATTEMPTS = 3
const EXPORT_RETRY_BACKOFF_MS = 75
const MAX_EXPORT_BYTES = 64 * 1024 * 1024

function sleep(ms) {
  // This timer owns an awaited retry, so keep the process alive until it can finish the read.
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function partFromContent(part, messageID, index) {
  const base = { id: `${messageID}:part:${index}`, messageID, type: part.type }
  if (part.type === "text" || part.type === "reasoning") return {
    ...base, text: part.text ?? "",
    ...(part.time ? { time: { start: part.time.created, end: part.time.completed } } : {})
  }
  if (part.type === "tool") return {
    ...base, tool: part.name, callID: part.id,
    state: {
      ...part.state,
      output: part.state?.content?.filter((item) => item.type === "text").map((item) => item.text).join("\n"),
      ...(part.time ? { time: { start: part.time.ran ?? part.time.created, end: part.time.completed } } : {})
    }
  }
  if (part.type === "file") return { ...base, mime: part.mime, url: part.url, filename: part.filename }
  return undefined
}

/** OpenCode 2 exports native records, rather than the v1 info/parts envelopes. */
export function openCode2ExportMessages(sessionID, exported) {
  if (exported?.info?.id !== sessionID || !Array.isArray(exported.messages)) throw new Error("Invalid OpenCode 2 session export")
  return exported.messages.flatMap((message) => {
    if (message.type !== "user" && message.type !== "assistant") return []
    const info = {
      id: message.id, sessionID, role: message.type, time: message.time,
      ...(message.finish ? { finish: message.finish } : {}),
      ...(message.error ? { error: { ...message.error, name: message.error.type } } : {})
    }
    const content = message.type === "user"
      ? [{ type: "text", text: message.text }, ...(message.files ?? []).map((file) => ({ ...file, type: "file" }))]
      : message.content ?? []
    return [{ info, parts: content.map((part, index) => partFromContent(part, message.id, index)).filter(Boolean) }]
  })
}

/** Read history without opening the original project (which may have been removed). */
export function createOpenCode2HistoryLoader({ command = "opencode2", args = ["acp"], runExport } = {}) {
  const prefix = args.at(-1) === "acp" ? args.slice(0, -1) : []
  const readExport = runExport ?? ((sessionID) => new Promise((resolve, reject) => {
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
    // A private server exits with the export; history reads must not leave a background service
    // holding an isolated test database (or connect to a service with a different data root).
    const exportArgs = [...prefix, "session", "export", "--standalone", sessionID]
    const child = ownChildProcess(spawn(shim ? process.env.ComSpec ?? "cmd.exe" : command,
      shim ? ["/d", "/s", "/c", command, ...exportArgs] : exportArgs,
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }))
    let output = ""
    const timer = setTimeout(() => {
      child.kill()
      const error = new Error("OpenCode 2 history export timed out")
      error.nonRetryable = true
      reject(error)
    }, 30_000)
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      output += chunk
      if (Buffer.byteLength(output) > MAX_EXPORT_BYTES) {
        child.kill()
        const error = new Error("OpenCode 2 history export exceeds 64 MiB")
        error.nonRetryable = true
        reject(error)
      }
    })
    child.stderr.resume()
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(`OpenCode 2 history export failed (exit ${code})`))
      try { resolve(JSON.parse(output)) } catch { reject(new Error("OpenCode 2 returned an invalid history export")) }
    })
  }))
  const readExportOnce = async (sessionID) => {
    let lastError
    for (let attempt = 1; attempt <= EXPORT_ATTEMPTS; attempt += 1) {
      try {
        return await readExport(sessionID)
      } catch (error) {
        lastError = error
        if (attempt >= EXPORT_ATTEMPTS || error?.nonRetryable) break
        await sleep(EXPORT_RETRY_BACKOFF_MS * attempt)
      }
    }
    throw lastError
  }
  const inFlight = new Map()
  const read = async (sessionID) => {
    if (!/^[A-Za-z0-9_-]+$/.test(sessionID)) throw new Error("Invalid OpenCode 2 session id")
    // Share one export between callers that ask for the same Session at the same time. This is what
    // keeps a poll from launching overlapping exports, which is the condition that truncates them.
    const joined = inFlight.get(sessionID)
    if (joined) return joined
    const pending = readExportOnce(sessionID)
    inFlight.set(sessionID, pending)
    try {
      return await pending
    } finally {
      if (inFlight.get(sessionID) === pending) inFlight.delete(sessionID)
    }
  }
  const loader = async (sessionID) => openCode2ExportMessages(sessionID, await read(sessionID))
  loader.authoritativeHistory = true
  loader.journalOnly = true
  loader.page = async (sessionID, { limit = 100, before } = {}) => {
    const exported = await read(sessionID)
    const messages = openCode2ExportMessages(sessionID, exported)
    const end = before ? messages.findIndex((message) => message.info.id === before) : messages.length
    if (end < 0) throw new Error("Invalid OpenCode 2 history cursor")
    const start = Math.max(0, end - Math.max(1, Math.min(500, Number(limit) || 100)))
    const model = exported.info.model
    return {
      messages: messages.slice(start, end), before: start > 0 ? messages[start].info.id : null, hasMore: start > 0,
      ...(!before && model?.providerID && model?.id ? { model: { providerID: model.providerID, modelID: model.id, ...(model.variant ? { variant: model.variant } : {}) } } : {})
    }
  }
  return loader
}
