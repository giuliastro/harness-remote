import { createReadStream } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"

/**
 * Full-text search over the transcripts a harness has already written to disk.
 *
 * Searching by asking each harness to replay its Sessions is not an option: replay is a
 * single-writer operation on the live agent, so searching would contend for the lock that decides
 * who owns a Session, and one query over a few hundred Sessions would be hundreds of `session/load`
 * calls. Every harness this supports already keeps its own append-only JSONL journal, and that file
 * is readable without touching the agent at all - no ACP traffic, no writer contention, no risk of
 * disturbing a Session someone is using in their terminal.
 *
 * The formats differ (Claude Code, Codex rollouts, OMP and PI all nest their text differently), so
 * nothing here parses a format: a line is a candidate when its raw text contains the query, and only
 * then is it parsed, to pull out a role and a readable snippet. That is what a search result needs,
 * and it is why one implementation covers four harnesses.
 */

/** A journal listing is re-read at most this often; new Sessions appear as files under the root. */
const LISTING_TTL_MS = 15_000
/** Per Session, so one enormous transcript cannot hold up a whole query. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MATCHES_PER_SESSION = 3
const DEFAULT_TOTAL_HITS = 40
const SNIPPET_BEFORE = 70
const SNIPPET_AFTER = 160

/**
 * Keys whose values are machine identity rather than conversation. Without this, searching for a
 * project name matches every line of every journal through `cwd`, and searching for a model name
 * matches metadata instead of what was said.
 */
const NOISE_KEYS = new Set([
  "id", "uuid", "parentUuid", "sessionId", "sessionID", "session_id", "leafId", "parentId",
  "cwd", "directory", "path", "file", "filename", "gitBranch", "branch", "version", "type",
  "role", "model", "modelId", "provider", "mime", "mimeType", "timestamp", "time", "createdAt",
  "updatedAt", "requestId", "toolUseId", "tool_use_id", "callId", "call_id", "url", "data"
])
const ROLES = new Set(["user", "assistant", "system", "tool"])

/**
 * The speaker a format's own vocabulary names. Codex writes `user_message`, `agent_message` and
 * `agent_reasoning` as a record `type` and no `role` at all, so requiring the literal word would
 * leave every Codex result with no speaker.
 */
function roleFromToken(token) {
  if (typeof token !== "string") return undefined
  const lower = token.toLowerCase()
  if (ROLES.has(lower)) return lower
  if (lower.startsWith("user")) return "user"
  if (lower.startsWith("agent") || lower.startsWith("assistant")) return "assistant"
  if (lower.startsWith("system")) return "system"
  if (lower.startsWith("tool")) return "tool"
  return undefined
}
/** A long run with no whitespace is an encoded blob, not prose; matching inside one is a coincidence. */
const BLOB_LENGTH = 2_000

function looksLikeBlob(value) {
  return value.length > BLOB_LENGTH && !/\s/.test(value.slice(0, BLOB_LENGTH))
}

/** Every string in the record that could plausibly be something a person or an agent said. */
function collectProse(value, out, depth = 0) {
  if (out.length >= 40 || depth > 8) return out
  if (typeof value === "string") {
    if (value && !looksLikeBlob(value)) out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const item of value) collectProse(item, out, depth + 1)
    return out
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (NOISE_KEYS.has(key)) continue
      collectProse(item, out, depth + 1)
    }
  }
  return out
}

/** The nearest thing to a speaker in the record, wherever the format buried it. */
function roleOf(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return undefined
  const declared = roleFromToken(value.role) ?? roleFromToken(value.type)
  if (declared) return declared
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = roleOf(item, depth + 1)
    if (found) return found
  }
  return undefined
}

function timeOf(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 4) return undefined
  for (const key of ["timestamp", "time", "createdAt", "created_at"]) {
    const raw = value[key]
    if (typeof raw === "number" && Number.isFinite(raw)) return raw > 1e11 ? raw : raw * 1000
    if (typeof raw === "string") {
      const parsed = Date.parse(raw)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = timeOf(item, depth + 1)
    if (found) return found
  }
  return undefined
}

function snippetAround(text, needle) {
  const at = text.toLowerCase().indexOf(needle)
  if (at < 0) return null
  const start = Math.max(0, at - SNIPPET_BEFORE)
  const end = Math.min(text.length, at + needle.length + SNIPPET_AFTER)
  const body = text.slice(start, end).replace(/\s+/g, " ").trim()
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`
}

/**
 * The match as a result row: which line, who said it, and enough surrounding text to recognise it.
 *
 * Returns null when the query is only in the parts of the record that are not conversation - a
 * `cwd`, a branch name, a base64 image. That is what makes this the counting rule as well as the
 * display rule: a line that cannot produce a snippet is not a match, so searching for a project
 * name no longer reports every Session in that project with nothing to show.
 */
function matchFromLine(line, needle) {
  let record
  try {
    record = JSON.parse(line)
  } catch {
    // A journal is append-only and can end mid-write. The raw line is all there is to go on.
    const snippet = snippetAround(line, needle)
    return snippet ? { role: undefined, snippet, at: undefined } : null
  }
  for (const text of collectProse(record, [])) {
    const snippet = snippetAround(text, needle)
    if (snippet) return { role: roleOf(record), snippet, at: timeOf(record) }
  }
  return null
}

export function createTranscriptSearch({ root, listingTtlMs = LISTING_TTL_MS, now = Date.now } = {}) {
  let listing = []
  let listedAt = 0
  const files = new Map()

  async function refreshListing() {
    listedAt = now()
    if (!root) { listing = []; return }
    try {
      const entries = await readdir(root, { recursive: true, withFileTypes: true })
      listing = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
        .map((entry) => ({ name: entry.name, file: path.join(entry.parentPath ?? entry.path, entry.name) }))
    } catch {
      // A harness that was never run has no journal root. That is "nothing to search", not a fault.
      listing = []
    }
  }

  /**
   * Codex files a rollout as `rollout-<stamp>-<id>.jsonl`, OMP and PI as `<stamp>_<id>.jsonl`, and
   * Claude Code as `<id>.jsonl`. One suffix rule covers all three shapes, so a new harness with the
   * same habit needs no code here.
   */
  async function locate(sessionID) {
    const known = files.get(sessionID)
    if (known) return known
    if (!/^[A-Za-z0-9._-]+$/.test(sessionID)) return undefined
    const suffixes = [`${sessionID}.jsonl`, `-${sessionID}.jsonl`, `_${sessionID}.jsonl`]
    const find = () => listing.find((candidate) => suffixes.some((suffix) => candidate.name.endsWith(suffix)))?.file
    let file = find()
    if (!file && now() - listedAt >= listingTtlMs) {
      await refreshListing()
      file = find()
    }
    if (!file) return undefined
    files.set(sessionID, file)
    return file
  }

  async function searchSession(sessionID, needle, { matchesPerSession, maxBytes }) {
    const file = await locate(sessionID)
    if (!file) return { sessionID, searched: false, matches: [], count: 0 }
    const matches = []
    let count = 0
    let truncated = false
    try {
      const size = (await stat(file)).size
      // Reading the tail rather than the head: a transcript is searched for something recent far
      // more often than for its opening line, and a cap has to drop one end or the other.
      truncated = size > maxBytes
      const stream = createReadStream(file, { start: Math.max(0, size - maxBytes) })
      const lines = createInterface({ input: stream, crlfDelay: Infinity })
      // Starting at a byte offset lands mid-record, so the first line of a truncated read is a
      // fragment: it would parse as nothing and could still match on its raw text.
      let skipFragment = truncated
      for await (const line of lines) {
        if (skipFragment) { skipFragment = false; continue }
        if (!line || line.toLowerCase().indexOf(needle) < 0) continue
        const match = matchFromLine(line, needle)
        if (!match) continue
        count += 1
        if (matches.length < matchesPerSession) matches.push(match)
      }
      lines.close()
    } catch {
      return { sessionID, searched: false, matches: [], count: 0 }
    }
    return { sessionID, searched: true, matches, count, truncated }
  }

  return {
    locate,
    /**
     * @param sessionIDs ordered most-interesting-first; the caller decides what that means, and the
     *   bound is applied in that order so the result is the newest matches rather than an arbitrary
     *   slice of the disk.
     */
    async search(sessionIDs, query, options = {}) {
      const needle = String(query ?? "").trim().toLowerCase()
      if (needle.length < 2) return { query: needle, hits: [], scanned: 0, unsearched: [], truncated: false }
      const matchesPerSession = Math.max(1, Math.min(20, Number(options.matchesPerSession) || DEFAULT_MATCHES_PER_SESSION))
      const totalHits = Math.max(1, Math.min(200, Number(options.limit) || DEFAULT_TOTAL_HITS))
      const maxBytes = Math.max(64 * 1024, Number(options.maxBytesPerSession) || DEFAULT_MAX_BYTES)
      const maxSessions = Math.max(1, Math.min(1_000, Number(options.maxSessions) || 200))

      const hits = []
      const unsearched = []
      let scanned = 0
      let truncated = false
      for (const sessionID of sessionIDs.slice(0, maxSessions)) {
        if (hits.length >= totalHits) { truncated = true; break }
        const result = await searchSession(sessionID, needle, { matchesPerSession, maxBytes })
        if (!result.searched) { unsearched.push(sessionID); continue }
        scanned += 1
        if (result.truncated) truncated = true
        if (result.count) hits.push({ sessionID, count: result.count, matches: result.matches })
      }
      if (sessionIDs.length > maxSessions) truncated = true
      return { query: needle, hits, scanned, unsearched, truncated }
    }
  }
}
