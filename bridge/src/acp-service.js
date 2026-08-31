import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { TranscriptCache } from "./transcript-cache.js"
import {
  listExtensionActions,
  loadExtensionActionState,
  resetExtensionActionState,
  resolveExtensionAction
} from "./extension-actions.js"

function toEpoch(value) {
  const epoch = Date.parse(value ?? "")
  return Number.isFinite(epoch) ? epoch : Date.now()
}

/** ACP agents report native paths; the app may send them in either separator form. */
export function sameDirectory(left, right) {
  if (!left || !right) return false
  const normalize = (value) => {
    const resolved = path.resolve(value).replace(/[\\/]+$/, "")
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
  }
  return normalize(left) === normalize(right)
}
function sessionView(session, status = "idle", title = session.title, external = false) {
  return {
    id: session.sessionId,
    title: title || `Session ${session.sessionId.slice(0, 8)}`,
    directory: session.cwd,
    time: { created: toEpoch(session.updatedAt), updated: toEpoch(session.updatedAt) },
    summary: { additions: 0, deletions: 0, files: 0 },
    model: undefined,
    status,
    ...(external ? { external: true } : {})
  }
}

/**
 * Older PI snapshots contain one UUID-identified assistant envelope per streamed fragment. A user
 * turn is the natural delimiter, so those adjacent envelopes are one visible reply. Keeping them
 * separate breaks Markdown whenever a marker or word straddles two updates.
 */
function mergeFragmentedPiSnapshot(messages) {
  const merged = []
  for (const message of messages) {
    const previous = merged.at(-1)
    if (
      message?.info?.role === "assistant"
      && previous?.info?.role === "assistant"
      && !message.info?.error
      && !previous.info?.error
      && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(message.info.id)
      && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(previous.info.id)
    ) {
      for (const part of message.parts ?? []) {
        const lastPart = previous.parts.at(-1)
        if (lastPart?.type === part?.type && typeof lastPart.text === "string" && typeof part.text === "string") {
          lastPart.text += part.text
        } else {
          previous.parts.push(part)
        }
      }
      continue
    }
    merged.push(message)
  }
  return merged
}

function visibleMessageText(message) {
  return (message?.parts ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part?.text ?? "")
    .join("")
}

function messageSignature(message) {
  // OMP's live ACP reply can include reasoning/tool metadata that its persisted replay omits.
  // Visible text + terminal error is the stable identity across those two representations.
  const error = message?.info?.error?.message ? `\u0000${message.info.error.message}` : ""
  return `${message?.info?.role ?? ""}\u0000${visibleMessageText(message)}${error}`
}

function isConsecutiveAssistantDuplicate(previous, next) {
  if (previous?.info?.role !== "assistant" || next?.info?.role !== "assistant") return false
  if (messageSignature(previous) !== messageSignature(next)) return false
  // HR3 can legitimately split reasoning/tool activity into adjacent assistant envelopes with no
  // visible text. Never collapse those; only heal duplicate visible replies or duplicate failures.
  return Boolean(
    visibleMessageText(previous)
    || previous?.info?.error?.message
    || next?.info?.error?.message
  )
}

function healPoisonedSnapshot(messages) {
  if (!Array.isArray(messages) || messages.length < 2) return messages
  const healed = []
  for (const message of messages) {
    const previous = healed.at(-1)
    if (previous && isConsecutiveAssistantDuplicate(previous, message)) continue
    healed.push(message)
  }
  return healed.length === messages.length ? messages : healed
}

// A complete LCS table is useful for the small, genuinely divergent replays it was written for,
// but it consumes one Uint32 cell per pair of messages.  Large restored snapshots therefore used
// to monopolise Node's only event loop while session/load replayed the same journal.  Keep the
// exact merge inside a bounded 1 MB working set; beyond it the timestamp-aware external merge is
// linear in the transcript size (apart from its final ordering pass).
const REPLAY_LCS_CELL_LIMIT = 250_000
function stableSemanticValue(value) {
  if (Array.isArray(value)) return value.map(stableSemanticValue)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSemanticValue(value[key])]))
}

function semanticMessagePart(part) {
  if (!part || typeof part !== "object") return part
  const semantic = {}
  for (const key of Object.keys(part).sort()) {
    if (["id", "messageID", "sessionID", "callID", "time"].includes(key)) continue
    if (key === "state" && part.state && typeof part.state === "object") {
      const { time: _time, ...state } = part.state
      semantic.state = stableSemanticValue(state)
      continue
    }
    semantic[key] = stableSemanticValue(part[key])
  }
  return semantic
}

/**
 * A turn that failed carries its reason on the envelope rather than in a part, and two failures are
 * two different messages even when both have nothing to show. Leaving the reason out of the identity
 * let one be deduplicated away against the other, and let a newly recorded failure pass for no
 * change at all.
 */
function semanticMessageIdentity(message) {
  return {
    role: message?.info?.role,
    ...(message?.info?.error?.message ? { error: message.info.error.message } : {}),
    parts: (message?.parts ?? []).map(semanticMessagePart)
  }
}

function semanticMessageSignature(message) {
  return JSON.stringify(semanticMessageIdentity(message))
}

function semanticHistorySignature(messages) {
  return JSON.stringify(messages.map(semanticMessageIdentity))
}

/**
 * A PI provider failure is first known by the live ACP request and can reach the journal a little
 * later. Match the bridge's temporary failure to the persisted turn by its preceding user prompt,
 * not by message id: PI's ACP stream and JSONL journal legitimately use different identities.
 */
function persistedFailureForTransientTurn(persisted, cached, failureID) {
  const failureIndex = cached.findIndex((message) => message?.info?.id === failureID)
  if (failureIndex < 0) return true

  let userIndex = failureIndex - 1
  while (userIndex >= 0 && cached[userIndex]?.info?.role !== "user") userIndex -= 1
  if (userIndex < 0) return false

  const userSignature = semanticMessageSignature(cached[userIndex])
  const userCreated = Number(cached[userIndex]?.info?.time?.created) || 0
  let persistedUserIndex = -1
  let closestDistance = Number.POSITIVE_INFINITY
  for (let index = 0; index < persisted.length; index += 1) {
    const candidate = persisted[index]
    if (candidate?.info?.role !== "user" || semanticMessageSignature(candidate) !== userSignature) continue
    const candidateCreated = Number(candidate?.info?.time?.created) || 0
    const distance = userCreated && candidateCreated ? Math.abs(candidateCreated - userCreated) : 0
    if (distance <= closestDistance) {
      closestDistance = distance
      persistedUserIndex = index
    }
  }
  if (persistedUserIndex < 0) return false

  for (let index = persistedUserIndex + 1; index < persisted.length; index += 1) {
    const candidate = persisted[index]
    if (candidate?.info?.role === "user") break
    if (candidate?.info?.role === "assistant" && candidate.info?.error?.message) return true
  }
  return false
}

/** Keep exactly the temporary failed turn visible while PI's authoritative journal catches up. */
function transientFailureTurnMessages(cached, failureIDs) {
  if (!failureIDs?.size) return []
  const indexes = new Set()
  for (let failureIndex = 0; failureIndex < cached.length; failureIndex += 1) {
    if (!failureIDs.has(cached[failureIndex]?.info?.id)) continue
    let start = failureIndex
    while (start > 0 && cached[start - 1]?.info?.role !== "user") start -= 1
    if (start > 0 && cached[start - 1]?.info?.role === "user") start -= 1
    for (let index = start; index <= failureIndex; index += 1) indexes.add(index)
  }
  return cached.filter((_message, index) => indexes.has(index))
}

/** Exported for testing only. */
export function mergeReplay(previous, replayed) {
  // Heal snapshots already poisoned by the old live-vs-replay identity mismatch.
  previous = healPoisonedSnapshot(previous)
  replayed = healPoisonedSnapshot(replayed)
  if (previous.length === 0) return replayed
  if (replayed.length === 0) return previous
  const left = previous.map(messageSignature)
  const right = replayed.map(messageSignature)

  let prefix = 0
  const maxPrefix = Math.min(previous.length, replayed.length)
  while (prefix < maxPrefix && left[prefix] === right[prefix]) {
    prefix += 1
  }

  if (prefix === previous.length) {
    return healPoisonedSnapshot([...previous, ...replayed.slice(prefix)])
  }

  const midLeft = left.slice(prefix)
  const midRight = right.slice(prefix)

  if (midLeft.length * midRight.length > REPLAY_LCS_CELL_LIMIT) {
    return mergeExternalHistory(replayed, previous)
  }

  const common = Array.from({ length: midLeft.length + 1 }, () => new Uint32Array(midRight.length + 1))
  for (let leftIndex = midLeft.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = midRight.length - 1; rightIndex >= 0; rightIndex -= 1) {
      common[leftIndex][rightIndex] = midLeft[leftIndex] === midRight[rightIndex]
        ? common[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(common[leftIndex + 1][rightIndex], common[leftIndex][rightIndex + 1])
    }
  }

  const midMerged = []
  let leftIndex = 0
  let rightIndex = 0
  const midPrev = previous.slice(prefix)
  const midRep = replayed.slice(prefix)

  while (leftIndex < midLeft.length && rightIndex < midRight.length) {
    if (midLeft[leftIndex] === midRight[rightIndex]) {
      midMerged.push(midPrev[leftIndex])
      leftIndex += 1
      rightIndex += 1
    } else if (common[leftIndex + 1][rightIndex] >= common[leftIndex][rightIndex + 1]) {
      midMerged.push(midPrev[leftIndex])
      leftIndex += 1
    } else {
      midMerged.push(midRep[rightIndex])
      rightIndex += 1
    }
  }
  const tailPrevious = midPrev.slice(leftIndex)
  const tailReplayed = midRep.slice(rightIndex)

  // The common OMP failure mode is one trailing live assistant reply vs the same persisted reply
  // under a different id/ephemeral activity shape. Preserve the live envelope once.
  if (
    tailPrevious.length === 1
    && tailReplayed.length === 1
    && isConsecutiveAssistantDuplicate(tailPrevious[0], tailReplayed[0])
  ) {
    return [...previous.slice(0, prefix), ...midMerged, tailPrevious[0]]
  }

  if (
    tailPrevious.length === tailReplayed.length
    && tailPrevious.length > 0
    && tailPrevious.every((message, index) =>
      message.info.role === tailReplayed[index].info.role
      && messageSignature(message) === messageSignature(tailReplayed[index])
    )
  ) {
    return [...previous.slice(0, prefix), ...midMerged, ...tailPrevious]
  }

  return healPoisonedSnapshot([
    ...previous.slice(0, prefix),
    ...midMerged,
    ...tailPrevious,
    ...tailReplayed
  ])
}
export function mergeExternalHistory(persisted, cached) {
  const persistedIDs = new Set(persisted.map((message) => message.info.id))
  const remainingBySignature = new Map()
  for (const message of persisted) {
    const signature = semanticMessageSignature(message)
    remainingBySignature.set(signature, (remainingBySignature.get(signature) ?? 0) + 1)
  }
  const cachedOnly = cached.filter((message) => {
    if (persistedIDs.has(message.info.id)) return false
    const signature = semanticMessageSignature(message)
    const remaining = remainingBySignature.get(signature) ?? 0
    if (remaining === 0) return true
    remainingBySignature.set(signature, remaining - 1)
    return false
  })
  return [...persisted, ...cachedOnly].sort((left, right) => left.info.time.created - right.info.time.created)
}

function mergeTodos(previous, replayed) {
  if (previous.length === 0 || replayed.length === 0) return replayed.length > 0 ? replayed : previous
  const priorByContent = new Map(previous.map((todo) => [todo.content, todo]))
  if (replayed.some((todo) => !priorByContent.has(todo.content))) return replayed
  const statusRank = { pending: 0, in_progress: 1, completed: 2 }
  return replayed.map((todo) => {
    const prior = priorByContent.get(todo.content)
    return (statusRank[prior.status] ?? -1) > (statusRank[todo.status] ?? -1) ? { ...todo, status: prior.status } : todo
  })
}

/**
 * Some harnesses inject their own bookkeeping into the model's context as user-role turns —
 * background-task notifications and system reminders — and the ACP adapter forwards them as
 * `user_message_chunk` because that is what they are at the protocol level. Rendered faithfully,
 * the app then shows harness internals in a bubble attributed to the person holding the phone,
 * text they never wrote and cannot see anywhere else.
 *
 * Matched only when the chunk is *entirely* one or more such blocks, so a message where someone
 * quotes one while asking about it stays visible — which is exactly how this was reported.
 */
const HARNESS_INJECTED_BLOCK = /^(?:\s*<(task-notification|system-reminder)>[\s\S]*?<\/\1>\s*)+$/

export function isHarnessInjectedText(text) {
  return HARNESS_INJECTED_BLOCK.test(text)
}

/** The two tool-call states that mean "still running" on the wire and in the transcript. */
const UNSETTLED_TOOL_STATUSES = new Set(["pending", "running"])

/**
 * An Activity section in the conversation reads as Working purely from the parts inside it: a tool
 * call still at `pending`/`running`, or a reasoning part with a start and no end. Both are only ever
 * true while the turn that produced them is live, and both are left open by the adapters — Claude's
 * in particular. It drops the closing `tool_call_update` for calls still open when a turn ends, is
 * cancelled or fails, and for calls replayed out of a loaded session's history. So a finished Claude
 * conversation kept individual Activity sections spinning on Working for good, in the persisted
 * snapshot too, while the Session itself correctly read idle.
 *
 * A tool call with no reported outcome is closed as `incomplete`: neither success nor failure may be
 * invented for it, since `completed` would claim a result that never arrived and `error` would
 * accuse a tool that most likely ran. Historical parts close their reasoning at its own start
 * instead of at `now`, because a snapshot reopened days later must not report the outage as time
 * the agent spent thinking.
 */
export function settleUnfinishedActivity(messages, { now = Date.now(), historical = false } = {}) {
  let settled = 0
  for (const message of Array.isArray(messages) ? messages : []) {
    for (const part of message?.parts ?? []) {
      if (part?.type === "tool" && part.state && UNSETTLED_TOOL_STATUSES.has(part.state.status)) {
        part.state.status = "incomplete"
        if (part.state.time && !part.state.time.end) part.state.time.end = now
        settled += 1
        continue
      }
      if (part?.type === "reasoning" && part.time?.start && !part.time.end) {
        part.time.end = historical ? part.time.start : now
        settled += 1
      }
    }
  }
  return settled
}

// The app groups the picker by source and offers a skill-only filter, so the
// `skill:` prefix OMP puts on skill commands has to survive as structured data
// rather than staying buried in the name.
function commandInfoList(commands) {
  return commands.map((command) => ({
    name: command.name,
    description: command.description ?? undefined,
    source: command.name.startsWith("skill:") ? "skill" : "command"
  }))
}

export class AcpService {
  #acp
  #sessions = new Map()
  // Bounds come from TranscriptCache: the 24MB weight budget governs, and the entry cap only stops
  // unbounded growth from many tiny transcripts. Pinning 8 here re-introduced the Session-first
  // thrash the default exists to avoid.
  #messages = new TranscriptCache({
    isProtected: (sessionID) => this.#active.has(sessionID)
      || this.#replaying.has(sessionID)
      || this.#loads.has(sessionID)
      || (this.#snapshotWrites.has(sessionID) && Date.now() - (this.#snapshotWriteStart.get(sessionID) ?? 0) < 10_000)
      || (this.#dirtySnapshots.has(sessionID) && Date.now() - (this.#dirtyStart.get(sessionID) ?? 0) < 10_000)
      || Boolean(this.#queues.get(sessionID)?.length),
    onEvict: (sessionID) => {
      this.#loaded.delete(sessionID)
      this.#restoredSnapshots.delete(sessionID)
      this.#todos.delete(sessionID)
      this.#configOptions.delete(sessionID)
      this.#commandCatalogs.delete(sessionID)
      for (const resolve of this.#commandCatalogWaiters.get(sessionID) ?? []) resolve()
      this.#commandCatalogWaiters.delete(sessionID)
      this.#actionStates.delete(sessionID)
      this.#authoritativeActionStates.delete(sessionID)
      this.#promptAcknowledgements.delete(sessionID)
      this.#transientFailureMessageIDs.delete(sessionID)
      this.#chunkMessageIDs.delete(`${sessionID}:user`)
      this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
      this.#turnGenerations.delete(sessionID)
      this.#cancelledSessions.delete(sessionID)
      this.#promptedSessions.delete(sessionID)
      this.#queues.delete(sessionID)
      this.#dirtySnapshots.delete(sessionID)
      this.#dirtyStart.delete(sessionID)
      this.#snapshotWriteStart.delete(sessionID)
    }
  })
  #todos = new Map()
  #configOptions = new Map()
  #commandCatalogs = new Map()
  #commandCatalogWaiters = new Map()
  #actionStates = new Map()
  #authoritativeActionStates = new Map()
  #actionProviders
  #loaded = new Set()
  #loads = new Map()
  #sessionListing
  #replaying = new Set()
  #historyLoader
  #ownedSessions = new Set()
  #adoptedSessions = new Set()
  #acpOpenSessions = new Set()
  #promptAcknowledgements = new Map()
  #titles = new Map()
  #deletedSessions = new Set()
  #deletedSessionIndexLoaded = false
  #deletedSessionIndexWrite = Promise.resolve()
  #queues = new Map()
  #active = new Set()
  #listeners = new Set()
  #turnGenerations = new Map()
  #cancelledSessions = new Set()
  #promptedSessions = new Set()
  #chunkMessageIDs = new Map()
  // PI's journal is authoritative, but a provider rejection can be emitted by ACP before the journal
  // has flushed its terminal assistant error. These ids keep only that short-lived bridge copy alive.
  #transientFailureMessageIDs = new Map()
  #snapshotDirectory
  #restoredSnapshots = new Set()
  #dirtySnapshots = new Set()
  #dirtyStart = new Map()
  #snapshotWrites = new Map()
  #snapshotWriteStart = new Map()
  #preserveListedTimestamps
  #reloadOnHistoryRefresh
  #replaySettleMs
  #preferListedTitles
  #nativeRenameCommand
  #journalPageWhileOwned
  #modelVariantConfigIDs
  constructor(acp, {
    snapshotDirectory,
    historyLoader,
    preserveListedTimestamps = false,
    reloadOnHistoryRefresh = true,
    replaySettleMs = 0,
    preferListedTitles = false,
    nativeRenameCommand,
    /**
     * Whether a paged read of a Session this bridge owns may still be answered from the harness's
     * journal instead of from the stream this bridge is holding.
     *
     * It may for every harness whose journal and whose ACP stream describe a message with the same
     * identity. OMP is the one that does not: its journal keys a message by the entry id it wrote,
     * while its ACP stream mints a fresh `messageId` per live message and a fresh one again on
     * every replay. Answering one read from each source therefore hands the app two different ids
     * for one reply, and an app that reconciles pages by id has no way to tell that apart from two
     * replies - which is what made a second turn look blank until the conversation was reopened.
     */
    journalPageWhileOwned = true,
    /**
     * Config-option ids this harness uses for the reasoning variant that belongs to a model.
     * Only used to report the Session's current selection; a variant is still applied against an
     * id the running adapter actually advertised.
     */
    modelVariantConfigIDs = [],
    actionProviders = []
  } = {}) {
    this.#acp = acp
    this.#snapshotDirectory = snapshotDirectory
    this.#historyLoader = historyLoader
    this.#preserveListedTimestamps = preserveListedTimestamps
    this.#reloadOnHistoryRefresh = reloadOnHistoryRefresh
    this.#replaySettleMs = replaySettleMs
    this.#preferListedTitles = preferListedTitles
    this.#nativeRenameCommand = nativeRenameCommand
    this.#journalPageWhileOwned = journalPageWhileOwned
    this.#modelVariantConfigIDs = modelVariantConfigIDs
    this.#actionProviders = actionProviders
    acp.on("notification", (notification) => this.#handleNotification(notification))
  }

  subscribe(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  diagnostics() {
    return {
      transcriptCache: this.#messages.stats(),
      activeSessions: this.#active.size,
      queuedSessions: this.#queues.size,
      inFlightLoads: this.#loads.size,
      snapshotWrites: this.#snapshotWrites.size,
      subscribers: this.#listeners.size,
      // How this harness resolves history. A loader that walks a session tree reports how often it
      // has had to, which is what makes "opening Sessions gets slower" measurable rather than felt.
      ...(this.#historyLoader?.diagnostics ? { history: this.#historyLoader.diagnostics() } : {})
    }
  }

  async listSessions(directory) {
    await this.#restoreDeletedSessionIndex()
    const sessions = await this.#refreshSessions()
    await Promise.all(sessions.map((session) => this.#restoreSnapshot(session.sessionId)))
    return sessions
      .filter((session) => !directory || sameDirectory(session.cwd, directory))
      .filter((session) => !this.#deletedSessions.has(session.sessionId))
      .map((session) => sessionView(
        session,
        this.#isBusy(session.sessionId) ? "busy" : "idle",
        this.#titleFor(session.sessionId),
        Boolean(this.#historyLoader && !this.#ownedSessions.has(session.sessionId))
      ))
  }

  /**
   * Lightweight overlay for Sessions this bridge already created or claimed.
   *
   * The Session-first rail intentionally reads the harness's cheap native index instead of calling
   * listSessions(), because restoring every historical snapshot just to draw the rail can retain
   * gigabytes of transcript data. Some ACP adapters, notably PI, do not publish a brand-new Session
   * in that native index until its first prompt materialises native history. Keep only the small
   * in-memory metadata for Sessions whose writer this bridge already owns, plus an explicit local
   * title override when the harness cannot persist that name itself.
   */
  ownedSessionIndex(directory) {
    return [...this.#ownedSessions].flatMap((sessionID) => {
      const session = this.#sessions.get(sessionID)
      if (!session || (directory && !sameDirectory(session.cwd, directory))) return []
      const titleOverride = this.#titles.get(sessionID)
      return [{
        session: sessionView(
          session,
          this.#isBusy(sessionID) ? "busy" : "idle",
          titleOverride || session.title
        ),
        ...(titleOverride ? { titleOverride } : {})
      }]
    })
  }

  async createSession({ directory, title, model }) {
    await this.#acp.start()
    const result = await this.#acp.request("session/new", { cwd: directory, mcpServers: [] })
    this.#acpOpenSessions.add(result.sessionId)
    this.#rememberConfigOptions(result.sessionId, result.configOptions)
    const session = {
      sessionId: result.sessionId,
      cwd: directory,
      // No invented placeholder: an unnamed Session is named by the harness itself from its first
      // message, and until then the caller's own fallback is the honest label.
      ...(title ? { title } : {}),
      updatedAt: new Date().toISOString(),
      _meta: { messageCount: 0 }
    }
    this.#sessions.set(session.sessionId, session)
    this.#messages.set(session.sessionId, [])
    this.#todos.set(session.sessionId, [])
    this.#loaded.add(session.sessionId)
    this.#ownedSessions.add(session.sessionId)
    if (title) {
      this.#titles.set(session.sessionId, title)
      await this.#applyNativeSessionName(session.sessionId, title)
    }
    if (model) await this.setModel(session.sessionId, model)
    this.#emit("session.created", session.sessionId)
    this.#persistSnapshot(session.sessionId)
    return sessionView(session, "idle", this.#titleFor(session.sessionId))
  }

  /**
   * Explicitly acquire the writer for one exact existing native ACP Session.
   *
   * Reading a journal-backed Session must not imply ownership. A Session that this ACP connection
   * already opened successfully can be claimed without loading it twice; a compatibility-adopted
   * Task Session is deliberately excluded because adoption never proved native writer ownership.
   * Otherwise force the hardened session/load path and mark ownership only after it succeeds.
   */
  async claimSession(sessionID) {
    await this.#requireSession(sessionID)
    if (this.#ownedSessions.has(sessionID) && !this.#adoptedSessions.has(sessionID)) return true
    if (this.#acpOpenSessions.has(sessionID) && !this.#adoptedSessions.has(sessionID)) {
      this.#ownedSessions.add(sessionID)
      this.#persistSnapshot(sessionID)
      return true
    }

    await this.#load(sessionID, true, true)
    this.#ownedSessions.add(sessionID)
    this.#adoptedSessions.delete(sessionID)
    this.#persistSnapshot(sessionID)
    return true
  }

  /**
   * Adopt a task session created by an older daemon so PI can open it without session/load.
   *
   * Ownership here only means "this bridge may prompt it directly"; it does not mean the transcript
   * in memory is the whole conversation. Everything the task said while no daemon was running lives
   * in the harness's own journal, and marking the session loaded on adoption made that unreachable:
   * opening a restarted task showed the one recorded prompt and nothing else until a new message
   * streamed in. Tracking adoption separately keeps prompting lock-free while still letting the
   * journal fill in what this process never saw.
   */
  async adoptTaskSession(sessionID, { title, prompt } = {}) {
    await this.#refreshSessions()
    const session = this.#sessions.get(sessionID)
    if (!session || this.#deletedSessions.has(sessionID)) return false
    this.#ownedSessions.add(sessionID)
    this.#adoptedSessions.add(sessionID)
    if (title && !this.#titles.has(sessionID)) this.#titles.set(sessionID, title)
    const messages = this.#messages.get(sessionID) ?? []
    if (prompt && !messages.some((message) => message.info?.role === "user" && message.parts?.some((part) => part.text === prompt))) {
      this.#recordPrompt(sessionID, prompt)
    }
    this.#persistSnapshot(sessionID)
    return true
  }

  async renameSession(sessionID, title) {
    const normalized = title.trim().replace(/\s+/g, " ")
    if (!normalized) throw new Error("A session title is required")
    await this.#requireSession(sessionID)

    if (typeof this.#historyLoader?.renameSession === "function") {
      if (this.#isBusy(sessionID)) throw new Error("A busy PI session cannot be renamed")
      if (this.#acpOpenSessions.has(sessionID)) {
        await this.#acp.request("session/close", { sessionId: sessionID })
        this.#acpOpenSessions.delete(sessionID)
      }
      await this.#historyLoader.renameSession(sessionID, normalized)
      this.#loaded.delete(sessionID)
      this.#ownedSessions.delete(sessionID)
      this.#adoptedSessions.delete(sessionID)
      this.#configOptions.delete(sessionID)
      this.#commandCatalogs.delete(sessionID)
      this.#actionStates.delete(sessionID)
      this.#authoritativeActionStates.delete(sessionID)
      this.#titles.delete(sessionID)
      await this.#refreshSessions()
      const session = this.#sessions.get(sessionID)
      if (!session) throw new Error("Harness session not found after rename")
      this.#persistSnapshot(sessionID)
      this.#emit("session.updated", sessionID)
      return sessionView(
        session,
        "idle",
        this.#titleFor(sessionID),
        Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
      )
    }

    if (await this.#nativeRenameAvailable(sessionID)) {
      await this.#sendNativeSessionName(sessionID, normalized)
      this.#titles.delete(sessionID)
      await this.#refreshSessions()
      const session = this.#sessions.get(sessionID)
      if (!session) throw new Error("Harness session not found after rename")
      this.#persistSnapshot(sessionID)
      this.#emit("session.updated", sessionID)
      return sessionView(
        session,
        this.#isBusy(sessionID) ? "busy" : "idle",
        this.#titleFor(sessionID),
        Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
      )
    }

    this.#titles.set(sessionID, normalized)
    this.#persistSnapshot(sessionID)
    this.#emit("session.updated", sessionID)
    return sessionView(
      this.#sessions.get(sessionID),
      this.#isBusy(sessionID) ? "busy" : "idle",
      normalized,
      Boolean(this.#historyLoader && !this.#ownedSessions.has(sessionID))
    )
  }

  /**
   * Whether this exact Session can be named through the harness's own rename command.
   *
   * A name Harness Remote only keeps for itself is invisible everywhere else: the Session index the
   * app reads is the harness's own lightweight listing, and a Session reopened from the harness has
   * never heard of it. Asking the harness to store the name is what makes it survive - but only a
   * command the running build actually advertises may be sent, because an unrecognised slash
   * command is not an error, it is a prompt the model would try to answer.
   */
  async #nativeRenameAvailable(sessionID) {
    if (!this.#nativeRenameCommand) return false
    // The command is delivered into this exact Session, so the Session has to be open on this
    // connection before it can be asked for - and its command catalog only arrives with that open.
    await this.#loadForConfigOptions(sessionID)
    if (!this.#commandCatalogs.has(sessionID)) await this.#waitForCommandCatalog(sessionID)
    return (this.#commandCatalogs.get(sessionID) ?? []).some((command) => command.name === this.#nativeRenameCommand)
  }

  /**
   * Run the harness's rename command without letting it show up as a turn.
   *
   * The command is delivered the only way a slash command can be, as a prompt, and the harness
   * answers it with a confirmation line. That line is not conversation, so the transcript and todos
   * are captured before and restored after; the session is marked active meanwhile so the harness's
   * own output is not mistaken for unsolicited streaming.
   */
  async #sendNativeSessionName(sessionID, title) {
    const messagesBefore = structuredClone(this.#messages.get(sessionID) ?? [])
    const todosBefore = structuredClone(this.#todos.get(sessionID) ?? [])
    const wasActive = this.#active.has(sessionID)
    if (!wasActive) this.#active.add(sessionID)
    try {
      await this.#acp.request("session/prompt", {
        sessionId: sessionID,
        prompt: [{ type: "text", text: `/${this.#nativeRenameCommand} ${title}` }]
      }, 300_000)
    } finally {
      if (!wasActive) this.#active.delete(sessionID)
      this.#messages.set(sessionID, messagesBefore)
      this.#todos.set(sessionID, todosBefore)
      this.#chunkMessageIDs.delete(`${sessionID}:user`)
      this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    }
  }

  /**
   * Give a Session the name it was created with, for a harness whose create call has no title.
   *
   * `session/new` carries no title in ACP, so a name chosen in the New Session panel would only
   * ever have lived in this bridge. Creating the Session must not fail because naming it did, so a
   * harness that cannot store the name keeps it here instead - which is exactly what it did before.
   */
  async #applyNativeSessionName(sessionID, title) {
    try {
      if (!await this.#nativeRenameAvailable(sessionID)) return
      await this.#sendNativeSessionName(sessionID, title)
      this.#titles.delete(sessionID)
      await this.#refreshSessions()
    } catch {
      this.#titles.set(sessionID, title)
    }
  }

  async deleteSession(sessionID) {
    // A Session deleted by a pre-index Harness Remote may already carry deleted:true only in its
    // per-Session snapshot. Restoring that snapshot must migrate the tombstone into the lightweight
    // deletion index instead of failing before the index can be written. This keeps DELETE
    // idempotent across upgrades without issuing any new ACP request.
    await this.#restoreDeletedSessionIndex()
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    if (this.#deletedSessions.has(sessionID)) {
      await this.#persistDeletedSessionIndex()
      return
    }
    if (!this.#sessions.has(sessionID)) throw new Error("Harness session not found")

    if (this.#isBusy(sessionID)) this.abort(sessionID)
    this.#deletedSessions.add(sessionID)
    await this.#persistDeletedSessionIndex()
    this.#messages.delete(sessionID)
    this.#todos.delete(sessionID)
    this.#titles.delete(sessionID)
    this.#configOptions.delete(sessionID)
    this.#commandCatalogs.delete(sessionID)
    for (const resolve of this.#commandCatalogWaiters.get(sessionID) ?? []) resolve()
    this.#commandCatalogWaiters.delete(sessionID)
    this.#actionStates.delete(sessionID)
    this.#authoritativeActionStates.delete(sessionID)
    this.#loaded.delete(sessionID)
    this.#ownedSessions.delete(sessionID)
    this.#adoptedSessions.delete(sessionID)
    this.#promptAcknowledgements.delete(sessionID)
    this.#transientFailureMessageIDs.delete(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:user`)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#turnGenerations.delete(sessionID)
    this.#cancelledSessions.delete(sessionID)
    this.#promptedSessions.delete(sessionID)
    this.#queues.delete(sessionID)
    this.#active.delete(sessionID)
    this.#acpOpenSessions.delete(sessionID)
    this.#dirtySnapshots.delete(sessionID)
    this.#dirtyStart.delete(sessionID)
    this.#snapshotWriteStart.delete(sessionID)
    this.#emit("session.deleted", sessionID)
    this.#persistSnapshot(sessionID)
  }

  async messages(sessionID, refresh = false) {
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    if (this.#historyLoader?.authoritativeHistory) {
      try {
        const persistedMessages = mergeFragmentedPiSnapshot(await this.#historyLoader(sessionID))
        let cachedMessages = mergeFragmentedPiSnapshot(this.#messages.get(sessionID) ?? [])
        const transientFailures = this.#transientFailureMessageIDs.get(sessionID)

        // Once PI has journalled the failed turn, its record replaces the bridge's temporary error
        // even when the wording/id differs. Leaving both in the live cache is what made the next
        // successful turn appear to produce an extra assistant response.
        if (transientFailures?.size) {
          const superseded = new Set()
          for (const failureID of transientFailures) {
            if (persistedFailureForTransientTurn(persistedMessages, cachedMessages, failureID)) {
              superseded.add(failureID)
            }
          }
          if (superseded.size) {
            cachedMessages = cachedMessages.filter((message) => !superseded.has(message?.info?.id))
            for (const failureID of superseded) transientFailures.delete(failureID)
            if (!transientFailures.size) this.#transientFailureMessageIDs.delete(sessionID)
          }
        }

        const pendingFailureTurn = transientFailureTurnMessages(
          cachedMessages,
          this.#transientFailureMessageIDs.get(sessionID)
        )
        const messages = this.#isBusy(sessionID)
          ? mergeFragmentedPiSnapshot(mergeExternalHistory(persistedMessages, cachedMessages))
          // Idle normally means "journal only". The one exception is a live provider failure the
          // journal has not flushed yet; keep that exact failed turn until the persisted copy exists.
          : pendingFailureTurn.length
            ? mergeFragmentedPiSnapshot(mergeExternalHistory(persistedMessages, pendingFailureTurn))
            : persistedMessages
        if (semanticHistorySignature(messages) !== semanticHistorySignature(cachedMessages)) {
          this.#resetActionsForSessionChange(sessionID)
        }
        this.#messages.set(sessionID, messages)
        this.#loaded.add(sessionID)
        this.#persistSnapshot(sessionID)
        return messages
      } catch {
        this.#emit("session.error", sessionID, { message: "Harness session history could not be read" })
      }
    }
    const reloadHistory = refresh && this.#reloadOnHistoryRefresh
    await this.#load(sessionID, reloadHistory || this.#journalBacked(sessionID))
    return this.#messages.get(sessionID) ?? []
  }

  async messagePage(sessionID, { limit = 100, before, refresh = false } = {}) {
    const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100))
    if (
      this.#journalPageAvailable(sessionID)
      && !refresh
      && !this.#isBusy(sessionID)
      && !this.#transientFailureMessageIDs.get(sessionID)?.size
    ) {
      try {
        let pageOptions = { limit: boundedLimit, before }
        if (this.#historyLoader.pageRequiresActiveLeaf) {
          if (!this.#sessions.has(sessionID)) await this.#refreshSessions()
          const authoritativeState = await this.#refreshActionState(sessionID, false)
          if (authoritativeState?.activeSessionLeaf === undefined) pageOptions = null
          else pageOptions = { ...pageOptions, activeSessionLeaf: authoritativeState.activeSessionLeaf }
        }
        if (pageOptions) {
          const page = await this.#historyLoader.page(sessionID, pageOptions)
          if (page && Array.isArray(page.messages)) return page
        }
      } catch {
        this.#emit("session.error", sessionID, { message: "Harness session history page could not be read" })
      }
    }
    const messages = await this.messages(sessionID, refresh)
    const requestedEnd = before
      ? messages.findIndex((message) => message?.info?.id === before)
      : messages.length
    const end = requestedEnd >= 0 ? requestedEnd : messages.length
    const start = Math.max(0, end - boundedLimit)
    const model = this.#configuredModelSelection(sessionID)
    return {
      messages: messages.slice(start, end),
      before: start > 0 ? messages[start]?.info?.id ?? null : null,
      hasMore: start > 0,
      ...(model ? { model } : {})
    }
  }

  /**
   * Whether this exact Session's paged read may be served from the harness's own journal.
   *
   * A loader that declares itself authoritative answers every read from the journal, so paging from
   * it is the same source. Otherwise the journal is the authority only while this bridge is not the
   * writer - and a harness may opt out of journal paging even then, see `journalPageWhileOwned`.
   */
  #journalPageAvailable(sessionID) {
    if (typeof this.#historyLoader?.page !== "function") return false
    if (this.#historyLoader.authoritativeHistory === true) return true
    if (this.#journalBacked(sessionID)) return true
    return this.#journalPageWhileOwned
  }

  /**
   * The model this Session is configured with, for the harnesses whose owned pages no longer come
   * from the journal that used to report it.
   *
   * The value is the one the adapter itself last returned for the `model` config option, so it
   * costs no I/O and cannot disagree with what the next prompt would run on. It is addressed the
   * way the app addresses models everywhere, `provider/model`; a harness whose ids carry no
   * provider reports nothing here rather than inventing one.
   */
  #configuredModelSelection(sessionID) {
    if (this.#journalPageWhileOwned) return undefined
    const options = this.#configOptions.get(sessionID)
    const current = options?.find((item) => item.id === "model")?.currentValue
    if (typeof current !== "string") return undefined
    const separator = current.indexOf("/")
    if (separator <= 0 || separator === current.length - 1) return undefined
    // The reasoning variant belongs to the selection: reporting the model without it would let the
    // app carry the next turn on with the variant silently dropped.
    const variant = this.#modelVariantConfigIDs
      .map((configId) => options?.find((item) => item.id === configId)?.currentValue)
      .find((value) => typeof value === "string" && value)
    return {
      providerID: current.slice(0, separator),
      modelID: current.slice(separator + 1),
      ...(variant ? { variant } : {})
    }
  }

  /**
   * Whether the harness's own on-disk history is the authority for this session rather than what
   * this process streamed. True for a session another client owns, and for an adopted task session
   * until this bridge starts a turn on it — up to that point nothing about the conversation came
   * through here, so re-reading the journal is what keeps the transcript current.
   */
  #journalBacked(sessionID) {
    if (!this.#historyLoader) return false
    return !this.#ownedSessions.has(sessionID) || this.#adoptedSessions.has(sessionID)
  }

  async todos(sessionID) {
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) return []
    await this.#load(sessionID)
    return this.#todos.get(sessionID) ?? []
  }

  async models(sessionID) {
    await this.#loadForConfigOptions(sessionID)
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    return option?.options?.map((candidate) => ({ ...candidate, currentValue: candidate.value === option.currentValue })) ?? []
  }

  async actions(sessionID) {
    if (!this.#commandCatalogs.has(sessionID)) {
      await this.#load(sessionID, true, true)
      await this.#waitForCommandCatalog(sessionID)
    }
    await this.#refreshActionState(sessionID)
    return this.#availableActions(sessionID)
  }

  // The catalog is per ACP session, but a harness advertises the same commands for
  // every session on the machine, so the newest one answers the app's session-less
  // GET /command. Without that fallback the picker is empty until a session loads.
  async commands(sessionID) {
    if (sessionID) {
      if (!this.#commandCatalogs.has(sessionID)) {
        await this.#load(sessionID, true, true)
        await this.#waitForCommandCatalog(sessionID)
      }
      return commandInfoList(this.#commandCatalogs.get(sessionID) ?? [])
    }
    const catalogs = [...this.#commandCatalogs.values()]
    return commandInfoList(catalogs.at(-1) ?? [])
  }

  #waitForCommandCatalog(sessionID) {
    if (this.#commandCatalogs.has(sessionID)) return Promise.resolve()
    return new Promise((resolve) => {
      let waiters = this.#commandCatalogWaiters.get(sessionID)
      if (!waiters) {
        waiters = new Set()
        this.#commandCatalogWaiters.set(sessionID, waiters)
      }
      const finish = () => {
        clearTimeout(timer)
        waiters.delete(finish)
        if (waiters.size === 0) this.#commandCatalogWaiters.delete(sessionID)
        resolve()
      }
      const timer = setTimeout(finish, 500)
      waiters.add(finish)
    })
  }

  async invokeAction(sessionID, actionID) {
    const available = await this.actions(sessionID)
    if (!available.some((action) => action.id === actionID)) throw new Error(`Harness action is not available: ${actionID}`)
    if (!available.some((action) => action.id === actionID && action.enabled)) throw new Error(`Harness action is disabled: ${actionID}`)
    const resolved = resolveExtensionAction(
      this.#actionProviders,
      this.#commandCatalogs.get(sessionID) ?? [],
      actionID
    )
    if (!resolved) throw new Error(`Harness action is not available: ${actionID}`)

    const beforeState = this.#authoritativeActionStates.get(sessionID)
    this.#ownedSessions.add(sessionID)
    this.#active.add(sessionID)
    this.#emit("session.updated", sessionID)
    let applied = null
    let authoritativeState
    try {
      await this.#acp.request("session/prompt", {
        sessionId: sessionID,
        prompt: [{ type: "text", text: `/${resolved.action.command}` }]
      }, 300_000)
      authoritativeState = await this.#refreshActionState(sessionID)
      if (
        authoritativeState?.actionResult?.id === actionID &&
        authoritativeState.actionResult.token !== beforeState?.actionResult?.token
      ) {
        applied = authoritativeState.actionResult.applied
      } else if (
        typeof beforeState?.sessionRevision === "string" &&
        typeof authoritativeState?.sessionRevision === "string"
      ) {
        applied = authoritativeState.sessionRevision !== beforeState.sessionRevision
      }
      await this.#loadSession(sessionID, true, true)
      this.#emit("message.updated", sessionID)
      this.#persistSnapshot(sessionID)
    } finally {
      this.#active.delete(sessionID)
      this.#emit("session.updated", sessionID)
    }
    return {
      action: actionID,
      applied,
      actions: this.#availableActions(sessionID),
      ...(authoritativeState?.sessionRevision ? { sessionRevision: authoritativeState.sessionRevision } : {})
    }
  }

  async #refreshActionState(sessionID, requireCommands = true) {
    const session = this.#sessions.get(sessionID)
    if (!session) return undefined
    const state = await loadExtensionActionState(
      this.#actionProviders,
      requireCommands ? this.#commandCatalogs.get(sessionID) ?? [] : undefined,
      { sessionID, directory: session.cwd, processID: this.#acp.processID }
    )
    if (state) this.#authoritativeActionStates.set(sessionID, state)
    else this.#authoritativeActionStates.delete(sessionID)
    return state
  }

  #actionState(sessionID) {
    let state = this.#actionStates.get(sessionID)
    if (!state) {
      state = new Map()
      this.#actionStates.set(sessionID, state)
    }
    return state
  }

  #availableActions(sessionID) {
    return listExtensionActions(
      this.#actionProviders,
      this.#commandCatalogs.get(sessionID) ?? [],
      this.#actionState(sessionID),
      this.#isBusy(sessionID),
      this.#authoritativeActionStates.get(sessionID)
    )
  }

  #resetActionsForSessionChange(sessionID) {
    resetExtensionActionState(
      this.#actionProviders,
      this.#commandCatalogs.get(sessionID) ?? [],
      this.#actionState(sessionID)
    )
  }

  /**
   * Apply the model, and any harness-advertised variant that belongs to it, to one native Session.
   *
   * The variant is applied here rather than by the caller because a harness legitimately resets
   * dependent controls when the model changes: setting the variant first silently discards it. This
   * is also the only place that already waits for real configOptions, so the variant cannot be sent
   * against a Session whose options have not been loaded yet.
   */
  async setModel(sessionID, model, variant) {
    await this.#loadForConfigOptions(sessionID)
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    // The app addresses models as `provider/model` because that is what OpenCode's API does, but a
    // harness whose ids carry no provider — Claude Code's `sonnet`, `opus[1m]` — is shown under the
    // backend's name to keep it consistent. Resolve against what the agent actually offered rather
    // than trusting either spelling: exact first, then the part after the synthesised provider.
    const value = option?.options?.some((candidate) => candidate.value === model)
      ? model
      : option?.options?.find((candidate) => candidate.value === model.slice(model.indexOf("/") + 1))?.value
    if (!value) throw new Error(`Harness model is not available: ${model}`)
    // Continuing on the model the Session already holds is not a model change. Sending it anyway
    // made every prompt mutate the Session's configuration, which a harness is entitled to journal
    // and to announce - so simply carrying on read as though the user had switched models.
    if (option?.currentValue === value) {
      await this.#setModelVariant(sessionID, variant)
      return
    }
    const changed = await this.#acp.request("session/set_config_option", { sessionId: sessionID, configId: "model", value })
    // Adopt the options the adapter reports for the model it now holds. A harness whose dependent
    // controls differ per model - PI advertises a different thinkingLevel range for each one, from a
    // single `off` up to `max` - otherwise leaves this Session describing the previous model, so the
    // variant about to be applied would be checked against the wrong set of values.
    if (Array.isArray(changed?.configOptions)) this.#rememberConfigOptions(sessionID, changed.configOptions)
    const current = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    if (current) current.currentValue = value
    else option.currentValue = value
    await this.#setModelVariant(sessionID, variant)
  }

  /**
   * A variant is only ever applied against an id the running adapter advertised for this Session's
   * current model. A harness that does not offer the control is not asked for it, so no reasoning
   * level is invented, and a level the current model does not support is refused rather than sent.
   */
  async #setModelVariant(sessionID, variant) {
    const configId = typeof variant?.configId === "string" ? variant.configId : ""
    const value = typeof variant?.value === "string" ? variant.value : ""
    if (!configId || !value) return
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === configId)
    if (!option?.options?.some((candidate) => candidate?.value === value)) {
      const offered = (option?.options ?? []).map((candidate) => candidate?.value).filter(Boolean)
      const error = new Error(`Harness model variant is not available: ${configId}=${value}${offered.length ? ` (this model offers ${offered.join(", ")})` : ""}`)
      error.code = "model_variant_unavailable"
      throw error
    }
    const changed = await this.#acp.request("session/set_config_option", { sessionId: sessionID, configId, value })
    if (Array.isArray(changed?.configOptions)) this.#rememberConfigOptions(sessionID, changed.configOptions)
    const current = this.#configOptions.get(sessionID)?.find((item) => item.id === configId)
    if (current) current.currentValue = value
    else option.currentValue = value
  }

  /**
   * ACP accepts one turn per session at a time, so a prompt sent while the agent is
   * still working is queued rather than rejected. It is recorded straight away, which
   * is what makes it visible in the conversation while it waits.
   */
  async prompt(sessionID, text, model, attachments = [], variant) {
    // Refuse before touching the session: an agent that never advertised image support
    // would reject the block mid-turn, which reads as a failed prompt rather than a
    // rejected attachment.
    if (attachments.length && !this.#acp.promptCapabilities?.image) {
      throw new Error("This harness does not accept images")
    }
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) {
      this.#ownedSessions.add(sessionID)
      this.#loaded.delete(sessionID)
      try {
        await this.#load(sessionID)
      } catch (error) {
        this.#ownedSessions.delete(sessionID)
        throw error
      }
    } else {
      await this.#load(sessionID)
    }
    this.#resetActionsForSessionChange(sessionID)
    if (this.#active.has(sessionID)) {
      const messageID = this.#recordPrompt(sessionID, text, attachments)
      const queue = this.#queues.get(sessionID) ?? []
      queue.push({ text, model, messageID, attachments, variant })
      this.#queues.set(sessionID, queue)
      this.#emit("session.updated", sessionID)
      return
    }
    if (model) await this.setModel(sessionID, model, variant)
    this.#startTurn(sessionID, text, false, attachments)
  }

  /** Start a prompt through the session service and resolve only when that turn becomes idle. */
  async promptAndWait(sessionID, text, model, attachments = []) {
    return new Promise((resolve, reject) => {
      let started = false
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        unsubscribe()
        if (error) reject(error)
        else resolve()
      }
      const unsubscribe = this.subscribe((event) => {
        if (event.sessionId !== sessionID) return
        if (event.type === "session.error") {
          finish(new Error(event.message ?? "Harness prompt failed"))
          return
        }
        if (event.type !== "session.updated") return
        if (this.#isBusy(sessionID)) started = true
        else if (started) finish()
      })
      void this.prompt(sessionID, text, model, attachments).catch(finish)
    })
  }

  #startTurn(sessionID, text, recorded = false, attachments = []) {
    // From the first turn this bridge runs, its own stream is the live record for the session, the
    // same way taking ownership of an external session stops the journal being re-read for it.
    this.#adoptedSessions.delete(sessionID)
    const generation = (this.#turnGenerations.get(sessionID) ?? 0) + 1
    this.#turnGenerations.set(sessionID, generation)
    this.#cancelledSessions.delete(sessionID)
    this.#promptedSessions.add(sessionID)
    if (!recorded) this.#recordPrompt(sessionID, text, attachments)
    this.#active.add(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#emit("session.updated", sessionID)
    void this.#acp.request("session/prompt", {
      sessionId: sessionID,
      prompt: [
        ...(text ? [{ type: "text", text }] : []),
        ...attachments.map((attachment) => ({ type: "image", mimeType: attachment.mime, data: attachment.data }))
      ]
    }, 300_000).catch((error) => {
      if (this.#turnGenerations.get(sessionID) === generation) {
        this.#recordTurnFailure(sessionID, error.message)
        this.#emit("session.error", sessionID, { message: error.message })
      }
    }).finally(() => {
      if (this.#turnGenerations.get(sessionID) !== generation) return
      this.#active.delete(sessionID)
      this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
      // The turn is over, so no activity it started is still running, whatever the adapter said.
      this.#settleActivity(sessionID)
      this.#emit("session.updated", sessionID)
      this.#persistSnapshot(sessionID)
      void this.#runNextQueued(sessionID)
    })
  }

  /**
   * A turn that fails leaves the prompt on screen with nothing after it, and the live error banner
   * that reports why is gone the moment the session is reopened. Attaching the reason to the turn's
   * own assistant message keeps it in the transcript — and in the snapshot — so a failed reply stays
   * distinguishable from a reply that never got recorded.
   */
  #recordTurnFailure(sessionID, message) {
    if (typeof message !== "string" || !message.trim()) return
    const messages = this.#messages.get(sessionID) ?? []
    this.#messages.set(sessionID, messages)
    const streamedID = this.#chunkMessageIDs.get(`${sessionID}:assistant`)
    let target = streamedID ? messages.find((item) => item.info.id === streamedID) : undefined
    if (!target) {
      target = {
        info: { id: randomUUID(), role: "assistant", sessionID, time: { created: Date.now() } },
        parts: []
      }
      messages.push(target)
    }
    target.info.error = { name: "HarnessTurnError", message: message.trim() }
    if (this.#historyLoader?.authoritativeHistory) {
      const failures = this.#transientFailureMessageIDs.get(sessionID) ?? new Set()
      failures.add(target.info.id)
      this.#transientFailureMessageIDs.set(sessionID, failures)
    }
    this.#emit("message.updated", sessionID)
    this.#persistSnapshot(sessionID)
  }

  async #runNextQueued(sessionID) {
    const queue = this.#queues.get(sessionID)
    if (!queue?.length) return
    const next = queue.shift()
    if (!queue.length) this.#queues.delete(sessionID)
    // The model is applied on dequeue: doing it on enqueue would switch the model
    // underneath the turn that was still running.
    if (next.model) {
      try {
        await this.setModel(sessionID, next.model, next.variant)
      } catch (error) {
        // The queued user prompt was already recorded when it was enqueued. A model switch refusal
        // terminates that turn; never run it on the previous model after telling the client it failed.
        this.#recordTurnFailure(sessionID, error.message)
        this.#emit("session.error", sessionID, { message: error.message })
        this.#emit("session.updated", sessionID)
        this.#persistSnapshot(sessionID)
        void this.#runNextQueued(sessionID)
        return
      }
    }
    this.#startTurn(sessionID, next.text, true, next.attachments ?? [])
  }

  /** Cancelling drops anything still queued, including the messages recorded for it. */
  abort(sessionID) {
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) {
      throw new Error("This session is not active in the app")
    }
    const queue = this.#queues.get(sessionID)
    if (queue?.length) {
      const discarded = new Set(queue.map((entry) => entry.messageID))
      this.#queues.delete(sessionID)
      const messages = this.#messages.get(sessionID)
      if (messages) {
        this.#messages.set(sessionID, messages.filter((message) => !discarded.has(message.info.id)))
      }
      this.#emit("message.updated", sessionID)
    }
    this.#turnGenerations.set(sessionID, (this.#turnGenerations.get(sessionID) ?? 0) + 1)
    this.#cancelledSessions.add(sessionID)
    this.#active.delete(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    // A cancelled turn gets no closing tool_call_update at all, so settle before it is published.
    this.#settleActivity(sessionID)
    this.#acp.notify("session/cancel", { sessionId: sessionID })
    this.#emit("session.updated", sessionID)
    this.#persistSnapshot(sessionID)
  }

  status(sessionID) {
    return { type: this.#isBusy(sessionID) ? "busy" : "idle" }
  }

  async flushSnapshots() {
    while (this.#snapshotWrites.size > 0) {
      await Promise.all(this.#snapshotWrites.values())
    }
    await this.#deletedSessionIndexWrite
  }

  /**
   * Return the lightweight deletion tombstones used by Session-first discovery.
   *
   * The Session list deliberately avoids restoring every transcript snapshot because doing so can
   * retain gigabytes of historical messages. Deletion therefore has its own tiny index: one read
   * per process, no session/load, no history loader, and no ACP ownership changes.
   */
  async deletedSessionIDs() {
    await this.#restoreDeletedSessionIndex()
    return new Set(this.#deletedSessions)
  }

  #deletedSessionIndexPath() {
    return path.join(this.#snapshotDirectory, "deleted-sessions.json")
  }

  async #restoreDeletedSessionIndex() {
    if (!this.#snapshotDirectory || this.#deletedSessionIndexLoaded) return
    this.#deletedSessionIndexLoaded = true
    try {
      const state = JSON.parse(await readFile(this.#deletedSessionIndexPath(), "utf8"))
      if (state?.version !== 1 || !Array.isArray(state.sessionIDs)) return
      for (const sessionID of state.sessionIDs) {
        if (typeof sessionID === "string" && sessionID) this.#deletedSessions.add(sessionID)
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.#deletedSessionIndexLoaded = false
        throw error
      }
    }
  }

  async #persistDeletedSessionIndex() {
    if (!this.#snapshotDirectory) return
    const previous = this.#deletedSessionIndexWrite
    const writing = previous.catch(() => undefined).then(async () => {
      await mkdir(this.#snapshotDirectory, { recursive: true })
      const target = this.#deletedSessionIndexPath()
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      const state = JSON.stringify({
        version: 1,
        sessionIDs: [...this.#deletedSessions].sort()
      })
      await writeFile(temporary, state, { mode: 0o600 })
      await rename(temporary, target)
    })
    this.#deletedSessionIndexWrite = writing
    await writing
  }

  #snapshotPath(sessionID) {
    const name = Buffer.from(sessionID).toString("base64url")
    return path.join(this.#snapshotDirectory, `${name}.json`)
  }

  async #restoreSnapshot(sessionID) {
    if (!this.#snapshotDirectory || this.#restoredSnapshots.has(sessionID)) return
    this.#restoredSnapshots.add(sessionID)
    try {
      const snapshot = JSON.parse(await readFile(this.#snapshotPath(sessionID), "utf8"))
      if (snapshot?.version !== 1) return
      if (Array.isArray(snapshot.messages)) {
        const fragmented = mergeFragmentedPiSnapshot(snapshot.messages)
        const restored = healPoisonedSnapshot(fragmented)
        if (restored.length !== fragmented.length) {
          this.#dirtySnapshots.add(sessionID)
          this.#dirtyStart.set(sessionID, Date.now())
        }
        // A snapshot written mid-turn keeps that turn's open tool calls at `running`. The turn did
        // not survive the restart, so reopening the Session must not present them as live work; the
        // rewrite is left to the next persist rather than forcing one on every restore.
        if (settleUnfinishedActivity(restored, { historical: true })) {
          this.#dirtySnapshots.add(sessionID)
          this.#dirtyStart.set(sessionID, Date.now())
        }
        this.#messages.set(sessionID, restored)
      }
      if (Array.isArray(snapshot.todos)) this.#todos.set(sessionID, snapshot.todos)
      if (!this.#preferListedTitles && typeof snapshot.title === "string" && snapshot.title) this.#titles.set(sessionID, snapshot.title)
      if (snapshot?.deleted === true) this.#deletedSessions.add(sessionID)
    } catch (error) {
      if (error?.code !== "ENOENT") this.#emit("session.error", sessionID, { message: "Stored session snapshot is unreadable" })
    }
  }

  #withFsTimeout(promise, ms = 5000) {
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Filesystem operation timed out after ${ms}ms`)
        error.code = "FS_TIMEOUT"
        reject(error)
      }, ms)
    })
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
  }

  #persistSnapshot(sessionID) {
    if (!this.#snapshotDirectory) return
    this.#dirtySnapshots.add(sessionID)
    this.#dirtyStart.set(sessionID, Date.now())
    if (this.#snapshotWrites.has(sessionID)) return
    this.#snapshotWriteStart.set(sessionID, Date.now())
    const writing = (async () => {
      await this.#withFsTimeout(mkdir(this.#snapshotDirectory, { recursive: true }))
      while (this.#dirtySnapshots.delete(sessionID)) {
        this.#dirtyStart.delete(sessionID)
        // A transcript the journal can rebuild is not written into the snapshot: the snapshot would
        // only be able to restore it under this process's own ids, and the next read replaces it
        // from the journal anyway. That covers a harness whose journal is authoritative, a Session
        // this bridge does not write, and a harness whose stream only ever seeds from the journal.
        const journalOwnsTranscript = Boolean(
          this.#historyLoader
          && (this.#historyLoader.authoritativeHistory || this.#journalBacked(sessionID) || this.#journalSeedsOwnedTranscript())
        )
        const cachedMessages = this.#messages.get(sessionID) ?? []
        const healedMessages = healPoisonedSnapshot(cachedMessages)
        if (healedMessages !== cachedMessages) this.#messages.set(sessionID, healedMessages)
        const snapshot = JSON.stringify({
          version: 1,
          messages: journalOwnsTranscript ? [] : healedMessages,
          todos: this.#todos.get(sessionID) ?? [],
          title: this.#titleFor(sessionID),
          deleted: this.#deletedSessions.has(sessionID)
        })
        const target = this.#snapshotPath(sessionID)
        let temporary
        try {
          temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
          await this.#withFsTimeout(writeFile(temporary, snapshot, { mode: 0o600 }))
          await this.#withFsTimeout(rename(temporary, target))
          temporary = undefined
        } finally {
          if (temporary) unlink(temporary).catch(() => {})
        }
      }
    })().catch((error) => {
      if (error?.code !== "FS_TIMEOUT") {
        this.#dirtySnapshots.delete(sessionID)
        this.#dirtyStart.delete(sessionID)
      }
      this.#emit("session.error", sessionID, { message: "Session snapshot could not be saved" })
    }).finally(() => {
      this.#snapshotWrites.delete(sessionID)
      this.#snapshotWriteStart.delete(sessionID)
    })
    this.#snapshotWrites.set(sessionID, writing)
  }

  /** A queued prompt is still outstanding work, so the session must not read as idle between turns. */
  #isBusy(sessionID) {
    return this.#active.has(sessionID) || Boolean(this.#queues.get(sessionID)?.length)
  }

  /**
   * Close the session's still-open activity, which is only ever correct while no turn of its own is
   * live — see settleUnfinishedActivity. Silent while a replay is still being assembled: that path
   * publishes the transcript itself once it is whole.
   */
  #settleActivity(sessionID, { emit = true, historical = false } = {}) {
    if (this.#active.has(sessionID)) return 0
    const settled = settleUnfinishedActivity(this.#messages.get(sessionID) ?? [], { historical })
    if (settled && emit) this.#emit("message.updated", sessionID)
    return settled
  }

  /**
   * The status layer in front of this service can establish that a Session is idle while the service
   * still holds its own busy flag — Claude's adapter leaves that flag set when it stops answering a
   * turn it never finished. The transcript must not contradict that conclusion: a Session presented
   * as idle cannot keep an Activity section on Working, so whoever corrects the status settles the
   * activity the abandoned turn left open through here. A tool_call_update that does arrive later
   * still overwrites the part, so this can only ever be as premature as the status it follows.
   */
  settleReportedIdleActivity(sessionID) {
    const settled = settleUnfinishedActivity(this.#messages.get(sessionID) ?? [])
    if (!settled) return 0
    this.#emit("message.updated", sessionID)
    this.#persistSnapshot(sessionID)
    return settled
  }

  /**
   * Displaying an external session deliberately skips the ACP load, but config options only
   * arrive with it, so a session this process did not create reported no models at all — and
   * model switching failed too, since it validates against that list. Pay for the load only
   * when the options are genuinely missing, which keeps opening a session cheap.
   */
  async #loadForConfigOptions(sessionID) {
    await this.#load(sessionID)
    if (this.#configOptions.has(sessionID)) return
    await this.#load(sessionID, true, true)
  }

  async #requireSession(sessionID) {
    await this.#restoreDeletedSessionIndex()
    await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    if (this.#deletedSessions.has(sessionID) || !this.#sessions.has(sessionID)) {
      throw new Error("Harness session not found")
    }
  }

  async #load(sessionID, force = false, requireConfigOptions = false) {
    if (!this.#sessions.has(sessionID)) await this.listSessions()
    if (this.#deletedSessions.has(sessionID)) throw new Error("Harness session not found")
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error("Harness session not found")
    if (!force && this.#loaded.has(sessionID)) return
    // Config options only arrive with a real ACP session/load, which a harness may refuse —
    // Codex does for any conversation another client holds open. Sharing one in-flight load
    // between callers that need those options and callers that only want the transcript meant
    // the refusal failed `messages` too, so opening such a session broke whenever the app asked
    // for both at once, which it does on every open. Each kind of load is tracked separately,
    // and a caller that never needed the options retries on its own rather than inheriting a
    // failure that does not apply to it.
    // Two loads must never overlap on one session even when they want different things: both blank
    // #messages before replaying and then merge the replay back into what they captured first, so
    // whichever finishes last wins and a caller that only asked for the transcript can read a
    // half-rebuilt history. A load that needs the options therefore waits for a transcript-only
    // load to settle instead of running beside it.
    for (let inFlight = this.#loads.get(sessionID); inFlight; inFlight = this.#loads.get(sessionID)) {
      if (inFlight.requireConfigOptions || !requireConfigOptions) {
        try {
          await inFlight.promise
          return
        } catch (error) {
          if (requireConfigOptions || !inFlight.requireConfigOptions) throw error
        }
        break
      }
      await inFlight.promise.catch(() => undefined)
      if (this.#loads.get(sessionID) === inFlight) break
    }
    const promise = this.#loadSession(sessionID, requireConfigOptions)
    this.#loads.set(sessionID, { promise, requireConfigOptions })
    try {
      await promise
    } finally {
      if (this.#loads.get(sessionID)?.promise === promise) this.#loads.delete(sessionID)
    }
  }

  async #loadSession(sessionID, requireConfigOptions = false, replaceHistory = false) {
    const session = this.#sessions.get(sessionID)
    if (!session) throw new Error("Harness session not found")
    await this.#restoreSnapshot(sessionID)
    const authoritativeState = await this.#refreshActionState(sessionID, false)
    let previousMessages = mergeFragmentedPiSnapshot(this.#messages.get(sessionID) ?? [])
    const previousTodos = this.#todos.get(sessionID) ?? []
    const previousMessageSnapshot = semanticHistorySignature(previousMessages)
    if (this.#historyLoader) {
      try {
        const persistedMessages = await this.#historyLoader(sessionID, {
          activeSessionLeaf: authoritativeState?.activeSessionLeaf
        })
        if (this.#journalSeedsOwnedTranscript()) {
          // The journal is the whole conversation while nothing here is writing it, and the seed
          // for the stream once something is. Merging the two would union two id spaces for the
          // same messages, which is exactly what the single-source page rule above avoids, so the
          // journal is taken whole or not at all:
          //  - while it is the authority, on every read;
          //  - once more as this bridge takes the writer, so the last thing the harness wrote on
          //    its own is not missed;
          //  - when the caller says the branch itself changed, which is what an undo or redo is;
          //  - and to refill a transcript the cache dropped, which would otherwise read as empty.
          const seedFromJournal = this.#journalBacked(sessionID)
            || replaceHistory
            || !this.#acpOpenSessions.has(sessionID)
            || previousMessages.length === 0
          if (seedFromJournal) {
            previousMessages = mergeFragmentedPiSnapshot(persistedMessages)
            this.#messages.set(sessionID, previousMessages)
          }
          if (this.#journalBacked(sessionID) && !requireConfigOptions) {
            this.#todos.set(sessionID, [])
            this.#loaded.add(sessionID)
            this.#persistSnapshot(sessionID)
            return
          }
        } else if (persistedMessages.length > 0 || authoritativeState) {
          previousMessages = authoritativeState
            ? persistedMessages
            : mergeExternalHistory(persistedMessages, previousMessages)
          previousMessages = mergeFragmentedPiSnapshot(previousMessages)
          this.#messages.set(sessionID, previousMessages)
          if (this.#journalBacked(sessionID) && !requireConfigOptions) {
            this.#todos.set(sessionID, [])
            this.#loaded.add(sessionID)
            this.#persistSnapshot(sessionID)
            return
          }
        }
      } catch (error) {
        this.#emit("session.error", sessionID, { message: "Harness session history could not be read" })
        // A harness whose ACP load is a replay has no second source to fall back on, so an
        // unreadable journal has to be reported as a failed read. Answering with an empty
        // transcript instead is how a Session that is merely unreadable came to look deleted.
        if (this.#historyLoader.journalOnly === true) {
          this.#messages.set(sessionID, previousMessages)
          this.#todos.set(sessionID, previousTodos)
          throw error
        }
      }
    }
    if (await this.#openWithoutReplay(sessionID, session)) return
    this.#replaying.add(sessionID)
    this.#messages.set(sessionID, [])
    this.#todos.set(sessionID, [])
    this.#chunkMessageIDs.delete(`${sessionID}:user`)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    try {
      const result = await this.#acp.request("session/load", { sessionId: sessionID, cwd: session.cwd, mcpServers: [] }, 300_000)
      this.#acpOpenSessions.add(sessionID)
      if (this.#historyLoader?.claimOnLoad) this.#ownedSessions.add(sessionID)
      // PI can resolve session/load just before its final replay notifications drain from stdout,
      // especially through the Windows cmd/npx pipe. Profiles can opt into a short replay tail so
      // those assistant chunks remain historical output instead of being rejected as unsolicited
      // live output. Other ACP harnesses keep the zero-delay default.
      if (this.#replaySettleMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.#replaySettleMs))
      }
      this.#rememberConfigOptions(sessionID, result.configOptions)
      const replayedMessages = mergeFragmentedPiSnapshot(this.#messages.get(sessionID) ?? [])
      this.#messages.set(sessionID, replaceHistory ? replayedMessages : mergeReplay(previousMessages, replayedMessages))
      // Replayed history is finished work by definition, and the adapter does not always close the
      // tool calls in it. Settling before the signature check keeps the restored (already settled)
      // snapshot and this replay comparable, so an unchanged history still reads as unchanged.
      this.#settleActivity(sessionID, { emit: false, historical: true })
      const replayedTodos = this.#todos.get(sessionID) ?? []
      this.#todos.set(sessionID, replaceHistory ? replayedTodos : mergeTodos(previousTodos, replayedTodos))
      if (semanticHistorySignature(this.#messages.get(sessionID) ?? []) !== previousMessageSnapshot) {
        this.#resetActionsForSessionChange(sessionID)
      }
      this.#loaded.add(sessionID)
      this.#persistSnapshot(sessionID)
    } catch (error) {
      this.#messages.set(sessionID, previousMessages)
      this.#todos.set(sessionID, previousTodos)
      throw error
    } finally {
      this.#replaying.delete(sessionID)
    }
  }

  /**
   * Whether the journal seeds this harness's owned transcript instead of being merged into it.
   *
   * True for exactly the harnesses that opted out of journal paging while owned: those are the ones
   * whose journal ids and stream ids are different identities for the same message, so the two are
   * used one after the other - journal until this bridge starts writing, its own stream from then
   * on - rather than reconciled against each other on every read.
   */
  #journalSeedsOwnedTranscript() {
    return this.#historyLoader?.authoritativeHistory !== true && !this.#journalPageWhileOwned
  }

  /**
   * Open one stored Session on the ACP connection without asking for its transcript back.
   *
   * `session/load` is defined to replay: OMP answers it by re-emitting every stored message as a
   * notification under a freshly minted id, including the developer, hook and tool-output records
   * it flattens into `user_message_chunk`s. For a Session whose transcript already came from the
   * journal that replay is pure cost - minutes of notifications on a long conversation - and pure
   * harm, because the ids it invents do not match the ones the app was just given, and the
   * pseudo-user messages in it are not turns anyone typed.
   *
   * ACP's own answer to this is `session/resume`, which opens the same stored Session and returns
   * the same `configOptions` with no replay at all. It is used only when the running adapter
   * advertised it, so an older build of the same harness still opens through `session/load`.
   */
  async #openWithoutReplay(sessionID, session) {
    if (!this.#journalSeedsOwnedTranscript()) return false
    if (!this.#acp.sessionCapabilities?.resume) return false
    const result = await this.#acp.request(
      "session/resume",
      { sessionId: sessionID, cwd: session.cwd, mcpServers: [] },
      300_000
    )
    this.#acpOpenSessions.add(sessionID)
    this.#rememberConfigOptions(sessionID, result?.configOptions)
    this.#loaded.add(sessionID)
    this.#persistSnapshot(sessionID)
    return true
  }

  async #refreshSessions() {
    if (!this.#sessionListing) {
      this.#sessionListing = this.#acp.listSessions().then((sessions) => {
        const listed = new Set()
        const refreshed = sessions.map((session) => {
          listed.add(session.sessionId)
          const known = this.#sessions.get(session.sessionId)
          const updatedAt = this.#preserveListedTimestamps && known?.updatedAt
            ? known.updatedAt
            : session.updatedAt ?? known?.updatedAt ?? new Date().toISOString()
          const normalized = { ...session, updatedAt }
          this.#sessions.set(normalized.sessionId, normalized)
          return normalized
        })
        for (const [sessionID, session] of this.#sessions) {
          if (this.#ownedSessions.has(sessionID) && !listed.has(sessionID)) refreshed.push(session)
        }
        return refreshed
      }).finally(() => {
        this.#sessionListing = undefined
      })
    }
    return this.#sessionListing
  }

  #rememberConfigOptions(sessionID, configOptions) {
    if (Array.isArray(configOptions)) this.#configOptions.set(sessionID, configOptions)
  }

  #recordPrompt(sessionID, text, attachments = []) {
    const messageID = randomUUID()
    const messages = this.#messages.get(sessionID) ?? []
    this.#messages.set(sessionID, messages)
    messages.push({
      info: { id: messageID, role: "user", sessionID, time: { created: Date.now() } },
      parts: [
        { id: `${messageID}:text`, type: "text", text },
        ...attachments.map((attachment, index) => ({
          id: `${messageID}:file:${index}`,
          type: "file",
          mime: attachment.mime,
          filename: attachment.filename,
          url: `data:${attachment.mime};base64,${attachment.data}`
        }))
      ]
    })
    this.#promptAcknowledgements.set(sessionID, { text, received: "" })
    this.#emit("message.updated", sessionID)
    this.#persistSnapshot(sessionID)
    return messageID
  }

  /**
   * ACP session listings may carry no title, so keep the creation title or derive one from the
   * first prompt.
   *
   * A title held here is one someone set and the harness could not be asked to store - every path
   * that does hand the name to the harness drops it again, so the listing stays the authority in
   * the normal case. Until then it outranks the listing, otherwise renaming a Session on a harness
   * that cannot store names would appear to do nothing at all.
   */
  #titleFor(sessionID) {
    const known = this.#titles.get(sessionID)
    if (known) return known
    const listed = this.#sessions.get(sessionID)?.title?.trim()
    if (this.#preferListedTitles && listed) return listed
    const firstPrompt = this.#messages.get(sessionID)?.find((message) => message.info.role === "user")
    const text = firstPrompt?.parts?.[0]?.text?.trim()
    if (!text) return undefined
    return text.split("\n")[0].slice(0, 60)
  }

  #isAcknowledgedPromptChunk(sessionID, text) {
    const acknowledgement = this.#promptAcknowledgements.get(sessionID)
    if (!acknowledgement) return false
    const received = acknowledgement.received + text
    if (!acknowledgement.text.startsWith(received)) return false
    acknowledgement.received = received
    if (received === acknowledgement.text) this.#promptAcknowledgements.delete(sessionID)
    return true
  }

  #handleNotification({ method, params }) {
    if (method !== "session/update" || !params?.sessionId || !params.update) return
    const { sessionId, update } = params
    const replaying = this.#replaying.has(sessionId)
    const session = this.#sessions.get(sessionId)
    if (update.sessionUpdate === "available_commands_update") {
      const commands = Array.isArray(update.availableCommands)
        ? update.availableCommands.filter((command) => typeof command?.name === "string")
        : []
      this.#commandCatalogs.set(sessionId, commands)
      for (const resolve of this.#commandCatalogWaiters.get(sessionId) ?? []) resolve()
      this.#commandCatalogWaiters.delete(sessionId)
      if (!replaying) this.#emit("session.updated", sessionId)
      return
    }
    if (update.sessionUpdate === "plan") {
      const todos = update.entries.map((entry, index) => ({
        id: `${sessionId}:${index}`,
        content: entry.content,
        status: entry.status,
        priority: entry.priority ?? "medium"
      }))
      this.#todos.set(sessionId, todos)
      if (!replaying && session) session.updatedAt = new Date().toISOString()
      if (!replaying) this.#emit("todo.updated", sessionId)
      if (!replaying) this.#persistSnapshot(sessionId)
      return
    }
    if (update.sessionUpdate === "tool_call") {
      if (!replaying && (!this.#active.has(sessionId) || this.#cancelledSessions.has(sessionId))) return
      const chunkKey = `${sessionId}:assistant`
      const messageID = this.#chunkMessageIDs.get(chunkKey) ?? randomUUID()
      this.#chunkMessageIDs.set(chunkKey, messageID)
      const messages = this.#messages.get(sessionId) ?? []
      this.#messages.set(sessionId, messages)
      let message = messages.find((item) => item.info.id === messageID)
      if (!message) {
        message = {
          info: { id: messageID, role: "assistant", sessionID: sessionId, time: { created: Date.now() } },
          parts: []
        }
        messages.push(message)
      }
      // A reasoning part is closed by the part that follows it, but only the message-chunk path did
      // that: reasoning followed by a tool call — Claude's normal shape — stayed open forever, which
      // is enough on its own to keep that Activity section reading Working after the turn ended.
      const openReasoning = message.parts.at(-1)
      if (openReasoning?.type === "reasoning" && openReasoning.time && !openReasoning.time.end) {
        openReasoning.time.end = Date.now()
      }
      message.parts.push({
        id: update.toolCallId,
        messageID,
        type: "tool",
        tool: update._meta?.toolName ?? update.title,
        callID: update.toolCallId,
        state: {
          status: update.status === "in_progress" ? "running" : update.status,
          input: update.rawInput,
          title: update.title,
          time: { start: Date.now() }
        }
      })
      if (!replaying) this.#emit("message.updated", sessionId)
      return
    }
    if (update.sessionUpdate === "tool_call_update") {
      const tool = (this.#messages.get(sessionId) ?? [])
        .flatMap((message) => message.parts)
        .find((part) => part.type === "tool" && part.callID === update.toolCallId)
      if (!tool?.state) return
      const output = update.rawOutput ?? update.content
        ?.flatMap((item) => item.type === "content" && item.content?.type === "text" ? [item.content.text] : [])
        .join("")
      tool.state.status = update.status === "in_progress" ? "running" : update.status === "failed" ? "error" : update.status
      if (output) tool.state.output = typeof output === "string" ? output : JSON.stringify(output)
      if (tool.state.time && ["completed", "error"].includes(tool.state.status)) tool.state.time.end = Date.now()
      if (!replaying) this.#emit("message.updated", sessionId)
      return
    }
    const thought = update.sessionUpdate === "agent_thought_chunk"
    const messageChunk = update.sessionUpdate === "user_message_chunk" || update.sessionUpdate === "agent_message_chunk"
    if (!thought && !messageChunk) return
    // A replayed image becomes a file part, so reopening a session still shows what was attached.
    // Replay only: a live turn already recorded its own attachment in #recordPrompt, so accepting an
    // image chunk there would draw the same thumbnail twice. OMP is not observed to echo a live
    // prompt back (see docs/DEPENDENCIES.md), which makes this a guard rather than a workaround.
    const image = replaying
      && messageChunk
      && update.content?.type === "image"
      && typeof update.content.data === "string"
      && update.content.data
      ? {
        mime: typeof update.content.mimeType === "string" && update.content.mimeType ? update.content.mimeType : "image/png",
        data: update.content.data
      }
      : undefined
    if (!image && (update.content?.type !== "text" || !update.content.text)) return
    const role = update.sessionUpdate === "user_message_chunk" ? "user" : "assistant"
    const partType = thought ? "reasoning" : image ? "file" : "text"
    // Acknowledgements only suppress a live echo of the prompt we just recorded;
    if (role === "assistant" && !replaying && this.#cancelledSessions.has(sessionId)) return
    if (role === "assistant" && !replaying && !this.#active.has(sessionId) && !this.#promptedSessions.has(sessionId)) return
    if (role === "user" && !replaying && this.#isAcknowledgedPromptChunk(sessionId, update.content.text)) return
    if (role === "user" && !image && isHarnessInjectedText(update.content.text)) return
    if (!replaying && session) session.updatedAt = new Date().toISOString()
    const counterpartKey = `${sessionId}:${role === "user" ? "assistant" : "user"}`
    this.#chunkMessageIDs.delete(counterpartKey)
    const chunkKey = `${sessionId}:${role}`
    // PI sends a new message id for every streaming fragment. During a live turn the bridge's
    // id is authoritative, so all adjacent fragments remain one Markdown message. Replay keeps
    // adapter ids because it reconstructs historical conversation boundaries.
    const messageID = !replaying && role === "assistant"
      ? this.#chunkMessageIDs.get(chunkKey) ?? update.messageId ?? randomUUID()
      : update.messageId ?? this.#chunkMessageIDs.get(chunkKey) ?? randomUUID()
    this.#chunkMessageIDs.set(chunkKey, messageID)
    const messages = this.#messages.get(sessionId) ?? []
    this.#messages.set(sessionId, messages)
    let message = messages.find((item) => item.info.id === messageID)
    if (!message) {
      message = {
        info: { id: messageID, role, sessionID: sessionId, time: { created: Date.now() } },
        parts: []
      }
      messages.push(message)
    }
    const previous = message.parts.at(-1)
    const now = Date.now()
    if (previous?.type === "reasoning" && partType !== "reasoning" && previous.time && !previous.time.end) {
      previous.time.end = now
    }
    if (image) {
      message.parts.push({
        id: `${messageID}:file:${message.parts.length}`,
        messageID,
        type: "file",
        mime: image.mime,
        url: `data:${image.mime};base64,${image.data}`
      })
    } else if (previous?.type === partType) {
      previous.text += update.content.text
    } else {
      message.parts.push({
        id: `${messageID}:${partType}:${message.parts.length}`,
        messageID,
        type: partType,
        text: update.content.text,
        ...(partType === "reasoning" ? { time: { start: now } } : {})
      })
    }
    if (!replaying) this.#emit("message.updated", sessionId)
  }

  #emit(type, sessionId, extra = {}) {
    const event = { type, sessionId, ...extra }
    for (const listener of this.#listeners) listener(event)
  }
}
