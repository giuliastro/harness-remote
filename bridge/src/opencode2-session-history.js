import { spawn } from "node:child_process"
import { mkdtemp, open, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ownChildProcess } from "./managed-child-process.js"

// OpenCode's standalone export streams the JSON to stdout and can exit 0 with a truncated document
// when several exports of the same Session overlap, which happens while the app polls a live turn.
// A truncated read is not a real history failure, so concurrent reads of one Session are coalesced
// and a failed export is retried a few times before it is surfaced as an error.
const EXPORT_ATTEMPTS = 3
const EXPORT_RETRY_BACKOFF_MS = 75
const MAX_EXPORT_BYTES = 64 * 1024 * 1024
// Activity is collapsed in the transcript. A few visible exchanges can exceed the raw-message
// page size because one reply may contain hundreds of assistant steps. Keep a useful screenful of
// complete exchanges visible on first open rather than counting those hidden steps.
const MIN_PAGE_TURNS = 20
// The desktop transport caps one response at 8 MiB. Keep a whole conversation screen below that
// with room for headers and JSON overhead; a single turn larger than this is still returned whole.
const MAX_PAGE_BYTES = 4 * 1024 * 1024

function sleep(ms) {
  // This timer owns an awaited retry, so keep the process alive until it can finish the read.
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * OpenCode 2 exports a failed tool call's error as a structured envelope
 * (`{ type: "tool.execution", message: "..." }`), while the transcript contract every client
 * renders is a plain sentence. Passing the object through made the Activity row call `.split()` on
 * it, which the global error boundary escalated to a blank "could not start" screen. Normalize at
 * the boundary: a reader needs the message, not the provider's envelope.
 */
function toolErrorText(error) {
  if (typeof error === "string") return error
  if (error === null || error === undefined) return undefined
  if (error instanceof Error) return error.message
  if (Array.isArray(error)) return error.map(toolErrorText).filter(Boolean).join("\n") || undefined
  if (typeof error === "object") {
    const message = [error.message, error.data?.message, error.type, error.name]
      .find((value) => typeof value === "string" && value.trim())
    if (message) return message.trim()
    try { return JSON.stringify(error) } catch { return String(error) }
  }
  return String(error)
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
      error: toolErrorText(part.state?.error),
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
  const readExport = runExport ?? (async (sessionID) => {
    const directory = await mkdtemp(join(tmpdir(), "harness-remote-opencode2-export-"))
    const file = join(directory, "session.json")
    const output = await open(file, "w")
    const shim = process.platform === "win32" && /\.(cmd|bat)$/i.test(command)
    // A private server exits with the export; history reads must not leave a background service
    // holding an isolated test database (or connect to a service with a different data root).
    const exportArgs = [...prefix, "session", "export", "--standalone", sessionID]
    // OpenCode's exporter can exit 0 with a truncated document when stdout is a pipe: a large
    // Session loses its tail and cannot be parsed. Hand the child a real file descriptor instead,
    // where the same export is written completely, then read the finished file.
    const child = ownChildProcess(spawn(shim ? process.env.ComSpec ?? "cmd.exe" : command,
      shim ? ["/d", "/s", "/c", command, ...exportArgs] : exportArgs,
      { stdio: ["ignore", output.fd, "pipe"], windowsHide: true }))
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, 30_000)
    child.stderr.resume()
    try {
      const code = await new Promise((resolve, reject) => {
        child.once("error", reject)
        child.once("close", resolve)
      })
      if (timedOut) {
        const error = new Error("OpenCode 2 history export timed out")
        error.nonRetryable = true
        throw error
      }
      if (code !== 0) throw new Error(`OpenCode 2 history export failed (exit ${code})`)
      const metadata = await stat(file)
      if (metadata.size > MAX_EXPORT_BYTES) {
        const error = new Error("OpenCode 2 history export exceeds 64 MiB")
        error.nonRetryable = true
        throw error
      }
      const raw = await readFile(file, "utf8")
      try {
        return JSON.parse(raw)
      } catch {
        throw new Error("OpenCode 2 returned an invalid history export")
      }
    } finally {
      clearTimeout(timer)
      await output.close().catch(() => undefined)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  })
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
    const start = turnAlignedStart(messages, end, Math.max(1, Math.min(500, Number(limit) || 100)))
    // The transcript is built from user turns, so the cursor must name a prompt rather than an
    // assistant step inside one. Leading records before the first prompt cannot form a turn and are
    // deliberately left unreachable instead of keeping the history indicator alive forever.
    const hasEarlierTurn = start > 0 && messages.slice(0, start).some((message) => message.info.role === "user")
    const model = exported.info.model
    return {
      messages: messages.slice(start, end), before: hasEarlierTurn ? messages[start].info.id : null, hasMore: hasEarlierTurn,
      ...(!before && model?.providerID && model?.id ? { model: { providerID: model.providerID, modelID: model.id, ...(model.variant ? { variant: model.variant } : {}) } } : {})
    }
  }
  return loader
}

/**
 * OpenCode 2 writes one assistant envelope per model step, not one per turn: a single reply can be
 * hundreds of messages, while the transcript UI renders logical user turns. Slicing a page at
 * `end - limit` therefore often starts between two assistant steps, with the prompt that owns them
 * outside the page. The UI builds its timeline from user turns, so such a page looked empty until
 * the user paged backward by hand, and `hasMore` reported hidden activity instead of hidden
 * messages. Start at a user prompt instead. Keep at least twenty turns, since even a short
 * conversation can exceed the raw-message limit when replies have many collapsed model steps.
 * When the newest turn is longer than the limit, include that whole turn.
 */
function turnAlignedStart(messages, end, limit) {
  const candidate = Math.max(0, end - limit)
  let minimumTurnStart = end
  let turns = 0
  for (let index = end - 1; index >= 0 && turns < MIN_PAGE_TURNS; index -= 1) {
    if (messages[index].info.role !== "user") continue
    minimumTurnStart = index
    turns += 1
  }
  let start = candidate
  let aligned = false
  for (let index = candidate; index < end; index += 1) {
    if (messages[index].info.role === "user") {
      start = Math.min(index, minimumTurnStart)
      aligned = true
      break
    }
  }
  if (!aligned) {
    // No turn begins inside the limit, so the requested limit falls inside the newest turn. Keep
    // that turn whole instead of returning activity whose prompt is missing.
    for (let index = candidate - 1; index >= 0; index -= 1) {
      if (messages[index].info.role === "user") {
        start = Math.min(index, minimumTurnStart)
        break
      }
    }
  }
  return dropTurnsOverByteBudget(messages, start, end)
}

function dropTurnsOverByteBudget(messages, start, end) {
  let latestUser = -1
  for (let index = end - 1; index >= start; index -= 1) {
    if (messages[index].info.role === "user") {
      latestUser = index
      break
    }
  }
  // A page has to keep the newest prompt and its whole reply. If that turn alone is over budget the
  // transport has to carry it; dropping it would render activity with no visible question.
  if (latestUser < 0 || latestUser <= start) return start
  // Measure only the candidate page: serializing the whole history on every read would cost as much
  // as the oversized response this budget is there to avoid.
  const sizes = new Map()
  let pageBytes = 0
  for (let index = start; index < end; index += 1) {
    const size = Buffer.byteLength(JSON.stringify(messages[index])) + 1
    sizes.set(index, size)
    pageBytes += size
  }
  while (start < latestUser && pageBytes > MAX_PAGE_BYTES) {
    let next = start + 1
    while (next < latestUser && messages[next].info.role !== "user") next += 1
    for (let index = start; index < next; index += 1) pageBytes -= sizes.get(index)
    start = next
  }
  return start
}
