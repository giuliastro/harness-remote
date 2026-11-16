import { open, readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { scanLinesBackward } from "./backward-line-scan.js"
import { BoundedLru } from "./bounded-lru.js"

/**
 * Live status for Sessions this bridge is not driving.
 *
 * AcpService only knows about turns it started (or adopted), so a Session the user runs from a
 * terminal or desktop app always read idle. Each harness that leaves observable evidence of an
 * in-flight turn gets a probe here. Probes report evidence only: `undefined` means "no evidence",
 * never "idle", and a bridge-owned busy status always wins over them (see overlayLiveStatus).
 */

/** A rollout untouched for this long cannot be mid-turn: Codex appends while working. */
export const CODEX_ROLLOUT_STALE_MS = 15 * 60_000
/** A Claude Code transcript untouched for this long cannot be mid-turn. */
export const CLAUDE_TRANSCRIPT_STALE_MS = 20 * 60_000
/** Codex turn markers are small and frequent; never scan further back than this per rollout. */
const CODEX_TAIL_LOOKBACK_BYTES = 2 * 1024 * 1024
const CLAUDE_TAIL_LOOKBACK_BYTES = 2 * 1024 * 1024
const CODEX_TURN_EVENTS = new Set(["task_started", "task_complete", "turn_aborted"])
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/
const PROBE_CONCURRENCY = 16

export function isSafeSessionFileName(sessionID) {
  return typeof sessionID === "string" && SAFE_SESSION_ID.test(sessionID)
}

export function defaultClaudeProjectsRoot(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "projects")
}

export function defaultClaudeSessionRegistryDir(env = process.env) {
  return path.join(env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude"), "sessions")
}

export function defaultCodexSessionRoot(env = process.env) {
  return path.join(env.CODEX_HOME || path.join(homedir(), ".codex"), "sessions")
}

function statusType(status) {
  return typeof status === "string" ? status : status?.type
}

/**
 * Bridge-owned busy wins: the bridge's own turn is the most direct evidence there is, and it also
 * guards queueing. External evidence only upgrades a Session the bridge itself reports as idle.
 */
export function overlayLiveStatus(bridgeStatus, evidence) {
  if (statusType(bridgeStatus) === "busy") return bridgeStatus
  if (evidence && (evidence.type === "busy" || evidence.type === "attention" || evidence.type === "listening")) return evidence
  return bridgeStatus
}

function codexTurnEvent(line) {
  // Cheap pre-filter: most rollout lines are large response items that cannot be turn markers.
  if (!line.includes("task_started") && !line.includes("task_complete") && !line.includes("turn_aborted")) return undefined
  try {
    const record = JSON.parse(line.toString("utf8").replace(/\r$/, ""))
    const type = record?.type === "event_msg" ? record.payload?.type : undefined
    return CODEX_TURN_EVENTS.has(type) ? type : undefined
  } catch {
    // A line being appended right now is legitimately partial.
    return undefined
  }
}

/**
 * The `timestamp` both harnesses put on their journal records, read from the head of the line so a
 * large record is never parsed just for it.
 */
function recordTimestamp(line) {
  const head = (line.subarray ? line.subarray(0, 512) : line.slice(0, 512)).toString("utf8")
  const match = /"timestamp"\s*:\s*"([^"]+)"/.exec(head)
  const at = match ? Date.parse(match[1]) : NaN
  return Number.isFinite(at) ? at : 0
}

/**
 * When the journal was last written. The file's mtime alone is not enough: on Windows it is not
 * updated while the writer keeps the file open, and Codex keeps a thread's rollout open for as long
 * as the thread is loaded, so its mtime can be a day old under a turn that started a second ago.
 */
function lastWrittenAt(info, newestRecordAt) {
  return Math.max(info.mtimeMs, newestRecordAt)
}

/**
 * Derive the turn state from the newest Codex turn marker in a rollout tail.
 * Returns `{ state: "working" | "idle", event, lastActivityAt, mtimeMs, size }`. A dangling
 * task_started counts as working only while the rollout is still being written (see isLiveWorking).
 */
export async function readCodexRolloutTurnState(file, {
  now = Date.now(),
  staleMs = CODEX_ROLLOUT_STALE_MS,
  lookbackBytes = CODEX_TAIL_LOOKBACK_BYTES,
  fileStat
} = {}) {
  const info = fileStat ?? await stat(file)
  const handle = await open(file, "r")
  let newestRecordAt = 0
  const result = (state, event) => {
    const lastActivityAt = lastWrittenAt(info, newestRecordAt)
    return { mtimeMs: info.mtimeMs, size: info.size, lastActivityAt, event, state: isLiveWorking(state, lastActivityAt, now, staleMs) ? "working" : "idle", turnState: state }
  }
  try {
    const floor = Math.max(0, info.size - lookbackBytes)
    for await (const { line, offset } of scanLinesBackward(handle, { from: info.size })) {
      if (offset < floor) break
      if (!newestRecordAt) newestRecordAt = recordTimestamp(line)
      const event = codexTurnEvent(line)
      if (event) return result(event === "task_started" ? "working" : "idle", event)
    }
    return result("idle", undefined)
  } finally {
    await handle.close()
  }
}

/**
 * Crash guard: a turn left open in a journal nobody has written to recently is a process that died
 * mid-turn, not a turn that is still running.
 */
function isLiveWorking(turnState, lastActivityAt, now, staleMs) {
  return turnState === "working" && now - lastActivityAt <= staleMs
}

/**
 * Shared journal probe: session id -> file index plus a per-file turn-state cache.
 *
 * Locations come from `scan(locations)`, run once and then again only on a miss, at most every
 * `rescanIntervalMs`. Each probe then costs one stat, plus a bounded tail read only when the file
 * changed since the cached result. The mtime cannot rule a file out before reading it (see
 * lastWrittenAt), so staleness is judged from the cached last activity on every probe instead.
 */
function createJournalTurnProbe({ scan, readState, staleMs, rescanIntervalMs = 30_000, maxEntries = 4096, now = () => Date.now() }) {
  // Sized above any realistic journal count: once ids outnumber it, misses force a full rescan
  // (still at most once per rescanIntervalMs). Each entry is one id and one path.
  const locations = new BoundedLru({ maxEntries: 32_768 })
  const results = new BoundedLru({ maxEntries })
  let lastScanAt = -Infinity
  let scanning

  async function locate(sessionID) {
    const known = locations.get(sessionID)
    if (known) return known
    if (now() - lastScanAt >= rescanIntervalMs) {
      lastScanAt = now()
      scanning ??= scan(locations).catch(() => {}).finally(() => { scanning = undefined })
    }
    if (scanning) await scanning
    return locations.get(sessionID)
  }

  async function journalLiveStatus(sessionID) {
    if (!isSafeSessionFileName(sessionID)) return undefined
    const file = await locate(sessionID)
    if (!file) return undefined
    let info
    try {
      info = await stat(file)
    } catch {
      locations.delete(sessionID)
      results.delete(sessionID)
      return undefined
    }
    const at = now()
    let cached = results.get(sessionID)
    if (!cached || cached.file !== file || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
      const parsed = await readState(file, { now: at, staleMs, fileStat: info })
      cached = { file, mtimeMs: parsed.mtimeMs, size: parsed.size, turnState: parsed.turnState, lastActivityAt: parsed.lastActivityAt }
      results.set(sessionID, cached)
    }
    return isLiveWorking(cached.turnState, cached.lastActivityAt, at, staleMs) ? { type: "busy", source: "journal" } : undefined
  }
  // The same index serves other readers of these journals (see createClaudeBackgroundWorkReader).
  journalLiveStatus.locate = async (sessionID) => isSafeSessionFileName(sessionID) ? locate(sessionID) : undefined
  return journalLiveStatus
}

/**
 * Probe Codex rollouts (`sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl`). The rollout lives in the
 * folder of the day the thread started, however recently it was resumed.
 *
 * Codex 0.16x also projects turns into `thread_history_<n>.sqlite`, but that projection was seen
 * landing about a minute after the turn had ended, so it cannot say that a turn is running.
 */
export function createCodexLiveStatusProbe({
  sessionRoot = defaultCodexSessionRoot(),
  staleMs = CODEX_ROLLOUT_STALE_MS,
  ...options
} = {}) {
  return createJournalTurnProbe({
    ...options,
    staleMs,
    readState: readCodexRolloutTurnState,
    async scan(locations) {
      const entries = await readdir(sessionRoot, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        const match = entry.isFile() ? /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-([A-Za-z0-9_-]+)\.jsonl$/.exec(entry.name) : null
        if (match) locations.set(match[1], path.join(entry.parentPath ?? entry.path, entry.name))
      }
    }
  })
}

const CLAUDE_END_STOP_REASONS = new Set(["end_turn", "stop_sequence", "max_tokens", "refusal"])
const CLAUDE_TURN_END_SUBTYPES = new Set(["stop_hook_summary", "turn_duration"])
const CLAUDE_INTERRUPT_MARKER = "[Request interrupted by user"

function claudeUserText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => typeof part?.text === "string" ? part.text : "").join("\n")
}

/**
 * Classify one Claude Code transcript record: "working", "idle", or undefined when the record does
 * not decide the main thread's turn state (sidechain/meta records, attachments, other system notes).
 */
export function claudeTranscriptRecordState(record) {
  if (!record || typeof record !== "object") return undefined
  if (record.isSidechain === true || record.isMeta === true) return undefined
  if (record.type === "system") return CLAUDE_TURN_END_SUBTYPES.has(record.subtype) ? "idle" : undefined
  if (record.type === "assistant") {
    const reason = record.message?.stop_reason
    if (reason === null || reason === undefined || reason === "tool_use") return "working"
    return CLAUDE_END_STOP_REASONS.has(reason) ? "idle" : undefined
  }
  if (record.type === "user") {
    return claudeUserText(record.message?.content).includes(CLAUDE_INTERRUPT_MARKER) ? "idle" : "working"
  }
  return undefined
}

/**
 * Derive the turn state from the newest decisive record in a Claude Code transcript tail.
 * Returns `{ state: "working" | "idle", decidedBy, lastActivityAt, mtimeMs, size }`; a transcript
 * nobody has written to recently is a finished or crashed turn, never a running one.
 */
export async function readClaudeTranscriptTurnState(file, {
  now = Date.now(),
  staleMs = CLAUDE_TRANSCRIPT_STALE_MS,
  lookbackBytes = CLAUDE_TAIL_LOOKBACK_BYTES,
  fileStat
} = {}) {
  const info = fileStat ?? await stat(file)
  const handle = await open(file, "r")
  let newestRecordAt = 0
  const result = (state, decidedBy) => {
    const lastActivityAt = lastWrittenAt(info, newestRecordAt)
    return { mtimeMs: info.mtimeMs, size: info.size, lastActivityAt, decidedBy, state: isLiveWorking(state, lastActivityAt, now, staleMs) ? "working" : "idle", turnState: state }
  }
  try {
    const floor = Math.max(0, info.size - lookbackBytes)
    for await (const { line, offset } of scanLinesBackward(handle, { from: info.size })) {
      if (offset < floor) break
      if (!newestRecordAt) newestRecordAt = recordTimestamp(line)
      let record
      try {
        record = JSON.parse(line.toString("utf8").replace(/\r$/, ""))
      } catch {
        continue
      }
      const state = claudeTranscriptRecordState(record)
      if (state) {
        const decidedBy = record.type === "system" ? `system:${record.subtype}`
          : record.type === "assistant" ? `assistant:${record.message?.stop_reason ?? "streaming"}`
            : "user"
        return result(state, decidedBy)
      }
    }
    return result("idle", undefined)
  } finally {
    await handle.close()
  }
}

/**
 * Probe Claude Code transcripts (`projects/<encoded-cwd>/<session_id>.jsonl`). The cwd encoding is
 * not relied upon: one readdir of `projects/` and of each project directory builds the index.
 * Subagent transcripts live one level deeper and are deliberately not indexed.
 */
export function createClaudeTranscriptStatusProbe({
  projectsRoot = defaultClaudeProjectsRoot(),
  staleMs = CLAUDE_TRANSCRIPT_STALE_MS,
  ...options
} = {}) {
  return createJournalTurnProbe({
    ...options,
    staleMs,
    readState: readClaudeTranscriptTurnState,
    async scan(locations) {
      const projects = await readdir(projectsRoot, { withFileTypes: true })
      const directories = projects.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      let next = 0
      const worker = async () => {
        while (next < directories.length) {
          const directory = path.join(projectsRoot, directories[next++].name)
          let entries
          try {
            entries = await readdir(directory, { withFileTypes: true })
          } catch {
            continue
          }
          for (const entry of entries) {
            const match = entry.isFile() ? /^([A-Za-z0-9_-]{1,128})\.jsonl$/.exec(entry.name) : null
            if (match) locations.set(match[1], path.join(directory, entry.name))
          }
        }
      }
      await Promise.all(Array.from({ length: Math.min(PROBE_CONCURRENCY, directories.length) }, worker))
    }
  })
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === "EPERM"
  }
}

/**
 * Read Claude Code's process registry: one `<pid>.json` per running Claude Code process, carrying its
 * `sessionId` and its own `status` ("busy" while a turn runs, "idle" otherwise). Entries whose process
 * is gone are ignored, since a crash leaves its file behind. Several processes can hold one Session
 * (the desktop app and an ACP adapter that loaded it); any busy one makes it busy.
 *
 * Returns `Map<sessionId, "busy" | "idle">`, or undefined when there is no registry (older Claude Code).
 */
export async function readClaudeSessionRegistry(registryDir, { isAlive = processIsAlive } = {}) {
  let names
  try {
    names = await readdir(registryDir)
  } catch {
    return undefined
  }
  const sessions = new Map()
  // The working directory each live Session runs in. It names the Session's transcript folder, so a
  // Session started a moment ago can be found before the next full index scan (see claudeJournalPath).
  const cwds = new Map()
  Object.defineProperty(sessions, "cwds", { value: cwds })
  await Promise.all(names.filter((name) => /^\d+\.json$/.test(name)).map(async (name) => {
    let entry
    try {
      entry = JSON.parse(await readFile(path.join(registryDir, name), "utf8"))
    } catch {
      // Being rewritten right now, or not ours to understand.
      return
    }
    if (!isSafeSessionFileName(entry?.sessionId) || !isAlive(entry.pid)) return
    const status = entry.status === "busy" ? "busy" : "idle"
    if (sessions.get(entry.sessionId) !== "busy") sessions.set(entry.sessionId, status)
    if (typeof entry.cwd === "string" && entry.cwd) cwds.set(entry.sessionId, entry.cwd)
  }))
  return sessions
}

/**
 * Claude Code live status. The process registry is authoritative where it exists: it reports the turn
 * state Claude Code itself holds, and a Session with no live process is not running. The transcript
 * tail is only a fallback for Claude Code builds without a registry, because it cannot tell a turn
 * in flight from records written by a process that then stopped (a resume appends a task
 * notification for orphaned shells, for example, and no turn follows it).
 */
function createClaudeRegistryReader({
  registryDir = defaultClaudeSessionRegistryDir(),
  registryTtlMs = 2_000,
  isAlive,
  now = () => Date.now()
} = {}) {
  let registry
  let readAt = -Infinity
  let reading

  return async function currentRegistry() {
    if (now() - readAt < registryTtlMs) return registry
    reading ??= readClaudeSessionRegistry(registryDir, { isAlive })
      .then((sessions) => {
        registry = sessions
        readAt = now()
        return sessions
      })
      .finally(() => { reading = undefined })
    return reading
  }
}

/** Background work older than this is not waited on: Claude caps a background shell at two hours. */
export const CLAUDE_BACKGROUND_WORK_MAX_AGE_MS = 6 * 60 * 60_000
const CLAUDE_BACKGROUND_LOOKBACK_BYTES = 8 * 1024 * 1024
const TASK_NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g
const TASK_RUNNING_STATUSES = new Set(["running", "started", "in_progress", "pending"])

function stringContent(content) {
  if (typeof content === "string") return [content]
  if (!Array.isArray(content)) return []
  return content.flatMap((part) => typeof part?.text === "string" ? [part.text]
    : typeof part?.content === "string" ? [part.content]
      : [])
}

/** Tool-use ids whose background work has ended, from the task notifications in one record. */
function finishedBackgroundWork(record) {
  const texts = record?.type === "queue-operation"
    ? [typeof record.content === "string" ? record.content : ""]
    : record?.type === "user" ? stringContent(record.message?.content) : []
  const finished = []
  for (const text of texts) {
    if (!text.includes("<task-notification>")) continue
    for (const [, body] of text.matchAll(TASK_NOTIFICATION)) {
      const toolUseID = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1]?.trim()
      const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim().toLowerCase()
      if (toolUseID && !TASK_RUNNING_STATUSES.has(status)) finished.push(toolUseID)
    }
  }
  return finished
}

/**
 * Count the background work a Claude Code Session started and has not heard back from: tool calls
 * made with `run_in_background` (shells, subagents) whose task notification has not arrived yet.
 *
 * Claude Code ends the turn that starts such work and wakes the Session with a new turn when the
 * work finishes. In between, its process reports idle, so without this the Session read as finished
 * while it was in fact waiting to report back. A call whose tool result was an error never started;
 * a resume after a crash journals a notification for every orphaned shell, which closes it here too.
 */
export async function readClaudeBackgroundWork(file, {
  now = Date.now(),
  maxAgeMs = CLAUDE_BACKGROUND_WORK_MAX_AGE_MS,
  lookbackBytes = CLAUDE_BACKGROUND_LOOKBACK_BYTES,
  fileStat
} = {}) {
  const info = fileStat ?? await stat(file)
  const handle = await open(file, "r")
  const closed = new Set()
  const pending = []
  try {
    const floor = Math.max(0, info.size - lookbackBytes)
    for await (const { line, offset } of scanLinesBackward(handle, { from: info.size })) {
      if (offset < floor) break
      const text = line.toString("utf8")
      // Cheap pre-filter: only these records can open or close background work.
      if (!text.includes("run_in_background") && !text.includes("task-notification") && !text.includes("\"is_error\":true")) continue
      let record
      try {
        record = JSON.parse(text.replace(/\r$/, ""))
      } catch {
        continue
      }
      if (record?.isSidechain === true) continue
      for (const toolUseID of finishedBackgroundWork(record)) closed.add(toolUseID)
      const content = Array.isArray(record?.message?.content) ? record.message.content : []
      if (record?.type === "user") {
        for (const part of content) {
          if (part?.type === "tool_result" && part.is_error === true && typeof part.tool_use_id === "string") closed.add(part.tool_use_id)
        }
      }
      if (record?.type === "assistant") {
        const startedAt = Date.parse(record.timestamp ?? "")
        if (Number.isFinite(startedAt) && now - startedAt > maxAgeMs) break
        for (const part of content) {
          if (part?.type === "tool_use" && part.input?.run_in_background === true && typeof part.id === "string" && !closed.has(part.id)) {
            pending.push({ toolUseID: part.id, tool: part.name, startedAt: Number.isFinite(startedAt) ? startedAt : undefined })
          }
        }
      }
    }
  } finally {
    await handle.close()
  }
  return { mtimeMs: info.mtimeMs, size: info.size, pending }
}

/** Per-Session reader for readClaudeBackgroundWork that only rereads a journal after it changed. */
export function createClaudeBackgroundWorkReader({ locate, now = () => Date.now(), maxEntries = 4096 } = {}) {
  const results = new BoundedLru({ maxEntries })
  return async function backgroundWork(sessionID, cwd) {
    if (typeof locate !== "function" || !isSafeSessionFileName(sessionID)) return 0
    const file = await locate(sessionID, cwd)
    if (!file) return 0
    let info
    try {
      info = await stat(file)
    } catch {
      results.delete(sessionID)
      return 0
    }
    const at = now()
    let cached = results.get(sessionID)
    if (!cached || cached.file !== file || cached.mtimeMs !== info.mtimeMs || cached.size !== info.size) {
      const parsed = await readClaudeBackgroundWork(file, { now: at, fileStat: info })
      cached = { file, mtimeMs: parsed.mtimeMs, size: parsed.size, pending: parsed.pending }
      results.set(sessionID, cached)
    }
    return cached.pending.filter((work) => !work.startedAt || at - work.startedAt <= CLAUDE_BACKGROUND_WORK_MAX_AGE_MS).length
  }
}

/**
 * Claude Code keeps a Session's transcript at `projects/<cwd with every non-alphanumeric character
 * replaced by "-">/<id>.jsonl`. The full index scan is throttled, so a Session that started after
 * the last scan was invisible for up to its interval: a turn that started background work read idle
 * for those seconds, long enough to post a premature Ready. Try the direct path first, then the index.
 */
export function claudeJournalPath(projectsRoot, cwd, sessionID) {
  if (typeof cwd !== "string" || !cwd || !isSafeSessionFileName(sessionID)) return undefined
  return path.join(projectsRoot, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionID}.jsonl`)
}

function claudeJournalLocator(projectsRoot, transcript) {
  return async (sessionID, cwd) => {
    const direct = claudeJournalPath(projectsRoot, cwd, sessionID)
    if (direct) {
      try {
        if ((await stat(direct)).isFile()) return direct
      } catch {
        // Not there (a long cwd is shortened differently); the index finds it.
      }
    }
    return transcript.locate(sessionID)
  }
}

export function createClaudeLiveStatusProbe({
  registryDir = defaultClaudeSessionRegistryDir(),
  registryTtlMs = 2_000,
  isAlive,
  now = () => Date.now(),
  ...options
} = {}) {
  const transcript = createClaudeTranscriptStatusProbe({ ...options, now })
  const currentRegistry = createClaudeRegistryReader({ registryDir, registryTtlMs, isAlive, now })
  const projectsRoot = options.projectsRoot ?? defaultClaudeProjectsRoot()
  const backgroundWork = createClaudeBackgroundWorkReader({ locate: claudeJournalLocator(projectsRoot, transcript), now })

  return async function claudeLiveStatus(sessionID) {
    if (!isSafeSessionFileName(sessionID)) return undefined
    const sessions = await currentRegistry()
    if (sessions) {
      const state = sessions.get(sessionID)
      if (state === "busy") return { type: "busy", source: "claude-session-registry" }
      // Idle but still running: the process that would report back is alive and waiting on work.
      if (state === "idle") {
        const background = await backgroundWork(sessionID, sessions.cwds?.get(sessionID))
        if (background > 0) return { type: "listening", background, source: "claude-journal" }
      }
      return undefined
    }
    return transcript(sessionID)
  }
}

/**
 * Whether Claude Code itself reports one Session as idle and still loaded.
 *
 * An idle unload must not rely on the bridge's own turn bookkeeping: a background shell, subagent or
 * monitor can outlive the turn that started it, and closing the adapter Session then kills work the
 * user meant to keep. Claude's process registry is the harness's own statement about that Session,
 * so only an explicit live `idle` entry permits the close. A missing registry (older Claude builds)
 * or a Session with no live process entry leaves the Session alone; unloading is an optimization,
 * never a reason to guess.
 */
export function createClaudeSessionIdleGuard({
  registryDir = defaultClaudeSessionRegistryDir(),
  registryTtlMs = 2_000,
  isAlive,
  now = () => Date.now(),
  projectsRoot
} = {}) {
  const currentRegistry = createClaudeRegistryReader({ registryDir, registryTtlMs, isAlive, now })
  // Claude's registry reads idle while background work it started is still running, and closing the
  // Session then kills that work. The journal says whether any is still due to report back.
  const root = projectsRoot ?? defaultClaudeProjectsRoot()
  const transcript = createClaudeTranscriptStatusProbe({ now, projectsRoot: root })
  const backgroundWork = createClaudeBackgroundWorkReader({ locate: claudeJournalLocator(root, transcript), now })
  return async function claudeSessionIsIdle(sessionID) {
    if (!isSafeSessionFileName(sessionID)) return false
    const sessions = await currentRegistry()
    if (sessions?.get(sessionID) !== "idle") return false
    return (await backgroundWork(sessionID, sessions.cwds?.get(sessionID)).catch(() => 1)) === 0
  }
}

/** Build the probe a harness profile declares (`liveStatusSource`), or undefined. */
export function createLiveStatusProbe(source, options = {}) {
  if (source === "codex-journal") return createCodexLiveStatusProbe(options)
  if (source === "claude-journal") return createClaudeLiveStatusProbe(options)
  return undefined
}

/**
 * Probe many Sessions with bounded concurrency. A broken file or probe error only drops that one
 * Session's evidence; it never fails the listing.
 */
export async function probeLiveStatuses(probe, sessionIDs, { concurrency = PROBE_CONCURRENCY } = {}) {
  const evidence = new Map()
  if (typeof probe !== "function") return evidence
  const queue = [...new Set(sessionIDs)].filter(isSafeSessionFileName)
  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const sessionID = queue[next++]
      try {
        const found = await probe(sessionID)
        if (found) evidence.set(sessionID, found)
      } catch {
        // Per-Session failure is "no evidence".
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
  return evidence
}
