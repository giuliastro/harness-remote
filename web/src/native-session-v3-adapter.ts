import { api, type MessagePage } from "./api"
import { probeNativeSessionContinuation } from "./native-session-continuation"
import { lastNativeMessageModel } from "./native-session-model"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import {
  loadPendingNativeSessionPrompt,
  markPendingNativeSessionPromptAccepted,
  sendNativeSessionCommand,
  sendNativeSessionPrompt
} from "./native-session-prompt"
import { stopNativeSession } from "./native-session-stop"
import type { ConversationContinueInput, ConversationController } from "./conversation-controller"
import type { ConversationRuntime, ConversationTurn } from "./conversation-runtime"
import type { MessageEnvelope, ModelSelection, ServerConfig } from "./types"

// Keep the value stable so drafts/local UI identity survive the architecture migration.
const NATIVE_CONVERSATION_ID_PREFIX = "native-session-v3:"
const PENDING_TRANSCRIPT_CLOCK_SKEW_MS = 2 * 60 * 1000
// OpenCode can briefly report an idle/interrupted edge or a provider error envelope while an
// automatic retry is already about to continue the same native turn. Require terminal-looking
// evidence to survive the bounded lifecycle settle pass before turning it into a completed
// Conversation. The transcript fallback matters because /session/status can omit a child Session.
const OPENCODE_IDLE_CONFIRM_MS = 750
// If a provider/router retries after that confirmation window, a later busy edge must still retract
// the terminal-looking interruption. This watch is event-driven in the normal case; it does not add
// fast polling and expires so an old failed turn cannot be resurrected indefinitely.
const OPENCODE_RECOVERY_WATCH_MS = 2 * 60 * 1000

type NativeTurnRecord = {
  id: string
  prompt: string
  created: number
  model: ModelSelection | null
  /** Exact native user-envelope identity when this logical turn was reconstructed from transcript. */
  nativeMessageID?: string
}

type NativeConversationEntry = {
  target: NativeSessionSurfaceTarget
  createdAt: number
  updatedAt: number
  statusType: string
  forcedStatus: "running" | "cancelled" | null
  // First terminal-looking OpenCode observation. Normally this is an idle status edge; when the
  // legacy status endpoint omits the Session it can instead be the newest assistant error envelope.
  openCodeIdleObservedAt: number | null
  openCodeRecoveryWatchUntil: number
  currentModel: ModelSelection | null
  initialPageCaptured: boolean
  piTailMessages: MessageEnvelope[]
  writerReady: boolean
  writerClaimInFlight: Promise<void> | null
  turns: Map<string, NativeTurnRecord>
  listeners: Set<(conversation: ConversationRuntime) => void>
}

const conversations = new Map<string, NativeConversationEntry>()

export function nativeSessionIsWorking(status?: string): boolean {
  const value = status?.trim().toLowerCase() || ""
  return value === "busy"
    || value === "running"
    || value === "working"
    || value === "retry"
    || value === "waiting"
    || value === "in_progress"
    || value === "in-progress"
}

function conversationID(target: NativeSessionSurfaceTarget): string {
  return `${NATIVE_CONVERSATION_ID_PREFIX}${encodeURIComponent(target.machineID)}:${encodeURIComponent(target.agentID)}:${encodeURIComponent(target.sessionID)}`
}

function canonicalText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim()
}

function messageText(message: MessageEnvelope): string {
  return (message.parts || [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/**
 * PI can expose one logical turn under two transport identities: the live ACP cache first, then the
 * authoritative JSONL journal. The mature v3 tail merge deliberately retains unseen ids so older
 * pages never disappear; therefore PI must keep a browser identity stable when that live record is
 * replaced by its persisted equivalent.
 *
 * This applies to the user prompt and terminal provider error as well as successful assistant text.
 * A failed turn is especially important: PI can journal a different error sentence and different ids
 * after ACP already emitted the failure. Without stabilising the prompt first and then keying the
 * error to that prompt, the mounted chat keeps both copies until it is unmounted and reopened.
 *
 * Every match is deliberately one-to-one. Repeated identical prompts/replies remain distinct rather
 * than risking a false merge; in that ambiguous case native ids are left untouched.
 */
function piStableUserKey(message: MessageEnvelope): string | null {
  if (message.info.role !== "user" || message.info.error || !message.parts.length) return null
  const text = canonicalText(messageText(message))
  if (text) return `text:${text}`
  const semanticParts = message.parts.map((part) => Object.fromEntries(
    Object.entries(part).filter(([key]) => key !== "id" && key !== "messageID")
  ))
  return semanticParts.length ? `parts:${JSON.stringify(semanticParts)}` : null
}

function piStableAssistantKey(message: MessageEnvelope): string | null {
  if (message.info.role !== "assistant" || message.info.error || !message.parts.length) return null
  if (message.parts.some((part) => part.type !== "text" && part.type !== "reasoning")) return null
  const textParts = message.parts.filter((part) => part.type === "text" && typeof part.text === "string")
  if (!textParts.length) return null
  const text = canonicalText(textParts.map((part) => part.text || "").join("\n"))
  return text ? `text:${text}` : null
}

function piStableErrorTurnKey(
  message: MessageEnvelope,
  index: number,
  messages: MessageEnvelope[]
): string | null {
  if (message.info.role !== "assistant" || !message.info.error) return null
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor]
    if (candidate.info.role === "user") return candidate.info.id ? `user:${candidate.info.id}` : null
  }
  return null
}

function stabilizePiMessagesByKey(
  previous: MessageEnvelope[],
  next: MessageEnvelope[],
  keyFor: (message: MessageEnvelope, index: number, messages: MessageEnvelope[]) => string | null
): MessageEnvelope[] {
  const previousIDs = new Set(previous.map((message) => message.info.id))
  const nextIDs = new Set(next.map((message) => message.info.id))
  const previousByKey = new Map<string, MessageEnvelope[]>()
  const nextKeyCounts = new Map<string, number>()

  for (let index = 0; index < previous.length; index += 1) {
    const message = previous[index]
    if (nextIDs.has(message.info.id)) continue
    const key = keyFor(message, index, previous)
    if (!key) continue
    const candidates = previousByKey.get(key) ?? []
    candidates.push(message)
    previousByKey.set(key, candidates)
  }
  for (let index = 0; index < next.length; index += 1) {
    const message = next[index]
    if (previousIDs.has(message.info.id)) continue
    const key = keyFor(message, index, next)
    if (key) nextKeyCounts.set(key, (nextKeyCounts.get(key) ?? 0) + 1)
  }

  let changed = false
  const stabilized = next.map((message, index) => {
    if (previousIDs.has(message.info.id)) return message
    const key = keyFor(message, index, next)
    if (!key || nextKeyCounts.get(key) !== 1) return message
    const candidates = previousByKey.get(key)
    if (candidates?.length !== 1) return message
    const stableID = candidates[0].info.id
    changed = true
    return {
      ...message,
      info: { ...message.info, id: stableID },
      parts: message.parts.map((part) => ({ ...part, messageID: stableID }))
    }
  })
  return changed ? stabilized : next
}

export function stabilizePiTailMessageIDs(
  previous: MessageEnvelope[],
  next: MessageEnvelope[]
): MessageEnvelope[] {
  if (!previous.length || !next.length) return next
  // Stabilise the prompt first. Terminal errors can then be matched to that stable prompt identity
  // even when PI changes both the assistant id and the provider-specific error sentence on flush.
  let stabilized = stabilizePiMessagesByKey(previous, next, piStableUserKey)
  stabilized = stabilizePiMessagesByKey(previous, stabilized, piStableAssistantKey)
  stabilized = stabilizePiMessagesByKey(previous, stabilized, piStableErrorTurnKey)
  return stabilized
}

function stabilizePiTailPage(entry: NativeConversationEntry, page: MessagePage, before?: string): MessagePage {
  if (entry.target.backend !== "pi" || before) return page
  const messages = stabilizePiTailMessageIDs(entry.piTailMessages, page.messages)
  entry.piTailMessages = messages
  return messages === page.messages ? page : { ...page, messages }
}

/**
 * The old v3 handoff packet is transport context, not visible dialogue. This adapter only extracts
 * the same USER INSTRUCTION marker so the mature work-thread timeline can match the native turn.
 */
function visiblePrompt(message: MessageEnvelope): string {
  const value = canonicalText(messageText(message))
  if (!value.startsWith("You are taking over an existing TaskDesk task.")) return value
  const marker = "\nUSER INSTRUCTION\n"
  const start = value.indexOf(marker)
  if (start < 0) return value
  const instructionStart = start + marker.length
  const footerStart = value.indexOf("\n\nContinue from the shared workspace", instructionStart)
  return canonicalText(value.slice(instructionStart, footerStart >= 0 ? footerStart : undefined))
}

function nativeAssistantCompleted(message: MessageEnvelope): boolean {
  if (message.info.role !== "assistant") return false
  if (message.info.error || message.info.time?.completed) return true
  const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
  return typeof info.finish === "string" && Boolean(info.finish.trim())
}

function assistantHasTerminalText(message: MessageEnvelope): boolean {
  for (let index = message.parts.length - 1; index >= 0; index -= 1) {
    const part = message.parts[index]
    if (part.type === "step-start" || part.type === "step-finish" || part.type === "snapshot" || part.type === "patch") continue
    if (part.type === "text") return Boolean(part.text?.trim())
    if (part.type === "reasoning" || part.type === "tool") return false
  }
  return false
}

/**
 * An OpenCode assistant envelope is message-level, not necessarily user-turn-level. Tool steps can
 * finish, and a provider/router can emit an interrupted/error envelope, while OpenCode immediately
 * continues the same user turn. Treat only a newest non-error assistant envelope with a real terminal
 * finish as transcript proof that the whole turn is done. Ambiguous no-final/error cases are settled
 * from a stable Session idle state instead.
 */
function openCodeAssistantProvesTurnCompleted(message: MessageEnvelope): boolean {
  if (message.info.role !== "assistant" || message.info.error) return false
  const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
  if (typeof info.finish === "string" && info.finish.trim()) {
    const finish = info.finish.trim().toLowerCase()
    return finish !== "tool" && finish !== "tool-call" && finish !== "tool-calls" && finish !== "tool_calls"
  }
  return Boolean(message.info.time?.completed) && assistantHasTerminalText(message)
}

function sameModel(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return Boolean(left && right
    && left.providerID === right.providerID
    && left.modelID === right.modelID
    && (left.variant || "") === (right.variant || ""))
}

/** Backends whose transcript reads report the Session's own current model on the page itself. */
const PAGE_MODEL_BACKENDS = new Set(["opencode", "codex", "omp"])

/**
 * Model enrichment is not a mount-only read. A user can leave immediately after Send, before the
 * new native envelope is durable, then return while the reply is still streaming. Every current-tail
 * page can therefore advance the runtime from stale/default metadata to the model on the newest
 * native turn.
 *
 * A turn minted before that answer arrived carries no model at all, and the timeline reads two
 * adjacent turns whose models differ as a model change - which is how continuing on the very same
 * model announced "Model changed to ..." in the conversation. Enrichment therefore fills in the
 * turns that never had one; a turn that recorded a different model keeps it, because that one is a
 * real change the user made.
 */
function reconcileNativeSessionModel(entry: NativeConversationEntry, page: MessagePage, before?: string): void {
  if (before || !PAGE_MODEL_BACKENDS.has(entry.target.backend)) return
  const model = page.model ?? (entry.target.backend === "opencode" ? lastNativeMessageModel(page.messages) : null)
  if (!model) return

  let changed = !sameModel(entry.currentModel, model)
  entry.currentModel = model
  for (const turn of entry.turns.values()) {
    if (turn.model) continue
    turn.model = model
    changed = true
  }
  const latestUser = [...page.messages].reverse().find((message) => message.info.role === "user" && message.info.id)
  if (latestUser) {
    const turn = entry.turns.get(`${conversationID(entry.target)}:native-user:${latestUser.info.id}`)
    if (turn && !sameModel(turn.model, model)) {
      turn.model = model
      changed = true
    }
  }
  if (changed) notify(entry)
}

/**
 * OpenCode status and transcript durability are separate streams. After HR accepts one prompt, the
 * durable native transcript is the strongest evidence that this exact turn finished: it cannot be
 * scoped away by `/session/status`, and it is also the payload the user ultimately needs to see.
 *
 * Match by prompt occurrence, not timestamps, so repeated prompts remain correct and clock skew
 * between the browser and OpenCode cannot attach an older completed assistant to a new turn.
 */
function reconcileOpenCodeTranscriptStatus(entry: NativeConversationEntry, page: MessagePage, before?: string): void {
  if (entry.target.backend !== "opencode" || before) return
  const recoveryWatchActive = entry.openCodeRecoveryWatchUntil > Date.now()
  if (entry.forcedStatus !== "running" && !recoveryWatchActive) return

  const orderedTurns = [...entry.turns.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
  const current = orderedTurns[orderedTurns.length - 1]
  const prompt = canonicalText(current?.prompt || "")
  if (!current || !prompt) return

  const occurrence = orderedTurns.slice(0, -1).filter((turn) => canonicalText(turn.prompt) === prompt).length
  let seen = 0
  let userIndex = -1
  for (let index = 0; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role !== "user" || visiblePrompt(message) !== prompt) continue
    if (seen === occurrence) {
      userIndex = index
      break
    }
    seen += 1
  }
  if (userIndex < 0) return

  let latestAssistant: MessageEnvelope | null = null
  for (let index = userIndex + 1; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role === "user") break
    if (message.info.role === "assistant") latestAssistant = message
  }
  if (!latestAssistant) return

  const now = Date.now()
  const completedByTranscript = openCodeAssistantProvesTurnCompleted(latestAssistant)
  const terminalError = Boolean(latestAssistant.info.error)
  if (!completedByTranscript) {
    // A provider/model error envelope is terminal-looking but not definitive on its first edge:
    // OpenCode may still automatically retry the same turn. Keep the exact #351 debounce semantics,
    // but let the transcript supply the second observation when /session/status omits this Session.
    // A real busy status clears openCodeIdleObservedAt in refreshStatus(), so active retries cannot
    // be completed by this fallback while the status endpoint is actually reporting them.
    if (!terminalError || entry.forcedStatus !== "running") return
    if (entry.openCodeIdleObservedAt === null) {
      entry.openCodeIdleObservedAt = now
      return
    }
    if (now - entry.openCodeIdleObservedAt < OPENCODE_IDLE_CONFIRM_MS) return
  }

  const priorStatus = conversationStatus(entry)
  entry.statusType = "idle"
  entry.forcedStatus = null
  entry.openCodeIdleObservedAt = null
  entry.openCodeRecoveryWatchUntil = terminalError ? now + OPENCODE_RECOVERY_WATCH_MS : 0
  const completedAt = Number(latestAssistant.info.time?.completed) || Number(latestAssistant.info.time?.created) || 0
  if (completedAt) entry.updatedAt = Math.max(entry.updatedAt, completedAt)
  if (conversationStatus(entry) !== priorStatus) notify(entry)
}

function iso(timestamp: number): string {
  return new Date(Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()).toISOString()
}

function sameServer(left: ServerConfig, right: ServerConfig): boolean {
  return left.host === right.host
    && left.port === right.port
    && left.username === right.username
    && left.password === right.password
    && (left.agentId || "") === (right.agentId || "")
}

function entryForRead(config: ServerConfig, sessionID: string, directory?: string): NativeConversationEntry | undefined {
  for (const entry of conversations.values()) {
    if (entry.target.sessionID !== sessionID || !sameServer(entry.target.config, config)) continue
    if (directory && entry.target.directory && directory !== entry.target.directory) continue
    return entry
  }
  return undefined
}

function conversationStatus(entry: NativeConversationEntry): string {
  if (entry.forcedStatus) return entry.forcedStatus
  return nativeSessionIsWorking(entry.statusType) ? "running" : "completed"
}

function sortedTurns(entry: NativeConversationEntry): ConversationTurn[] {
  const status = conversationStatus(entry)
  const ordered = [...entry.turns.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
  if (ordered.length === 0) {
    return [{
      id: `${conversationID(entry.target)}:anchor`,
      sequence: 1,
      agentId: entry.target.agentID,
      model: entry.currentModel,
      role: "continue",
      sessionId: entry.target.sessionID,
      status,
      transport: entry.target.transport,
      directory: entry.target.directory,
      prompt: "",
      startedAt: iso(entry.createdAt),
      ...(status === "running" ? {} : { finishedAt: iso(entry.updatedAt) })
    }]
  }

  return ordered.map((turn, index) => ({
    id: turn.id,
    sequence: index + 1,
    agentId: entry.target.agentID,
    model: turn.model,
    role: index === 0 ? "implement" : "continue",
    sessionId: entry.target.sessionID,
    status: index === ordered.length - 1 ? status : "completed",
    transport: entry.target.transport,
    directory: entry.target.directory,
    prompt: turn.prompt,
    startedAt: iso(turn.created),
    ...(index === ordered.length - 1 && status === "running" ? {} : { finishedAt: iso(Math.max(turn.created, entry.updatedAt)) })
  }))
}

function conversationSnapshot(entry: NativeConversationEntry): ConversationRuntime {
  const turns = sortedTurns(entry)
  const current = turns[turns.length - 1] ?? null
  const firstPrompt = turns.find((turn) => turn.prompt?.trim())?.prompt || ""
  const status = conversationStatus(entry)
  return {
    id: conversationID(entry.target),
    machineId: entry.target.machineID,
    title: entry.target.title,
    agentId: entry.target.agentID,
    initialPrompt: firstPrompt,
    model: entry.currentModel,
    status,
    directory: entry.target.directory,
    currentTurn: current,
    turns,
    error: null,
    createdAt: iso(entry.createdAt),
    updatedAt: iso(entry.updatedAt),
    ...(status === "running" ? {} : { finishedAt: iso(entry.updatedAt) })
  }
}

function notify(entry: NativeConversationEntry): ConversationRuntime {
  const conversation = conversationSnapshot(entry)
  for (const listener of entry.listeners) listener(conversation)
  return conversation
}

function captureUserTurns(entry: NativeConversationEntry, page: MessagePage, before?: string): void {
  // The first page describes the Session state that existed when the v3 controller mounted. Older
  // pages are admitted when the user explicitly pages backward. Tail refreshes do not manufacture
  // new turns from replay IDs: new HR prompts already have one accepted client operation identity.
  const mayDiscoverRuns = !entry.initialPageCaptured || Boolean(before)
  if (!mayDiscoverRuns) return

  let changed = false
  for (const message of page.messages) {
    if (message.info.role !== "user" || !message.info.id) continue
    const prompt = visiblePrompt(message)
    if (!prompt) continue
    const id = `${conversationID(entry.target)}:native-user:${message.info.id}`
    if (
      entry.turns.has(id)
      || [...entry.turns.values()].some((turn) => turn.nativeMessageID === message.info.id)
    ) continue
    const created = Number(message.info.time?.created) || entry.createdAt
    entry.turns.set(id, { id, prompt, created, model: entry.currentModel, nativeMessageID: message.info.id })
    entry.createdAt = Math.min(entry.createdAt, created)
    entry.updatedAt = Math.max(entry.updatedAt, created)
    changed = true
  }
  if (!entry.initialPageCaptured) entry.initialPageCaptured = true
  if (changed) notify(entry)
}

/**
 * A mobile transport can lose the HTTP response after the daemon accepted a prompt. In that case
 * the durable request id remains in localStorage, but the controller never got to append its logical
 * turn. The next authoritative tail read must reconcile that exact pending prompt in-place instead
 * of requiring navigation away and back just to reconstruct the native history.
 *
 * This only runs while a durable pending record exists, so an ordinary external harness turn is
 * never claimed as an HR mutation. Matching the newest visible user envelope also handles handoff
 * wire wrappers because visiblePrompt strips the transferred-context envelope back to what the user
 * actually typed.
 */
function reconcilePendingPromptFromTranscript(entry: NativeConversationEntry, page: MessagePage, before?: string): void {
  if (before) return
  const pending = loadPendingNativeSessionPrompt(entry.target)
  if (!pending) return
  const prompt = canonicalText(pending.text)
  if (!prompt) return

  let userIndex = -1
  for (let index = page.messages.length - 1; index >= 0; index -= 1) {
    const message = page.messages[index]
    if (message.info.role !== "user" || !message.info.id) continue
    if (visiblePrompt(message) !== prompt) continue
    const alreadyClaimed = [...entry.turns.values()].some((turn) => turn.nativeMessageID === message.info.id)
    if (alreadyClaimed) continue
    // After a remount there are no remembered native ids yet, so an older identical user prompt
    // must not be mistaken for this ambiguous delivery. Native and mobile clocks can differ a
    // little; two minutes is deliberately generous without turning historical repeats into proof.
    const nativeCreated = Number(message.info.time?.created) || 0
    if (!entry.initialPageCaptured && (!nativeCreated || nativeCreated < pending.createdAt - PENDING_TRANSCRIPT_CLOCK_SKEW_MS)) continue
    userIndex = index
    break
  }
  if (userIndex < 0) return

  const nativeUser = page.messages[userIndex]
  const id = `${conversationID(entry.target)}:request:${pending.clientRequestId}`
  if (!entry.turns.has(id)) {
    const created = Number(nativeUser.info.time?.created) || pending.createdAt || Date.now()
    const model = pending.model ?? entry.currentModel
    entry.turns.set(id, {
      id,
      prompt,
      created,
      model,
      nativeMessageID: nativeUser.info.id
    })
    if (model) entry.currentModel = model
    entry.createdAt = Math.min(entry.createdAt, created)
    entry.updatedAt = Math.max(entry.updatedAt, created)
  }

  let completed = false
  let completedAt = 0
  let latestAssistant: MessageEnvelope | null = null
  for (let index = userIndex + 1; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role === "user") break
    if (message.info.role === "assistant") latestAssistant = message
    if (entry.target.backend === "opencode" || !nativeAssistantCompleted(message)) continue
    completed = true
    completedAt = Math.max(
      completedAt,
      Number(message.info.time?.completed) || Number(message.info.time?.created) || 0
    )
  }
  if (entry.target.backend === "opencode" && latestAssistant) {
    completed = openCodeAssistantProvesTurnCompleted(latestAssistant)
    if (completed) {
      completedAt = Number(latestAssistant.info.time?.completed) || Number(latestAssistant.info.time?.created) || 0
    }
  }
  if (completed) {
    entry.statusType = "idle"
    entry.forcedStatus = null
    entry.openCodeIdleObservedAt = null
    entry.openCodeRecoveryWatchUntil = 0
    if (completedAt) entry.updatedAt = Math.max(entry.updatedAt, completedAt)
  } else {
    entry.statusType = "running"
    entry.forcedStatus = "running"
    entry.openCodeIdleObservedAt = null
    entry.openCodeRecoveryWatchUntil = 0
  }

  markPendingNativeSessionPromptAccepted(entry.target)
  notify(entry)
}

async function reconcilePromptAfterTransportFailure(entry: NativeConversationEntry): Promise<ConversationRuntime | null> {
  const pending = loadPendingNativeSessionPrompt(entry.target)
  if (!pending) return null
  const expectedTurnID = `${conversationID(entry.target)}:request:${pending.clientRequestId}`

  try {
    let page = await api.loadMessagePage(
      entry.target.config,
      entry.target.sessionID,
      entry.target.directory,
      undefined,
      200,
      true
    )
    page = stabilizePiTailPage(entry, page)
    reconcilePendingPromptFromTranscript(entry, page)
    captureUserTurns(entry, page)
    reconcileOpenCodeTranscriptStatus(entry, page)
    reconcileNativeSessionModel(entry, page)
  } catch {
    return null
  }

  // Only the exact durable request id proves that the ambiguous POST reached this Session. If the
  // transcript does not establish that identity, preserve the transport error and let the caller
  // restore the draft for an explicit same-id retry.
  return entry.turns.has(expectedTurnID) ? conversationSnapshot(entry) : null
}

function appendAcceptedTurn(entry: NativeConversationEntry, prompt: string, model: ModelSelection | null, clientRequestId: string): ConversationRuntime {
  const id = `${conversationID(entry.target)}:request:${clientRequestId}`
  if (!entry.turns.has(id)) {
    const created = Date.now()
    entry.turns.set(id, { id, prompt: canonicalText(prompt), created, model })
    entry.updatedAt = created
  }
  entry.currentModel = model
  entry.forcedStatus = "running"
  entry.statusType = "running"
  entry.openCodeIdleObservedAt = null
  entry.openCodeRecoveryWatchUntil = 0
  return notify(entry)
}

async function refreshStatus(entry: NativeConversationEntry): Promise<void> {
  // OpenCode's legacy /session/status has changed scope across recent releases and can omit a child
  // directory Session entirely. Never put it back in the ordinary idle pre-Send path: a slow status
  // endpoint must not delay prompt delivery before OpenCode even starts reasoning.
  //
  // After HR has accepted a prompt, however, the status read is valuable for the one transcript case
  // that is intentionally ambiguous: an interruption/error or a completed tool step with no final
  // answer. Confirm an idle edge across the existing bounded lifecycle-settle window. If a provider
  // retry starts after that confirmation, keep a bounded recovery watch so the next busy event can
  // retract the red interruption immediately rather than waiting for the eventual final answer.
  const now = Date.now()
  const openCodeRecoveryWatchActive = entry.target.backend === "opencode"
    && entry.openCodeRecoveryWatchUntil > now
  if (entry.target.backend === "opencode" && entry.forcedStatus !== "running" && !openCodeRecoveryWatchActive) return

  try {
    const statuses = await api.listStatuses(entry.target.config)
    const next = statuses[entry.target.sessionID]?.type
    if (typeof next !== "string" || !next) return

    if (entry.target.backend === "opencode") {
      if (nativeSessionIsWorking(next)) {
        entry.statusType = next
        entry.openCodeIdleObservedAt = null
        if (openCodeRecoveryWatchActive && entry.forcedStatus !== "running") {
          entry.forcedStatus = "running"
          entry.openCodeRecoveryWatchUntil = 0
        }
        return
      }
      // Once a terminal-looking interruption has been confirmed, another idle observation during the
      // recovery watch changes nothing. A later busy edge is the only signal that may resurrect it.
      if (entry.forcedStatus !== "running") return
      if (entry.openCodeIdleObservedAt === null) {
        entry.openCodeIdleObservedAt = now
        return
      }
      if (now - entry.openCodeIdleObservedAt < OPENCODE_IDLE_CONFIRM_MS) return
      entry.statusType = next
      entry.forcedStatus = null
      entry.openCodeIdleObservedAt = null
      entry.openCodeRecoveryWatchUntil = now + OPENCODE_RECOVERY_WATCH_MS
      return
    }

    entry.statusType = next
    if (!nativeSessionIsWorking(next)) entry.forcedStatus = null
  } catch {
    // Status is enrichment. The v3 transcript remains the authority when this lightweight read fails.
  }
}

/**
 * ACP writer ownership is a transport detail, not a navigation step. Reading a Session never claims
 * it. The first Send or Stop acquires the writer transparently and caches that fact for this open
 * conversation. OpenCode resolves immediately because it has no ACP single-writer claim boundary.
 */
async function ensureWriter(entry: NativeConversationEntry): Promise<void> {
  if (entry.writerReady) return
  if (entry.writerClaimInFlight) return entry.writerClaimInFlight

  const claim = (async () => {
    const result = await probeNativeSessionContinuation(entry.target)
    if (!result.writable) {
      throw new Error(result.reason || `${entry.target.agentLabel} did not allow this Session to be resumed.`)
    }
    entry.writerReady = true
  })()
  entry.writerClaimInFlight = claim
  try {
    await claim
  } finally {
    if (entry.writerClaimInFlight === claim) entry.writerClaimInFlight = null
  }
}

function requireConversationScope(entry: NativeConversationEntry, conversationId: string): void {
  if (conversationId !== conversationID(entry.target)) {
    throw new Error("Native Session controller received a conversation outside its Session scope")
  }
}

/**
 * Session-scoped I/O implementation for the mature v3 conversation UI.
 *
 * This deliberately does not patch api/taskClient. The observer passes this controller explicitly
 * to WorkThreadConversation, so mounting one Native Session cannot change another conversation's
 * runtime behavior or make call routing depend on module/mount order.
 */
function nativeConversationController(entry: NativeConversationEntry): ConversationController {
  return {
    async loadMessagePage(config, sessionID, directory, before, limit, refreshHistory) {
      let page = await api.loadMessagePage(config, sessionID, directory, before, limit, refreshHistory)
      const activeEntry = entryForRead(config, sessionID, directory)
      if (activeEntry === entry) {
        page = stabilizePiTailPage(entry, page, before)
        reconcilePendingPromptFromTranscript(entry, page, before)
        captureUserTurns(entry, page, before)
        reconcileOpenCodeTranscriptStatus(entry, page, before)
        reconcileNativeSessionModel(entry, page, before)
      }
      return page
    },

    async refreshConversation(_config, conversationId) {
      requireConversationScope(entry, conversationId)
      await refreshStatus(entry)
      return conversationSnapshot(entry)
    },

    async continueConversation(_config, conversationId, input) {
      requireConversationScope(entry, conversationId)
      const body: ConversationContinueInput = input
      const prompt = body.prompt?.trim() || ""
      if (!prompt) throw new Error("A text prompt is required")
      if (body.agentId && body.agentId !== entry.target.agentID) {
        throw new Error("Cross-agent continuation is disabled until single-Session parity is validated")
      }
      await ensureWriter(entry)
      const model = body.model ?? entry.currentModel
      let result
      try {
        result = body.command
          ? await sendNativeSessionCommand(entry.target, body.command.name, body.command.arguments, model)
          : await sendNativeSessionPrompt(entry.target, prompt, model, body.attachments ?? [])
      } catch (reason) {
        if (!body.command) {
          const recovered = await reconcilePromptAfterTransportFailure(entry)
          if (recovered) return recovered
        }
        throw reason
      }
      if (result.status !== "accepted") {
        throw new Error(`${body.command ? "Command" : "Prompt"} delivery is ${result.status}. Retry the same request to reconcile the existing request id.`)
      }
      return appendAcceptedTurn(entry, prompt, model ?? null, result.clientRequestId)
    },

    async stopConversation(_config, conversationId) {
      requireConversationScope(entry, conversationId)
      await ensureWriter(entry)
      const conversationTurns = sortedTurns(entry)
      const latestTurn = conversationTurns[conversationTurns.length - 1]
      const operationToken = latestTurn?.id || entry.target.sessionID
      const result = await stopNativeSession(entry.target, operationToken)
      if (result.status !== "accepted") {
        throw new Error(`Stop delivery is ${result.status}. The existing native cancel request will be reconciled instead of repeated.`)
      }
      entry.forcedStatus = "cancelled"
      entry.statusType = "idle"
      entry.openCodeIdleObservedAt = null
      entry.openCodeRecoveryWatchUntil = 0
      entry.updatedAt = Date.now()
      return notify(entry)
    }
  }
}

export function registerNativeSessionV3Adapter(
  target: NativeSessionSurfaceTarget,
  onConversationUpdate: (conversation: ConversationRuntime) => void
): { conversation: ConversationRuntime; controller: ConversationController; dispose: () => void } {
  const id = conversationID(target)
  let entry = conversations.get(id)
  if (!entry) {
    const now = Date.now()
    entry = {
      target,
      createdAt: now,
      updatedAt: now,
      statusType: target.status?.type || "idle",
      forcedStatus: null,
      openCodeIdleObservedAt: null,
      openCodeRecoveryWatchUntil: 0,
      currentModel: target.model,
      initialPageCaptured: false,
      piTailMessages: [],
      writerReady: !target.requiresExplicitClaim,
      writerClaimInFlight: null,
      turns: new Map(),
      listeners: new Set()
    }
    conversations.set(id, entry)
  } else {
    entry.target = target
    entry.statusType = target.status?.type || entry.statusType
    entry.currentModel = target.model ?? entry.currentModel
    if (!target.requiresExplicitClaim) entry.writerReady = true
  }
  entry.listeners.add(onConversationUpdate)
  return {
    conversation: conversationSnapshot(entry),
    controller: nativeConversationController(entry),
    dispose: () => {
      entry?.listeners.delete(onConversationUpdate)
      if (entry && entry.listeners.size === 0) conversations.delete(id)
    }
  }
}

export function isNativeSessionConversationID(conversationId: string): boolean {
  return conversationId.startsWith(NATIVE_CONVERSATION_ID_PREFIX)
}

/** @deprecated Compatibility alias for callers not yet migrated to the neutral runtime name. */
export const isNativeSessionV3Projection = isNativeSessionConversationID

/**
 * Record a model that was recovered from native metadata after this Session was already mounted.
 *
 * Opening a Session must never wait for model enrichment: the transcript is the product, and the
 * mature v3 contract keeps catalog/model discovery independent of chat availability. An explicit
 * selection the user has since made always wins, so a late enrichment result cannot overwrite it.
 */
export function applyDiscoveredNativeSessionModel(
  target: NativeSessionSurfaceTarget,
  model: ModelSelection | null
): void {
  if (!model) return
  const entry = conversations.get(conversationID(target))
  if (!entry || entry.currentModel) return
  entry.currentModel = model
  notify(entry)
}
