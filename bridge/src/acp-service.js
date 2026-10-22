import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { selectableAcpModelValue, modelConfigOptionFromSessionResponse, modelValueIsExcluded, normalizedAcpModelCandidates, splitInlineAcpModelVariant } from "./agent-model-catalog.js"
import { TranscriptCache } from "./transcript-cache.js"
import { stripAmbientContext } from "./ambient-context.js"
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

function missingAcpSession(error) {
  if (error?.code === "session_unavailable") return true
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /\bsession\b.{0,180}\b(not found|unknown|unavailable|does not exist|no longer exists)\b/i.test(message)
}

/**
 * The adapter method that takes new input while a turn is running. Codex's official adapter
 * documents `_session/steering` as "delivers a steering prompt to the session: injects it into the
 * live turn when there is one, otherwise starts a new turn", and responding `{outcome:
 * "injected"}` or `{outcome: "startedNewTurn"}` resolves that request. A plain `session/prompt`
 * sent while a turn is running is not a supported alternative: it replaces the session's tracked
 * active prompt, which can make the adapter interrupt the late-started turn it was still holding.
 */
const STEERING_METHOD = "_session/steering"

const MID_TURN_PROMPT_POLICIES = new Set(["queue", "steer"])

/** A prompt that opens with a slash is a harness command, and those must run as their own turn. */
const SLASH_PROMPT = /^\/[^\s/]/

/**
 * An adopted steering turn made the adapter itself start a turn without a session/prompt response
 * this bridge could await, so only its own stream proves it ended. Settle it after this much
 * streamed silence; the same generation guard `#settleTurn` applies to normal turns also lets a
 * later session/prompt or Stop supersede the sweep.
 */
const STEER_ADOPT_SETTLE_IDLE_MS = 90_000
const STEER_ADOPT_SWEEP_INTERVAL_MS = 10_000

/**
 * Claude Code wakes its model on its own when a background command, subagent or monitor finishes,
 * and the adapter streams that turn with no session/prompt behind it. Such a turn is adopted the
 * same way as a steering turn, but settles sooner: it is usually a short report. A tool call it
 * still has running holds it open, up to the hard cap.
 */
const AGENT_TURN_SETTLE_IDLE_MS = 30_000
const AGENT_TURN_RUNNING_TOOL_CAP_MS = 10 * 60_000
/**
 * Zero-drain adapters deliver the tail of a turn just after its session/prompt response. Output
 * that close to the end still belongs to the turn that ended, not to one the agent started.
 */
const AGENT_TURN_GRACE_MS = 2_000

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

/**
 * Keep replayed creation times in transcript order.
 *
 * A replay mixes two clocks: messages this bridge already knew keep their recorded time, while
 * the ones ACP replays without a timestamp are stamped with the moment of the reload. Clients order
 * turns by that time, so a user-role message first seen on replay — Claude Code's interruption
 * marker, written mid-turn and never streamed live — moved past every later prompt and appeared at
 * the bottom of a Session that had finished normally. Walking backward, a message may not claim the
 * time of the message after it or a later one; known times are never moved forward. A moved time is
 * strictly earlier, because clients break equal times by id, which says nothing about order.
 */
export function chronologicalReplay(messages) {
  let ceiling = Number.POSITIVE_INFINITY
  const ordered = new Array(messages.length)
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    const created = Number(message?.info?.time?.created)
    if (!Number.isFinite(created) || created <= 0) {
      ordered[index] = message
      continue
    }
    if (created >= ceiling) {
      ceiling -= 1
      ordered[index] = { ...message, info: { ...message.info, time: { ...message.info.time, created: ceiling } } }
      continue
    }
    ordered[index] = message
    ceiling = created
  }
  return ordered
}

function authoritativeReplay(previous, replayed) {
  // ACP replay can omit timestamps and mint fresh ids. Retain known identities for unchanged
  // occurrences, while the native replay alone decides content, membership and order.
  const priorBySignature = new Map()
  for (const message of previous) {
    const signature = messageSignature(message)
    const matches = priorBySignature.get(signature) ?? []
    matches.push(message)
    priorBySignature.set(signature, matches)
  }
  return replayed.map((message) => {
    const prior = priorBySignature.get(messageSignature(message))?.shift()
    if (!prior) return message
    return {
      ...message,
      // A live Stop is recorded only here; a harness that journals no interruption must not erase it.
      info: { ...message.info, id: prior.info.id, time: prior.info.time, ...(prior.info.interrupted ? { interrupted: true } : {}) },
      parts: message.parts.map((part) => ({ ...part, ...(part.messageID ? { messageID: prior.info.id } : {}) }))
    }
  })
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

/**
 * Claude Code records a cancelled turn as a plain user-role marker: for a Stop, and for a message
 * sent while a turn was running. Shown as is, it reads as text the user typed. It is a fact about the
 * turn before it, so the transcript carries it as `info.interrupted` on that turn's reply instead -
 * the same flag a live Stop and the OMP/PI journal aborts produce. Matched exactly, so a message that
 * quotes the marker stays an ordinary message.
 */
const INTERRUPTION_MARKER = /^\s*\[Request interrupted by user(?: for tool use)?\]\s*$/

export function isInterruptionMarker(text) {
  return INTERRUPTION_MARKER.test(text)
}

/** Flag the reply of the newest turn as interrupted, adding an empty reply when it had none yet. */
export function markLatestTurnInterrupted(messages, sessionID, created = Date.now()) {
  let lastUser = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.info?.role === "user") {
      lastUser = index
      break
    }
  }
  if (lastUser < 0) return false
  for (let index = messages.length - 1; index > lastUser; index -= 1) {
    if (messages[index]?.info?.role !== "assistant") continue
    messages[index] = { ...messages[index], info: { ...messages[index].info, interrupted: true } }
    return true
  }
  messages.push({ info: { id: randomUUID(), role: "assistant", sessionID, time: { created }, interrupted: true }, parts: [] })
  return true
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
      this.#chunkSourceIDs.delete(sessionID)
      this.#turnGenerations.delete(sessionID)
      this.#turnSettledAt.delete(sessionID)
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
  #modelSwitchMethods = new Map()
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
  #titleIndexLoaded = false
  #titleIndexLoading
  #titleIndexWrite = Promise.resolve()
  #deletedSessions = new Set()
  #deletedSessionIndexLoaded = false
  #deletedSessionIndexWrite = Promise.resolve()
  #queues = new Map()
  #active = new Set()
  #listeners = new Set()
  #turnGenerations = new Map()
  // Turns the adapter runs without a session/prompt this bridge awaits: a steering prompt it started
  // as a turn of its own (see `#steerPrompt`), or a turn the agent started itself (see
  // `#adoptAgentTurn`). Only their own stream going silent ends them.
  #adoptedTurns = new Map()
  #adoptedTurnSweep
  #turnSettledAt = new Map()
  #agentTurnSettleIdleMs
  #agentTurnGraceMs
  #promptGates = new Map()
  #midTurnPrompt
  #cancelledSessions = new Set()
  #promptedSessions = new Set()
  #chunkMessageIDs = new Map()
  // PI's journal is authoritative, but a provider rejection can be emitted by ACP before the journal
  // has flushed its terminal assistant error. These ids keep only that short-lived bridge copy alive.
  #transientFailureMessageIDs = new Map()
  #snapshotDirectory
  #restoredSnapshots = new Map()
  #dirtySnapshots = new Set()
  #dirtyStart = new Map()
  #snapshotWrites = new Map()
  #snapshotWriteStart = new Map()
  #preserveListedTimestamps
  #reloadOnHistoryRefresh
  #replaySettleMs
  #promptSettleMs
  #preferListedTitles
  #nativeRenameCommand
  #journalPageWhileOwned
  #replayAuthoritative
  #replayUserChunksAreMessages
  #refreshSessionListOnRead
  #modelVariantConfigIDs
  #modelVariantDefaultValues
  #modelProviderID
  #excludedModelValuePrefixes
  #inlineModelVariantValues
  #modelProviderOrder
  #requireAssistantResponse
  #requireExistingDirectory
  #recoverMissingSessionOnPrompt
  #assistantMessageIDsSeparateReplies
  // The adapter's own message id behind the text most recently streamed into each live reply.
  #chunkSourceIDs = new Map()
  #turnResponseObserved = new Set()
  #fallbackModelCatalog
  #fallbackModelSelectionMethod
  #fallbackModelCommand
  #modelCommandReplies = new Map()
  #fallbackModelSelections = new Map()
  constructor(acp, {
    snapshotDirectory,
    historyLoader,
    preserveListedTimestamps = false,
    reloadOnHistoryRefresh = true,
    replaySettleMs = 0,
    // Some ACP adapters (PI in particular) acknowledge session/prompt before their final stdout
    // notifications have reached the bridge. Keep the turn live for this short drain window so a
    // late reasoning chunk is settled with the rest of the completed turn rather than becoming a
    // permanent Activity spinner.
    promptSettleMs = 0,
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
    /** A complete native ACP replay replaces cached partial turns rather than merging them. */
    replayAuthoritative = false,
    /** Copilot 1.0.97 replays one complete user message per notification, without message ids. */
    replayUserChunksAreMessages = false,
    /** Project-scoped indexes are paged separately; reads can use Sessions already observed there. */
    refreshSessionListOnRead = true,
    /**
     * Config-option ids this harness uses for the reasoning variant that belongs to a model.
     * Only used to report the Session's current selection; a variant is still applied against an
     * id the running adapter actually advertised.
     */
    modelVariantConfigIDs = [],
    modelVariantDefaultValues = [],
    modelProviderID,
    excludedModelValuePrefixes = [],
    inlineModelVariantValues = [],
    modelProviderOrder = [],
    requireAssistantResponse = false,
    requireExistingDirectory = false,
    recoverMissingSessionOnPrompt = false,
    /**
     * Whether a change of the adapter's `messageId` between live assistant chunks starts a new reply
     * paragraph. Claude stamps every chunk with the API message it belongs to, so a change marks a
     * reply that follows another with no tool call between them - the reply a resumed turn sends
     * after the one that said it would wait. PI mints a new id per fragment, so it must not opt in.
     */
    assistantMessageIDsSeparateReplies = false,
    /** Transport policy for a prompt that arrives while a turn is still running. */
    midTurnPrompt = "queue",
    /** Streamed silence after which a turn the agent started on its own is settled. */
    agentTurnSettleIdleMs = AGENT_TURN_SETTLE_IDLE_MS,
    /** How long after a turn ends its adapter's output still counts as that turn's tail. */
    agentTurnGraceMs = AGENT_TURN_GRACE_MS,
    fallbackModelCatalog,
    fallbackModelSelectionMethod,
    fallbackModelCommand,
    actionProviders = []
  } = {}) {
    this.#acp = acp
    this.#snapshotDirectory = snapshotDirectory
    this.#historyLoader = historyLoader
    this.#preserveListedTimestamps = preserveListedTimestamps
    this.#reloadOnHistoryRefresh = reloadOnHistoryRefresh
    this.#replaySettleMs = replaySettleMs
    this.#promptSettleMs = promptSettleMs
    this.#preferListedTitles = preferListedTitles
    this.#nativeRenameCommand = nativeRenameCommand
    this.#journalPageWhileOwned = journalPageWhileOwned
    this.#replayAuthoritative = replayAuthoritative
    this.#replayUserChunksAreMessages = replayUserChunksAreMessages
    this.#refreshSessionListOnRead = refreshSessionListOnRead
    this.#modelVariantConfigIDs = modelVariantConfigIDs
    this.#modelVariantDefaultValues = modelVariantDefaultValues
    this.#modelProviderID = modelProviderID
    this.#excludedModelValuePrefixes = excludedModelValuePrefixes
    this.#inlineModelVariantValues = inlineModelVariantValues
    this.#modelProviderOrder = modelProviderOrder
    this.#requireAssistantResponse = requireAssistantResponse
    this.#requireExistingDirectory = requireExistingDirectory
    this.#recoverMissingSessionOnPrompt = recoverMissingSessionOnPrompt
    this.#assistantMessageIDsSeparateReplies = assistantMessageIDsSeparateReplies
    this.#midTurnPrompt = MID_TURN_PROMPT_POLICIES.has(midTurnPrompt) ? midTurnPrompt : "queue"
    this.#agentTurnSettleIdleMs = agentTurnSettleIdleMs
    this.#agentTurnGraceMs = agentTurnGraceMs
    this.#fallbackModelCatalog = fallbackModelCatalog
    this.#fallbackModelSelectionMethod = fallbackModelSelectionMethod
    this.#fallbackModelCommand = fallbackModelCommand
    this.#actionProviders = actionProviders
    acp.on("notification", (notification) => this.#handleNotification(notification))
    acp.on("sessions-closed", (sessionIDs) => this.#forgetOpenSessions(sessionIDs))
    // An adapter that exits takes every Session it had open with it. Still counting them as loaded
    // sent the next prompt to a process that had never seen the Session, and the reload that its
    // "Session not found" then forced ran in the middle of that turn.
    acp.on?.("exit", () => this.#forgetOpenSessions([...this.#acpOpenSessions, ...this.#loaded]))
  }

  #forgetOpenSessions(sessionIDs) {
    for (const sessionID of sessionIDs) {
      this.#loaded.delete(sessionID)
      this.#acpOpenSessions.delete(sessionID)
      this.#configOptions.delete(sessionID)
    }
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
    await this.#restoreTitleIndex()
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

  /**
   * Seed lightweight ACP listing metadata without restoring a transcript snapshot.
   *
   * The paged Session index can reveal an older Session before any stable endpoint or mutation
   * addresses it. Remembering that metadata lets a later open/claim resolve the native identity
   * without turning every recurring index refresh into an eager walk of the full history.
   */
  rememberListedSessions(sessions) {
    return sessions.map((session) => {
      const known = this.#sessions.get(session.sessionId)
      const updatedAt = this.#preserveListedTimestamps && known?.updatedAt
        ? known.updatedAt
        : session.updatedAt ?? known?.updatedAt ?? new Date().toISOString()
      const normalized = { ...session, updatedAt }
      this.#sessions.set(normalized.sessionId, normalized)
      return normalized
    })
  }

  async createSession({ directory, title, model }) {
    await this.#restoreTitleIndex()
    await this.#acp.start()
    const result = await this.#acp.request("session/new", { cwd: directory, mcpServers: [] })
    this.#acpOpenSessions.add(result.sessionId)
    this.#rememberSessionConfiguration(result.sessionId, result)
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
      await this.#persistTitleIndex()
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
    await this.#restoreTitleIndex()
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
      await this.#persistTitleIndex()
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
      await this.#persistTitleIndex()
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
    await this.#persistTitleIndex()
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
      await this.#persistTitleIndex()
      await this.#refreshSessions()
    } catch {
      this.#titles.set(sessionID, title)
    }
  }

  async deleteSession(sessionID) {
    await this.#restoreTitleIndex()
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
    await this.#persistTitleIndex()
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
    this.#turnSettledAt.delete(sessionID)
    this.#chunkSourceIDs.delete(sessionID)
    this.#discardAdoptedTurn(sessionID)
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
    if (this.#refreshSessionListOnRead || !this.#sessions.has(sessionID)) await this.#refreshSessions()
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
        // A live PI turn already has a complete history seed plus its ACP stream. Its journal can
        // publish the final answer before the remaining ACP chunks drain, under different ids.
        // Unioning those sources makes both a partial and complete answer visible and can append
        // later deltas onto the journal copy. Keep the stream alone until this turn settles.
        const messages = this.#isBusy(sessionID)
          ? cachedMessages
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
          if (page && Array.isArray(page.messages)) {
            // Native exports can carry the same default-effort sentinel as ACP config options.
            // Normalize both read paths before the UI restores a model for the next prompt.
            if (this.#modelVariantDefaultValues.includes(page.model?.variant)) {
              const { variant, ...model } = page.model
              return { ...page, model }
            }
            return page
          }
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
    // A native journal, when present and used for paging, supplies its own model authority.
    // Journal-less ACP providers such as OpenCode 2 must expose session/load's config model.
    if (this.#historyLoader && this.#journalPageWhileOwned) return undefined
    const options = this.#configOptions.get(sessionID)
    const option = options?.find((item) => item.id === "model")
    const wireValue = option?.currentValue
    const inline = splitInlineAcpModelVariant(wireValue, option, this.#inlineModelVariantValues)
    const current = inline?.modelValue ?? wireValue
    if (typeof current !== "string") return this.#fallbackModelSelections.get(sessionID)
    const separator = current.indexOf("/")
    if (separator <= 0 && !this.#modelProviderID || separator === current.length - 1) return undefined
    // The reasoning variant belongs to the selection: reporting the model without it would let the
    // app carry the next turn on with the variant silently dropped.
    const selectedVariant = inline?.variant ?? this.#modelVariantConfigIDs
      .map((configId) => options?.find((item) => item.id === configId)?.currentValue)
      .find((value) => typeof value === "string" && value)
    const variant = this.#modelVariantDefaultValues.includes(selectedVariant) ? undefined : selectedVariant
    return {
      providerID: separator > 0 ? current.slice(0, separator) : this.#modelProviderID,
      modelID: separator > 0 ? current.slice(separator + 1) : current,
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
    if (this.#refreshSessionListOnRead || !this.#sessions.has(sessionID)) await this.#refreshSessions()
    await this.#restoreSnapshot(sessionID)
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) return []
    await this.#load(sessionID)
    return this.#todos.get(sessionID) ?? []
  }

  async models(sessionID) {
    await this.#loadForConfigOptions(sessionID)
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    if (!option && this.#fallbackModelCatalog) {
      const selected = this.#fallbackModelSelections.get(sessionID)
      const result = await this.#fallbackModelCatalog.list({ allowStale: false })
      return result.models.map((model) => ({ ...model, value: model.modelID, name: model.modelName, currentValue: selected?.modelID === model.modelID }))
    }
    return normalizedAcpModelCandidates(option, this.#excludedModelValuePrefixes, this.#inlineModelVariantValues, this.#modelProviderOrder)
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
    return this.#withNativeSession(sessionID, () => this.#applyModel(sessionID, model, variant))
  }

  async #applyModel(sessionID, model, variant) {
    await this.#loadForConfigOptions(sessionID)
    const option = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    if (!option && this.#fallbackModelCatalog && this.#fallbackModelSelectionMethod) {
      if (variant?.value) throw new Error("This harness does not advertise per-session model variants")
      const prefix = `${this.#modelProviderID}/`
      const modelID = model.startsWith(prefix) ? model.slice(prefix.length) : model
      const resolved = await this.#fallbackModelCatalog.resolve({ providerID: this.#modelProviderID, modelID })
      if (this.#fallbackModelCommand) {
        if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(resolved.modelID)) throw new Error("Invalid native model identifier")
        const commands = await this.commands(sessionID)
        if (!commands.some((command) => command.name === this.#fallbackModelCommand)) {
          throw new Error("The harness does not advertise its native model-selection command")
        }
        const reply = { chunks: [], configurationUpdated: false }
        this.#modelCommandReplies.set(sessionID, reply)
        try {
          const result = await this.#acp.request("session/prompt", {
            sessionId: sessionID,
            prompt: [{ type: "text", text: `/${this.#fallbackModelCommand} ${resolved.modelID}` }]
          })
          const text = reply.chunks.join("").trim()
          // Copilot sends an acknowledgement when changing models. An already selected model
          // produces only config_option_update and end_turn, as observed with CLI 1.0.97.
          const unchanged = !text && reply.configurationUpdated && result?.stopReason === "end_turn"
          if (!/Model changed to:/i.test(text) && !unchanged) throw new Error(text || "The harness did not confirm the selected model")
        } finally {
          this.#modelCommandReplies.delete(sessionID)
        }
      } else {
        await this.#acp.request(this.#fallbackModelSelectionMethod, { sessionId: sessionID, modelId: resolved.modelID })
      }
      // This is the last choice explicitly made in Harness Remote. Apply it again before each
      // continuation because this ACP server does not report its native current model.
      this.#fallbackModelSelections.set(sessionID, { providerID: resolved.providerID, modelID: resolved.modelID })
      this.#persistSnapshot(sessionID)
      return
    }
    // The app addresses models as `provider/model` because that is what OpenCode's API does, but a
    // harness whose ids carry no provider — Claude Code's `sonnet`, `opus[1m]` — is shown under the
    // backend's name to keep it consistent. Resolve against what the agent actually offered rather
    // than trusting either spelling: exact first, then the part after the synthesised provider.
    const separator = model.indexOf("/")
    const providerID = separator > 0 ? model.slice(0, separator) : ""
    const modelID = separator > 0 ? model.slice(separator + 1) : model
    let value = option?.options?.find((candidate) => candidate.value === model)?.value
      ?? option?.options?.find((candidate) => candidate.value === modelID)?.value
      ?? option?.options?.find((candidate) => selectableAcpModelValue(candidate.value, option, providerID) === modelID)?.value
    if (!value) throw new Error(`Harness model is not available: ${model}`)
    if (modelValueIsExcluded(value, this.#excludedModelValuePrefixes)) {
      const error = new Error(`Harness model is unavailable: ${model}`)
      error.code = "model_unavailable"
      throw error
    }
    const inlineVariant = variant?.configId === "model" && this.#inlineModelVariantValues.length > 0
    if (inlineVariant) {
      const candidate = option.options.find((item) => item.value === variant.value || item.value === `${value}/${variant.value}`)
      const selected = splitInlineAcpModelVariant(candidate?.value, option, this.#inlineModelVariantValues)
      if (!selected || selected.modelValue !== value) {
        const error = new Error(`Harness model variant is not available: ${variant.value}`)
        error.code = "model_variant_unavailable"
        throw error
      }
      value = selected.variantValue
    }
    // Continuing on the model the Session already holds is not a model change. Sending it anyway
    // made every prompt mutate the Session's configuration, which a harness is entitled to journal
    // and to announce - so simply carrying on read as though the user had switched models.
    if (option?.currentValue === value) {
      if (!inlineVariant) await this.#setModelVariant(sessionID, variant)
      return
    }
    const method = this.#modelSwitchMethods.get(sessionID) ?? "session/set_config_option"
    const changed = await this.#acp.request(method, method === "session/set_model"
      ? { sessionId: sessionID, modelId: value }
      : { sessionId: sessionID, configId: "model", value })
    // Adopt the options the adapter reports for the model it now holds. A harness whose dependent
    // controls differ per model - PI advertises a different thinkingLevel range for each one, from a
    // single `off` up to `max` - otherwise leaves this Session describing the previous model, so the
    // variant about to be applied would be checked against the wrong set of values.
    this.#rememberSessionConfiguration(sessionID, changed)
    const current = this.#configOptions.get(sessionID)?.find((item) => item.id === "model")
    if (current) current.currentValue = value
    else option.currentValue = value
    if (!inlineVariant) await this.#setModelVariant(sessionID, variant)
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
   * ACP accepts one turn per session at a time, so a prompt sent while the agent is still working
   * follows the harness's mid-turn policy: Codex forwards it into the live turn, where its official
   * adapter documents the injection, while every other harness queues it. It is recorded straight
   * away in every case; a queued prompt carries `info.queued` until it starts.
   *
   * Resolves with what happened to the prompt, so a client never has to infer it:
   * `{ disposition: "started" | "queued" | "steered", messageID }`.
   */
  async prompt(sessionID, text, model, attachments = [], variant) {
    return this.#serializePrompt(sessionID, () =>
      this.#withNativeSession(sessionID, () => this.#prompt(sessionID, text, model, attachments, variant)))
  }

  /**
   * One prompt enters a session at a time. A turn only reads as active once its model is applied and
   * `#startTurn` runs, so a second prompt arriving during the first one's load or model switch saw an
   * idle session and started a parallel session/prompt: OMP then ran both, the bridge tracked only
   * the later one, and the earlier reply was left hanging until the Session was reopened. Waiting here
   * lets the second prompt find the first turn active and take the queue or steering path.
   */
  #serializePrompt(sessionID, operation) {
    const previous = this.#promptGates.get(sessionID) ?? Promise.resolve()
    const run = previous.then(operation)
    const gate = run.then(() => {}, () => {})
    this.#promptGates.set(sessionID, gate)
    void gate.then(() => {
      if (this.#promptGates.get(sessionID) === gate) this.#promptGates.delete(sessionID)
    })
    return run
  }

  async #withNativeSession(sessionID, operation) {
    if (typeof this.#acp.withSession !== "function") return operation()
    if (!this.#sessions.has(sessionID)) await this.#refreshSessions()
    return this.#acp.withSession(sessionID, this.#sessions.get(sessionID)?.cwd, operation)
  }

  async #prompt(sessionID, text, model, attachments, variant) {
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
    await this.#requireSessionDirectory(this.#sessions.get(sessionID))
    this.#resetActionsForSessionChange(sessionID)
    // A non-empty queue without an active turn is a queued prompt applying its model before it
    // starts; a new prompt waits behind it rather than overtaking it.
    if (this.#active.has(sessionID) || this.#queues.get(sessionID)?.length) {
      if (this.#active.has(sessionID) && this.#midTurnPrompt === "steer" && !SLASH_PROMPT.test(text)) {
        // A harness that documents taking input while working gets the prompt immediately instead of
        // the queue. Slash commands must run as their own turn, so they keep the queue even here.
        return this.#steerPrompt(sessionID, text, attachments, variant)
      }
      // Not acknowledged yet: the running turn may still echo its own prompt, and this one reaches
      // the harness only when it is dequeued (see #startTurn).
      const messageID = this.#recordPrompt(sessionID, text, attachments, { queued: true })
      const queue = this.#queues.get(sessionID) ?? []
      queue.push({ text, model, messageID, attachments, variant })
      this.#queues.set(sessionID, queue)
      this.#emit("session.updated", sessionID)
      return { disposition: "queued", messageID }
    }
    const savedModel = this.#fallbackModelSelections.get(sessionID)
    const selection = model ?? (savedModel ? `${savedModel.providerID}/${savedModel.modelID}` : undefined)
    if (selection) await this.setModel(sessionID, selection, variant)
    return { disposition: "started", messageID: this.#startTurn(sessionID, text, false, attachments) }
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

  /** Returns the id of the recorded prompt when this call records it. */
  #startTurn(sessionID, text, recorded = false, attachments = []) {
    // From the first turn this bridge runs, its own stream is the live record for the session, the
    // same way taking ownership of an external session stops the journal being re-read for it.
    this.#adoptedSessions.delete(sessionID)
    // A regular turn reclaims the session from any steering adoption that raced its end.
    this.#discardAdoptedTurn(sessionID)
    const generation = (this.#turnGenerations.get(sessionID) ?? 0) + 1
    this.#turnGenerations.set(sessionID, generation)
    this.#cancelledSessions.delete(sessionID)
    this.#promptedSessions.add(sessionID)
    this.#turnResponseObserved.delete(sessionID)
    const messageID = recorded ? undefined : this.#recordPrompt(sessionID, text, attachments)
    if (recorded) this.#promptAcknowledgements.set(sessionID, { text, received: "" })
    this.#active.add(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#emit("session.updated", sessionID)
    void this.#requestPromptWithRecovery(sessionID, {
      sessionId: sessionID,
      prompt: this.#promptBlocks(text, attachments)
    }).then(async (result) => {
      if (this.#requireAssistantResponse && !this.#turnResponseObserved.has(sessionID)) {
        await new Promise((resolve) => setTimeout(resolve, this.#promptSettleMs || 50))
      }
      if (this.#requireAssistantResponse && this.#turnGenerations.get(sessionID) === generation
        && result?.stopReason === "end_turn" && !this.#turnResponseObserved.has(sessionID)) {
        throw new Error("The harness completed the turn without an assistant response. Check that the selected model and provider are available.")
      }
    }).catch((error) => {
      if (this.#turnGenerations.get(sessionID) === generation) {
        this.#recordTurnFailure(sessionID, error.message)
        this.#emit("session.error", sessionID, { message: error.message })
      }
    }).finally(() => {
      void this.#settleTurn(sessionID, generation)
    })
    return messageID
  }

  #promptBlocks(text, attachments) {
    return [
      ...(text ? [{ type: "text", text }] : []),
      ...attachments.map((attachment) => ({ type: "image", mimeType: attachment.mime, data: attachment.data }))
    ]
  }

  /**
   * Shared turn teardown, keyed by the turn generation so a superseded turn can never clear the
   * state of the turn that replaced it. Runs after every session/prompt response and after an
   * adopted steering turn settles.
   */
  async #settleTurn(sessionID, generation) {
    if (this.#turnGenerations.get(sessionID) !== generation) return
    // PI can write the JSON-RPC response before its final session/update notification. Do not
    // clear #active until that tiny transport tail has drained: #handleNotification deliberately
    // accepts those chunks, and otherwise they arrive after #settleActivity has already run.
    if (this.#promptSettleMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#promptSettleMs))
    }
    if (this.#turnGenerations.get(sessionID) !== generation) return
    this.#active.delete(sessionID)
    this.#turnSettledAt.set(sessionID, Date.now())
    this.#turnResponseObserved.delete(sessionID)
    // Older adapters intentionally deliver assistant chunks after their RPC response, so their
    // historical zero-drain behavior must stay permissive. PI opts into a real drain window above;
    // once it closes, an even later chunk belongs to a subsequent native lifecycle, not this turn.
    if (this.#promptSettleMs > 0) this.#promptedSessions.delete(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    // The turn is over, so no activity it started is still running, whatever the adapter said.
    this.#settleActivity(sessionID)
    this.#emit("session.updated", sessionID)
    this.#persistSnapshot(sessionID)
    void this.#runNextQueued(sessionID)
  }

  /**
   * Forward a prompt into the harness's live turn. Recorded first, like every prompt, so the
   * conversation shows what the user wrote regardless of what the adapter does with it next:
   *
   * - `{outcome: "injected"}`: the content joined the live turn. That turn's own session/prompt
   *   response still owns turn end, so nothing here may settle the session.
   * - `{outcome: "startedNewTurn"}`: the previous turn drained while the steering request was in
   *   flight, and the adapter started this prompt as a turn of its own. The steering response
   *   resolved at turn start rather than turn end, so the session re-enters turn state here to keep
   *   streaming tool calls and text recorded, and the adopted turn settles from its own silence.
   * - error: an adapter that predates steering refuses the method, and an adapter can refuse the
   *   input itself. The recorded prompt then joins the ordinary queue - the message id stays, so
   *   nothing is redelivered twice.
   */
  async #steerPrompt(sessionID, text, attachments, variant) {
    const messageID = this.#recordPrompt(sessionID, text, attachments)
    this.#emit("session.updated", sessionID)
    const generationAtSteer = this.#turnGenerations.get(sessionID)
    let result = null
    try {
      result = await this.#acp.request(STEERING_METHOD, {
        sessionId: sessionID,
        prompt: this.#promptBlocks(text, attachments)
      }, 300_000)
    } catch (error) {
      if (this.#active.has(sessionID)) {
        const queue = this.#queues.get(sessionID) ?? []
        queue.push({ text, model: undefined, messageID, attachments, variant })
        this.#queues.set(sessionID, queue)
        this.#setPromptQueued(sessionID, messageID, true)
        this.#emit("session.updated", sessionID)
        return { disposition: "queued", messageID }
      }
      // The live turn ended underneath the failed steering request. Keep the recorded message (it
      // now reads as the newest user turn of an idle session) and replay it as a regular turn.
      this.#startTurn(sessionID, text, true, attachments)
      return { disposition: "started", messageID }
    }
    if (result?.outcome !== "startedNewTurn") {
      // The live turn now answers the steered prompt, so whatever it streams next belongs after that
      // recorded user row. Appending it to the reply already open above the row left the steered
      // prompt with no answer of its own, and the client kept waiting for one until the turn ended.
      this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
      return { disposition: "steered", messageID }
    }
    // The adapter answers startedNewTurn only after the previous prompt completed, but that prompt's
    // session/prompt response can still be on its way here. Waiting for its teardown to be registered
    // was a race; the generation is what decides instead. Unchanged since the steering request, the
    // turn being replaced is the one that just ended, and bumping the generation below makes its late
    // teardown a no-op. A Stop or another turn started meanwhile changed it, and owns the session.
    if (this.#turnGenerations.get(sessionID) !== generationAtSteer) return { disposition: "steered", messageID }
    const generation = (this.#turnGenerations.get(sessionID) ?? 0) + 1
    this.#turnGenerations.set(sessionID, generation)
    this.#active.add(sessionID)
    this.#promptedSessions.add(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#adoptedTurns.set(sessionID, { generation, lastStreamAt: Date.now(), idleMs: STEER_ADOPT_SETTLE_IDLE_MS })
    this.#emit("session.updated", sessionID)
    this.#startAdoptedTurnSweep()
    // The adapter ran the prompt as a turn of its own, which is what a client must show.
    return { disposition: "started", messageID }
  }

  /**
   * Whether live output for an idle Session opens a turn the agent started on its own.
   *
   * Only a Session this bridge has run a turn in qualifies: its adapter process is the one whose
   * background work just finished. A Stop is definitive, and output arriving right after a turn
   * ended is that turn's transport tail (see AGENT_TURN_GRACE_MS), so neither opens a turn.
   */
  #opensAgentTurn(sessionID) {
    if (this.#active.has(sessionID) || this.#cancelledSessions.has(sessionID)) return false
    if (!this.#turnGenerations.has(sessionID)) return false
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) return false
    return Date.now() - (this.#turnSettledAt.get(sessionID) ?? 0) >= this.#agentTurnGraceMs
  }

  /**
   * Take over a turn the agent started without a prompt from this bridge, typically Claude Code
   * resuming after a background command or subagent it was waiting on finished. It reads busy and
   * records its output as a new reply until its own stream goes silent; a prompt or a Stop that
   * arrives meanwhile is handled exactly as during any other turn.
   */
  #adoptAgentTurn(sessionID) {
    const generation = (this.#turnGenerations.get(sessionID) ?? 0) + 1
    this.#turnGenerations.set(sessionID, generation)
    this.#active.add(sessionID)
    this.#promptedSessions.add(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    this.#adoptedTurns.set(sessionID, {
      generation,
      startedAt: Date.now(),
      lastStreamAt: Date.now(),
      idleMs: this.#agentTurnSettleIdleMs,
      holdForRunningTools: true
    })
    this.#emit("session.updated", sessionID)
    this.#startAdoptedTurnSweep()
  }

  /** Whether the Session's current turn is one the adapter runs without a pending session/prompt. */
  hasAdoptedTurn(sessionID) {
    return this.#adoptedTurns.has(sessionID)
  }

  /** A tool call the adopted turn opened that has not reported an end yet. */
  #adoptedTurnHasRunningTool(sessionID, adoption) {
    return (this.#messages.get(sessionID) ?? []).some((message) => message.info.role === "assistant"
      && message.parts.some((part) => part.type === "tool"
        && ["pending", "running"].includes(part.state?.status)
        && (part.state.time?.start ?? 0) >= adoption.startedAt))
  }

  /** Stop tracking an adopted turn. A later regular turn or Stop owns the teardown. */
  #discardAdoptedTurn(sessionID) {
    this.#adoptedTurns.delete(sessionID)
    if (this.#adoptedTurns.size === 0 && this.#adoptedTurnSweep) {
      clearInterval(this.#adoptedTurnSweep)
      this.#adoptedTurnSweep = undefined
    }
  }

  /**
   * Settles adopted turns that went silent. A codex turn can outlive the steering response by
   * minutes, so the last stream time - refreshed by every live session/update for that session - is
   * the only signal this bridge has that the turn finished.
   */
  #startAdoptedTurnSweep() {
    if (this.#adoptedTurnSweep) return
    this.#adoptedTurnSweep = setInterval(() => {
      const now = Date.now()
      for (const [sessionID, adoption] of this.#adoptedTurns) {
        const idle = now - adoption.lastStreamAt
        if (idle < adoption.idleMs) continue
        if (adoption.holdForRunningTools && idle < AGENT_TURN_RUNNING_TOOL_CAP_MS
          && this.#adoptedTurnHasRunningTool(sessionID, adoption)) continue
        this.#adoptedTurns.delete(sessionID)
        void this.#settleTurn(sessionID, adoption.generation)
      }
      if (this.#adoptedTurns.size === 0) {
        clearInterval(this.#adoptedTurnSweep)
        this.#adoptedTurnSweep = undefined
      }
    }, Math.min(STEER_ADOPT_SWEEP_INTERVAL_MS, Math.max(10, Math.floor(this.#agentTurnSettleIdleMs / 3))))
    // A daemon process must not be kept alive by bookkeeping that only exists to close a race.
    this.#adoptedTurnSweep.unref?.()
  }

  async #requestPromptWithRecovery(sessionID, params) {
    try {
      return await this.#acp.request("session/prompt", params, 300_000)
    } catch (error) {
      if (!this.#recoverMissingSessionOnPrompt || !missingAcpSession(error)) throw error
      // The replay below rebuilds the transcript from what the harness stored, which does not yet
      // include this turn's prompt: the adapter refused it. Keep the turn as recorded, and start its
      // reply in a message of its own rather than in the last one the replay produced.
      const messages = this.#messages.get(sessionID) ?? []
      const promptIndex = messages.findLastIndex((message) => message.info.role === "user")
      const turn = promptIndex >= 0 ? messages.slice(promptIndex) : []
      this.#forgetOpenSessions([sessionID])
      await this.#load(sessionID, true)
      const replayed = this.#messages.get(sessionID) ?? []
      const replayedIDs = new Set(replayed.map((message) => message.info.id))
      this.#messages.set(sessionID, [...replayed, ...turn.filter((message) => !replayedIDs.has(message.info.id))])
      this.#chunkMessageIDs.delete(`${sessionID}:user`)
      this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
      this.#emit("message.updated", sessionID)
      return this.#acp.request("session/prompt", params, 300_000)
    }
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
    // The entry stays queued while its model is applied, so the session keeps reading busy through
    // that switch. Shifting first opened an idle gap between the two turns: a client polling status
    // saw the conversation finish, and a prompt arriving then jumped ahead of the queued one.
    const next = queue[0]
    const dequeue = () => {
      queue.shift()
      if (!queue.length) this.#queues.delete(sessionID)
    }
    // The model is applied on dequeue: doing it on enqueue would switch the model
    // underneath the turn that was still running.
    const savedModel = this.#fallbackModelSelections.get(sessionID)
    const selection = next.model ?? (savedModel ? `${savedModel.providerID}/${savedModel.modelID}` : undefined)
    if (selection) {
      try {
        await this.setModel(sessionID, selection, next.variant)
      } catch (error) {
        // A Stop during the switch discarded the queue; an unqueue removed just this prompt.
        if (this.#queues.get(sessionID)?.[0] !== next) return this.#resumeQueue(sessionID)
        dequeue()
        // No longer waiting: it is a turn now, one that failed before it could start.
        this.#setPromptQueued(sessionID, next.messageID, false)
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
    if (this.#queues.get(sessionID)?.[0] !== next) return this.#resumeQueue(sessionID)
    dequeue()
    this.#setPromptQueued(sessionID, next.messageID, false)
    this.#startTurn(sessionID, next.text, true, next.attachments ?? [])
  }

  /**
   * The prompt being started was removed while its model switched. After a Stop nothing is queued
   * and this is a no-op; after an unqueue the prompts behind it still have to run.
   */
  #resumeQueue(sessionID) {
    if (!this.#active.has(sessionID)) void this.#runNextQueued(sessionID)
  }

  /**
   * Drop one prompt still waiting in the queue, together with its recorded row. The running turn and
   * the rest of the queue are untouched. Returns whether the prompt was still waiting: one that has
   * already started is a turn, which only a Stop ends.
   */
  unqueue(sessionID, messageID) {
    const queue = this.#queues.get(sessionID)
    const index = queue ? queue.findIndex((entry) => entry.messageID === messageID) : -1
    if (index < 0) return false
    queue.splice(index, 1)
    if (!queue.length) this.#queues.delete(sessionID)
    const messages = this.#messages.get(sessionID)
    if (messages) this.#messages.set(sessionID, messages.filter((message) => message.info.id !== messageID))
    this.#emit("message.updated", sessionID)
    this.#emit("session.updated", sessionID)
    this.#persistSnapshot(sessionID)
    return true
  }

  /** Cancelling drops anything still queued, including the messages recorded for it. */
  abort(sessionID) {
    if (this.#historyLoader && !this.#ownedSessions.has(sessionID)) {
      throw new Error("This session is not active in the app")
    }
    // A Stop also ends any adopted steering turn: the harness cancel is definitive either way.
    this.#discardAdoptedTurn(sessionID)
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
    const wasActive = this.#active.has(sessionID)
    this.#turnGenerations.set(sessionID, (this.#turnGenerations.get(sessionID) ?? 0) + 1)
    this.#cancelledSessions.add(sessionID)
    this.#turnResponseObserved.delete(sessionID)
    this.#active.delete(sessionID)
    this.#chunkMessageIDs.delete(`${sessionID}:assistant`)
    // A cancelled turn gets no closing tool_call_update at all, so settle before it is published.
    this.#settleActivity(sessionID)
    // Live, the Stop is the only record of the interruption; replay reads it back from the harness.
    if (wasActive) {
      const messages = this.#messages.get(sessionID) ?? []
      this.#messages.set(sessionID, messages)
      if (markLatestTurnInterrupted(messages, sessionID)) this.#emit("message.updated", sessionID)
    }
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
    await this.#titleIndexWrite
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

  /** Persistent bridge-local names for lightweight index reads. */
  async titleOverrides() {
    await this.#restoreTitleIndex()
    return new Map(this.#titles)
  }

  #titleIndexPath() {
    return path.join(this.#snapshotDirectory, "session-titles.json")
  }

  async #restoreTitleIndex() {
    if (this.#titleIndexLoading) return this.#titleIndexLoading
    if (!this.#snapshotDirectory || this.#titleIndexLoaded) return
    const loading = this.#readTitleIndex()
    this.#titleIndexLoading = loading
    try { await loading } finally { this.#titleIndexLoading = undefined }
  }

  async #readTitleIndex() {
    this.#titleIndexLoaded = true
    try {
      const state = JSON.parse(await readFile(this.#titleIndexPath(), "utf8"))
      if (state?.version !== 1 || !state.titles || typeof state.titles !== "object" || Array.isArray(state.titles)) return
      for (const [sessionID, title] of Object.entries(state.titles)) {
        if (sessionID && typeof title === "string" && title) this.#titles.set(sessionID, title)
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.#titleIndexLoaded = false
        throw error
      }
    }
  }

  async #persistTitleIndex() {
    if (!this.#snapshotDirectory) return
    const previous = this.#titleIndexWrite
    const writing = previous.catch(() => undefined).then(async () => {
      await mkdir(this.#snapshotDirectory, { recursive: true })
      const target = this.#titleIndexPath()
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
      const titles = Object.fromEntries([...this.#titles.entries()].sort(([left], [right]) => left.localeCompare(right)))
      await writeFile(temporary, JSON.stringify({ version: 1, titles }), { mode: 0o600 })
      await rename(temporary, target)
    })
    this.#titleIndexWrite = writing
    await writing
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

  /**
   * Every caller waits for the same read. At startup the Session list reads every snapshot at once,
   * so a long Session's file can still be in flight when that Session is opened; returning early
   * there let the load clear the transcript and start its replay, and the read then landed on top
   * of it. The rest of the replay was merged into the old transcript: its text doubled onto the
   * messages it already had, and the turns that open with a tool call piled up at the end as one
   * Activity with no reply.
   */
  #restoreSnapshot(sessionID) {
    if (!this.#snapshotDirectory) return Promise.resolve()
    let restoring = this.#restoredSnapshots.get(sessionID)
    if (!restoring) {
      restoring = this.#readSnapshot(sessionID)
      this.#restoredSnapshots.set(sessionID, restoring)
    }
    return restoring
  }

  async #readSnapshot(sessionID) {
    await this.#restoreTitleIndex()
    try {
      const snapshot = JSON.parse(await readFile(this.#snapshotPath(sessionID), "utf8"))
      if (snapshot?.version !== 1) return
      // A freshly created Session is already loaded in this process. Its first snapshot can still
      // contain the empty pre-prompt transcript while a real prompt has since been recorded in
      // memory; restoring that stale file here would erase the visible user turn. Snapshots only
      // seed a Session that has not been loaded yet (restart or cache eviction), and never one
      // whose replay is already rebuilding it.
      if (!this.#loaded.has(sessionID) && !this.#replaying.has(sessionID) && Array.isArray(snapshot.messages)) {
        const fragmented = mergeFragmentedPiSnapshot(snapshot.messages)
          // A prompt still queued when the snapshot was written never reached the harness, and the
          // queue it waited in did not survive the restart: restored, it would read as queued forever.
          .filter((message) => message?.info?.queued !== true)
        const restored = healPoisonedSnapshot(fragmented)
        if (restored.length !== snapshot.messages.length) {
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
      if (this.#fallbackModelCatalog && typeof snapshot.selectedModel?.modelID === "string"
        && snapshot.selectedModel.providerID === this.#modelProviderID) {
        this.#fallbackModelSelections.set(sessionID, snapshot.selectedModel)
      }
      if (!this.#preferListedTitles && !this.#titles.has(sessionID) && typeof snapshot.title === "string" && snapshot.title) this.#titles.set(sessionID, snapshot.title)
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
          ...(this.#fallbackModelCatalog ? { selectedModel: this.#fallbackModelSelections.get(sessionID) } : {}),
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
    if (this.#refreshSessionListOnRead || !this.#sessions.has(sessionID)) await this.#refreshSessions()
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
    // A single adapter process is not restarted by a request on its own, and the one that opened
    // this Session may have exited since. A project-scoped client starts its own process per request.
    await this.#requireSessionDirectory(session)
    if (typeof this.#acp.withSession !== "function") await this.#acp.start?.()
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
      this.#rememberSessionConfiguration(sessionID, result)
      const replayedMessages = mergeFragmentedPiSnapshot(this.#messages.get(sessionID) ?? [])
      this.#messages.set(sessionID, chronologicalReplay(this.#replayAuthoritative
        ? authoritativeReplay(previousMessages, replayedMessages)
        : replaceHistory ? replayedMessages : mergeReplay(previousMessages, replayedMessages)))
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

  async #requireSessionDirectory(session) {
    if (!this.#requireExistingDirectory) return
    try {
      if (!(await stat(session.cwd)).isDirectory()) throw new Error("Not a directory")
    } catch (error) {
      throw new Error(`Session project directory is missing or inaccessible: ${session.cwd}. History is still available; restore the directory before continuing this Session.`, { cause: error })
    }
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
    this.#rememberSessionConfiguration(sessionID, result)
    this.#loaded.add(sessionID)
    this.#persistSnapshot(sessionID)
    return true
  }

  async #refreshSessions() {
    if (!this.#sessionListing) {
      this.#sessionListing = this.#acp.listSessions().then((sessions) => {
        const listed = new Set(sessions.map((session) => session.sessionId))
        const refreshed = this.rememberListedSessions(sessions)
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

  #rememberSessionConfiguration(sessionID, result) {
    if (Array.isArray(result?.configOptions) || result?.models) {
      this.#rememberConfigOptions(sessionID, modelConfigOptionFromSessionResponse(result))
      this.#modelSwitchMethods.set(sessionID, Array.isArray(result?.models?.availableModels)
        && !result?.configOptions?.some((option) => option.id === "model") ? "session/set_model" : "session/set_config_option")
    }
  }

  #rememberConfigOptions(sessionID, configOptions) {
    if (Array.isArray(configOptions)) this.#configOptions.set(sessionID, configOptions)
  }

  /**
   * A queued prompt is recorded the moment it is accepted, so its user row can reach the transcript
   * before the running turn has streamed anything. That turn's reply still belongs above the queued
   * rows: appended after them it read as the queued prompt's answer, so the client settled the queued
   * prompt early and showed both prompts stacked with no reply between them.
   */
  #insertLiveMessage(sessionID, messages, message, replaying) {
    const queue = !replaying && message.info.role === "assistant" ? this.#queues.get(sessionID) : undefined
    if (queue?.length) {
      const queuedIDs = new Set(queue.map((entry) => entry.messageID))
      const index = messages.findIndex((item) => queuedIDs.has(item.info.id))
      if (index >= 0) {
        messages.splice(index, 0, message)
        return
      }
    }
    messages.push(message)
  }

  /**
   * Record a user prompt in the live transcript. A queued prompt is marked `info.queued` until it is
   * dequeued: that flag is the one authority clients read to show it as waiting rather than as a turn
   * of the conversation, so it survives remounts and is the same for every client of this bridge.
   */
  #recordPrompt(sessionID, text, attachments = [], { queued = false } = {}) {
    const messageID = randomUUID()
    const messages = this.#messages.get(sessionID) ?? []
    this.#messages.set(sessionID, messages)
    messages.push({
      info: { id: messageID, role: "user", sessionID, time: { created: Date.now() }, ...(queued ? { queued: true } : {}) },
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
    // The acknowledgement suppresses the harness echoing this prompt back. A queued prompt sets it
    // on dequeue instead: set here, it replaced the running turn's and let that echo through as a
    // duplicate user row below the queued one.
    if (!queued) this.#promptAcknowledgements.set(sessionID, { text, received: "" })
    this.#emit("message.updated", sessionID)
    this.#persistSnapshot(sessionID)
    return messageID
  }

  /** Mark a recorded prompt as waiting in the queue, or as no longer waiting once it is dequeued. */
  #setPromptQueued(sessionID, messageID, queued) {
    const message = this.#messages.get(sessionID)?.find((item) => item.info.id === messageID)
    if (!message) return
    if (queued) message.info.queued = true
    else delete message.info.queued
    this.#emit("message.updated", sessionID)
    this.#persistSnapshot(sessionID)
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
    const modelReply = this.#modelCommandReplies.get(sessionId)
    if (update.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
      if (modelReply) modelReply.configurationUpdated = true
      this.#rememberConfigOptions(sessionId, update.configOptions)
      return
    }
    if (modelReply && ["agent_message_chunk", "user_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate)) {
      if (update.sessionUpdate === "agent_message_chunk" && typeof update.content?.text === "string") modelReply.chunks.push(update.content.text)
      return
    }
    const replaying = this.#replaying.has(sessionId)
    const session = this.#sessions.get(sessionId)
    if (!replaying) {
      const adoption = this.#adoptedTurns.get(sessionId)
      if (adoption) adoption.lastStreamAt = Date.now()
      const agentOutput = update.sessionUpdate === "tool_call"
        || ((update.sessionUpdate === "agent_message_chunk" || update.sessionUpdate === "agent_thought_chunk")
          && update.content?.type === "text" && Boolean(update.content.text))
      if (agentOutput && this.#opensAgentTurn(sessionId)) this.#adoptAgentTurn(sessionId)
    }
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
        this.#insertLiveMessage(sessionId, messages, message, replaying)
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
        // Claude's adapter names the tool under its own namespace; without it the tool name fell back
        // to the title, which for a shell call is the command line itself.
        tool: update._meta?.toolName ?? update._meta?.claudeCode?.toolName ?? update.title,
        callID: update.toolCallId,
        // ACP's own classification (read, edit, execute, search, fetch, think, ...): the client
        // labels calls by it instead of guessing from tool names.
        kind: typeof update.kind === "string" ? update.kind : undefined,
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
      // An update carries only the fields that changed. The input and title in particular often
      // arrive here rather than on the opening tool_call, and an update without a status must not
      // erase the one the call already has.
      if (update.status) tool.state.status = update.status === "in_progress" ? "running" : update.status === "failed" ? "error" : update.status
      if (update.rawInput && typeof update.rawInput === "object") tool.state.input = update.rawInput
      if (typeof update.title === "string" && update.title) tool.state.title = update.title
      if (typeof update.kind === "string") tool.kind = update.kind
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
    if (!replaying && role === "assistant" && !thought && (image || update.content.text?.trim())) {
      this.#turnResponseObserved.add(sessionId)
    }
    const partType = thought ? "reasoning" : image ? "file" : "text"
    // Acknowledgements only suppress a live echo of the prompt we just recorded;
    if (role === "assistant" && !replaying && this.#cancelledSessions.has(sessionId)) return
    if (role === "assistant" && !replaying && !this.#active.has(sessionId) && !this.#promptedSessions.has(sessionId)) return
    if (role === "user" && !replaying && this.#isAcknowledgedPromptChunk(sessionId, update.content.text)) return
    if (role === "user" && !image && isHarnessInjectedText(update.content.text)) return
    if (role === "user" && !image && isInterruptionMarker(update.content.text)) {
      const messages = this.#messages.get(sessionId) ?? []
      this.#messages.set(sessionId, messages)
      markLatestTurnInterrupted(messages, sessionId)
      // Whatever the adapter sends next belongs to a new reply, not to the interrupted one.
      this.#chunkMessageIDs.delete(`${sessionId}:assistant`)
      if (!replaying) this.#emit("message.updated", sessionId)
      return
    }
    // The Codex desktop app wraps the request in its UI state; session/load replays it that way.
    const text = role === "user" && !image ? stripAmbientContext(update.content.text) : update.content?.text
    if (!replaying && session) session.updatedAt = new Date().toISOString()
    const counterpartKey = `${sessionId}:${role === "user" ? "assistant" : "user"}`
    this.#chunkMessageIDs.delete(counterpartKey)
    const chunkKey = `${sessionId}:${role}`
    if (replaying && role === "user" && this.#replayUserChunksAreMessages) this.#chunkMessageIDs.delete(chunkKey)
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
      this.#insertLiveMessage(sessionId, messages, message, replaying)
    }
    const previous = message.parts.at(-1)
    const now = Date.now()
    if (previous?.type === "reasoning" && partType !== "reasoning" && previous.time && !previous.time.end) {
      previous.time.end = now
    }
    // Two replies streamed back to back are two paragraphs, not one run-on sentence.
    let continuesPrevious = previous?.type === partType
    if (!replaying && role === "assistant" && this.#assistantMessageIDsSeparateReplies && typeof update.messageId === "string") {
      const source = this.#chunkSourceIDs.get(sessionId)
      if (continuesPrevious && source && source !== update.messageId) continuesPrevious = false
      this.#chunkSourceIDs.set(sessionId, update.messageId)
    }
    if (image) {
      message.parts.push({
        id: `${messageID}:file:${message.parts.length}`,
        messageID,
        type: "file",
        mime: image.mime,
        url: `data:${image.mime};base64,${image.data}`
      })
    } else if (continuesPrevious) {
      previous.text += text
    } else {
      message.parts.push({
        id: `${messageID}:${partType}:${message.parts.length}`,
        messageID,
        type: partType,
        text,
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
