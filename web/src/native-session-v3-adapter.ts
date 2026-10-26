import { api, type MessagePage } from "./api"
import { probeNativeSessionContinuation } from "./native-session-continuation"
import { lastNativeMessageModel } from "./native-session-model"
import { openCodeAssistantHasActivity, openCodeAssistantProvesTurnCompleted } from "./native-session-opencode-reconciliation"
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
import { messageText } from "./message-content"

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
// A rejected provider can make OpenCode accept prompt_async, then produce neither an assistant
// envelope nor a session.status entry. Leave enough room for a real slow first token, then turn
// that orphaned optimistic turn into a visible failure instead of spinning until navigation.
const OPENCODE_SILENT_TURN_GRACE_MS = 15_000

/**
 * OpenCode 2 exports the same native message records as OpenCode: an assistant envelope carries
 * `finish` and `time.completed`, and a reasoning-only envelope can look finished before any
 * user-visible text exists. The transcript-based lifecycle reconciliation and the bounded
 * idle/no-final recovery therefore apply to both; only the backend id differs, for routing and
 * model discovery.
 */
function usesOpenCodeLifecycle(backend: string): boolean {
  return backend === "opencode" || backend === "opencode2"
}

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
  openCodeSilentTurn: { id: string; timer: ReturnType<typeof setTimeout> } | null
  currentModel: ModelSelection | null
  error: { message: string } | null
  initialPageCaptured: boolean
  piTailMessages: MessageEnvelope[]
  /**
   * The last OpenCode 2 tail before its source switched. While a bridge-owned turn runs the page
   * comes from the ACP stream; once it settles the same messages are served from the harness journal
   * under native `msg_...` ids. Keeping the previous page lets a tail read preserve the identity the
   * mounted feed already knows, so the journal copy replaces a turn instead of appearing beside it.
   */
  openCode2TailMessages: MessageEnvelope[]
  writerReady: boolean
  writerClaimInFlight: Promise<void> | null
  turns: Map<string, NativeTurnRecord>
  // Prompts the daemon holds behind the running turn, by native message id. Each becomes a turn only
  // when the transcript shows it started; see reconcileQueuedPrompts.
  queuedPrompts: Map<string, QueuedNativePrompt>
  listeners: Set<(conversation: ConversationRuntime) => void>
  transcriptListeners: Set<() => void>
}

// `seen`: a tail page has shown the row. Until then its absence from a page proves nothing, because
// that page may predate the send.
type QueuedNativePrompt = { prompt: string; model: ModelSelection | null; clientRequestId?: string; seen: boolean }

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

function piPrecedingUserID(index: number, messages: MessageEnvelope[]): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor]
    if (candidate.info.role === "user") return candidate.info.id || null
  }
  return null
}

/**
 * PI can stream a partial ACP assistant envelope, then journal the completed answer under a new
 * id. Only bridge that identity when the same stabilized user turn has one unambiguous assistant
 * envelope on each side and the visible text only grew.
 */
function stabilizePiProgressiveAssistantIDs(
  previous: MessageEnvelope[],
  next: MessageEnvelope[]
): MessageEnvelope[] {
  const previousIDs = new Set(previous.map((message) => message.info.id))
  const nextIDs = new Set(next.map((message) => message.info.id))
  const previousAssistants = new Map<string, MessageEnvelope[]>()
  const nextAssistants = new Map<string, MessageEnvelope[]>()
  const previousAssistantCounts = new Map<string, number>()
  const nextAssistantCounts = new Map<string, number>()

  const collect = (
    messages: MessageEnvelope[],
    groups: Map<string, MessageEnvelope[]>,
    counts: Map<string, number>,
    excludedIDs: Set<string>
  ) => {
    for (let index = 0; index < messages.length; index += 1) {
      const message = messages[index]
      if (message.info.role !== "assistant") continue
      const userID = piPrecedingUserID(index, messages)
      if (!userID) continue
      counts.set(userID, (counts.get(userID) ?? 0) + 1)
      if (excludedIDs.has(message.info.id)) continue
      const candidates = groups.get(userID) ?? []
      candidates.push(message)
      groups.set(userID, candidates)
    }
  }
  collect(previous, previousAssistants, previousAssistantCounts, nextIDs)
  collect(next, nextAssistants, nextAssistantCounts, previousIDs)

  let changed = false
  const replacements = new Map<string, string>()
  for (const [userID, before] of previousAssistants) {
    const after = nextAssistants.get(userID)
    if (previousAssistantCounts.get(userID) !== 1 || nextAssistantCounts.get(userID) !== 1
      || before.length !== 1 || after?.length !== 1) continue
    const previousText = piStableAssistantKey(before[0])?.slice("text:".length)
    const nextText = piStableAssistantKey(after[0])?.slice("text:".length)
    if (!previousText || !nextText || previousText === nextText) continue
    if (!previousText.startsWith(nextText) && !nextText.startsWith(previousText)) continue
    replacements.set(after[0].info.id, before[0].info.id)
  }
  if (!replacements.size) return next

  const usedIDs = new Set<string>()
  const stabilized = next.map((message) => {
    const stableID = replacements.get(message.info.id)
    if (!stableID || usedIDs.has(stableID)) return message
    usedIDs.add(stableID)
    changed = true
    return {
      ...message,
      info: { ...message.info, id: stableID },
      parts: message.parts.map((part) => ({ ...part, messageID: stableID }))
    }
  })
  return changed ? stabilized : next
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
  stabilized = stabilizePiProgressiveAssistantIDs(previous, stabilized)
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
 * OpenCode 2 switches a live turn's transport identity when it settles: the bridge serves the ACP
 * stream while the turn runs, then the harness journal under native `msg_...` ids once it is idle.
 * The feed merge treats an unseen id as a new message, so the same prompt appears twice and the
 * journal's final envelope hangs off the invisible copy. Reuse the previous page's user-message id
 * for the same prompt, one-to-one and nearest in time; genuinely new prompts keep their own id.
 */
function stabilizeOpenCode2TailPage(entry: NativeConversationEntry, page: MessagePage, before?: string): MessagePage {
  if (entry.target.backend !== "opencode2" || before) return page
  const previousUsers = entry.openCode2TailMessages
    .filter((message) => message.info.role === "user" && message.info.id)
    .map((message) => ({
      id: message.info.id,
      prompt: visiblePrompt(message),
      created: Number(message.info.time?.created) || 0,
      used: false
    }))
  const pageIDs = new Set(page.messages.map((message) => message.info.id))
  let changed = false
  const messages = page.messages.map((message) => {
    if (message.info.role !== "user" || !message.info.id) return message
    const prompt = visiblePrompt(message)
    if (!prompt) return message
    const created = Number(message.info.time?.created) || 0
    let best: (typeof previousUsers)[number] | undefined
    let bestDistance = Number.POSITIVE_INFINITY
    for (const candidate of previousUsers) {
      if (candidate.used || candidate.prompt !== prompt) continue
      // The previous identity is already a different message on this page: it belongs to that
      // occurrence, not to this one.
      if (candidate.id !== message.info.id && pageIDs.has(candidate.id)) continue
      const distance = created && candidate.created ? Math.abs(created - candidate.created) : 0
      if (distance > PENDING_TRANSCRIPT_CLOCK_SKEW_MS || distance >= bestDistance) continue
      best = candidate
      bestDistance = distance
    }
    if (!best) return message
    best.used = true
    if (best.id === message.info.id) return message
    changed = true
    const stableID = best.id
    return {
      ...message,
      info: { ...message.info, id: stableID },
      parts: message.parts.map((part) => part.messageID === message.info.id ? { ...part, messageID: stableID } : part)
    }
  })
  entry.openCode2TailMessages = changed ? messages : page.messages
  return changed ? { ...page, messages } : page
}

function stabilizeTailPage(entry: NativeConversationEntry, page: MessagePage, before?: string): MessagePage {
  if (before) return page
  if (entry.target.backend === "pi") return stabilizePiTailPage(entry, page, before)
  if (entry.target.backend === "opencode2") return stabilizeOpenCode2TailPage(entry, page, before)
  return page
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

function sameModel(left: ModelSelection | null, right: ModelSelection | null): boolean {
  return Boolean(left && right
    && left.providerID === right.providerID
    && left.modelID === right.modelID
    && (left.variant || "") === (right.variant || ""))
}

/** Backends whose transcript reads report the Session's own current model on the page itself. */
const PAGE_MODEL_BACKENDS = new Set(["opencode", "opencode2", "codex", "omp", "copilot", "mimo"])

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
  if (!usesOpenCodeLifecycle(entry.target.backend) || before) return
  const recoveryWatchActive = entry.openCodeRecoveryWatchUntil > Date.now()
  // A turn does not have to be started by this view to become terminal here. When the Session is
  // being driven by the desktop app, discovery reports its busy status and the mounted detail must
  // leave Working as soon as that exact turn's final envelope is durable.
  const turnActive = entry.forcedStatus === "running" || nativeSessionIsWorking(entry.statusType)
  if (!turnActive && !recoveryWatchActive) return

  const now = Date.now()
  const latestAssistant = latestOpenCodeAssistantForCurrentTurn(entry, page)
  if (!latestAssistant) return
  const completedByTranscript = openCodeAssistantProvesTurnCompleted(latestAssistant)
  const terminalError = Boolean(latestAssistant.info.error)
  if (!completedByTranscript && !terminalError) {
    // OpenCode creates an empty or reasoning-only assistant envelope before a durable final answer.
    // Neither is evidence that the user turn completed: keep the bounded recovery alive until final
    // text appears or native state proves the turn stopped without one.
    return
  }
  clearOpenCodeSilentTurn(entry)
  if (!completedByTranscript) {
    // A provider/model error envelope is terminal-looking but not definitive on its first edge:
    // OpenCode may still automatically retry the same turn. Keep the exact #351 debounce semantics,
    // but let the transcript supply the second observation when /session/status omits this Session.
    // A real busy status clears openCodeIdleObservedAt in refreshStatus(), so active retries cannot
    // be completed by this fallback while the status endpoint is actually reporting them.
    if (!terminalError || !turnActive) return
    if (entry.openCodeIdleObservedAt === null) {
      entry.openCodeIdleObservedAt = now
      return
    }
    if (now - entry.openCodeIdleObservedAt < OPENCODE_IDLE_CONFIRM_MS) return
  }

  const priorStatus = conversationStatus(entry)
  entry.statusType = "idle"
  entry.forcedStatus = null
  entry.error = null
  entry.openCodeIdleObservedAt = null
  entry.openCodeRecoveryWatchUntil = terminalError ? now + OPENCODE_RECOVERY_WATCH_MS : 0
  const completedAt = Number(latestAssistant.info.time?.completed) || Number(latestAssistant.info.time?.created) || 0
  if (completedAt) entry.updatedAt = Math.max(entry.updatedAt, completedAt)
  if (conversationStatus(entry) !== priorStatus) notify(entry)
}

/** Locate the assistant envelope belonging to the latest logical turn, including repeated prompts. */
function latestOpenCodeAssistantForCurrentTurn(entry: NativeConversationEntry, page: MessagePage): MessageEnvelope | null {
  const orderedTurns = [...entry.turns.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
  const current = orderedTurns[orderedTurns.length - 1]
  const prompt = canonicalText(current?.prompt || "")
  if (!current || !prompt) return null

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
  if (userIndex < 0) return null

  let latestAssistant: MessageEnvelope | null = null
  for (let index = userIndex + 1; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role === "user") break
    if (message.info.role === "assistant") latestAssistant = message
  }
  return latestAssistant
}

function clearOpenCodeSilentTurn(entry: NativeConversationEntry): void {
  if (!entry.openCodeSilentTurn) return
  clearTimeout(entry.openCodeSilentTurn.timer)
  entry.openCodeSilentTurn = null
}

function armOpenCodeSilentTurnRecovery(entry: NativeConversationEntry, turnID: string): void {
  if (!usesOpenCodeLifecycle(entry.target.backend)) return
  clearOpenCodeSilentTurn(entry)
  const timer = setTimeout(() => {
    void settleOpenCodeSilentTurn(entry, turnID)
  }, OPENCODE_SILENT_TURN_GRACE_MS)
  entry.openCodeSilentTurn = { id: turnID, timer }
}

async function settleOpenCodeSilentTurn(entry: NativeConversationEntry, turnID: string): Promise<void> {
  if (entry.openCodeSilentTurn?.id !== turnID) return
  entry.openCodeSilentTurn = null
  const orderedTurns = [...entry.turns.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
  const newestTurn = orderedTurns[orderedTurns.length - 1]
  if (!usesOpenCodeLifecycle(entry.target.backend) || newestTurn?.id !== turnID) return

  const retry = () => {
    const ordered = [...entry.turns.values()].sort((left, right) => left.created - right.created || left.id.localeCompare(right.id))
    const newest = ordered[ordered.length - 1]
    if (entry.forcedStatus === "running" && newest?.id === turnID) armOpenCodeSilentTurnRecovery(entry, turnID)
  }

  let page: MessagePage
  try {
    // Read the transcript first. The status endpoint is legacy enrichment and can hang or omit a
    // child Session; it must never prevent a persisted final answer from reaching the UI.
    page = await api.loadMessagePage(entry.target.config, entry.target.sessionID, entry.target.directory, undefined, 200, true)
    captureUserTurns(entry, page)
    reconcileOpenCodeTranscriptStatus(entry, page)
    const latestAssistant = latestOpenCodeAssistantForCurrentTurn(entry, page)
    if (latestAssistant && openCodeAssistantHasActivity(latestAssistant)) notifyTranscript(entry)
    // Durable final/error reconciliation may already have settled the turn. Reasoning-only activity
    // deliberately does not settle it: continue to native status so a stopped no-final turn becomes
    // an explicit failure instead of a false Ready state or a permanently wedged second Send.
    if (entry.forcedStatus !== "running") return
  } catch {
    // A transport read cannot prove that the native prompt failed. Keep a bounded retry alive.
    retry()
    return
  }

  let statuses: Record<string, { type?: string }> | null = null
  try {
    statuses = await api.listStatuses(entry.target.config, entry.target.directory)
  } catch {
    // Status is optional enrichment. The next bounded recovery or ordinary tail refresh can still
    // discover a response without converting a slow status read into a false failure.
    retry()
    return
  }

  const reported = statuses[entry.target.sessionID]?.type
  if (nativeSessionIsWorking(reported)) {
    retry()
    return
  }

  // prompt_async was accepted, but OpenCode has produced no durable final while native state is no
  // longer working. Preserve a recovery watch: a delayed provider retry can still make the turn
  // running again on a later edge, but the user must never see a successful Ready-without-answer.
  entry.statusType = "idle"
  entry.forcedStatus = null
  entry.error = { message: "OpenCode ended this request without a response. Check the selected model/provider credentials and try again." }
  entry.openCodeIdleObservedAt = null
  entry.openCodeRecoveryWatchUntil = Date.now() + OPENCODE_RECOVERY_WATCH_MS
  entry.updatedAt = Date.now()
  notify(entry)
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
  if (entry.error) return "failed"
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
    ...(index === ordered.length - 1 && entry.error ? { error: entry.error } : {}),
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
    error: entry.error,
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

function notifyTranscript(entry: NativeConversationEntry): void {
  for (const listener of entry.transcriptListeners) listener()
}

function captureUserTurns(entry: NativeConversationEntry, page: MessagePage, before?: string): void {
  // The first page describes the Session state that existed when the v3 controller mounted. Older
  // pages are admitted when the user explicitly pages backward. Codex and OpenCode 2 Sessions can
  // continue in the desktop app while this view stays open: each newly persisted user envelope must
  // become a turn here as well, or its assistant messages have no turn to attach to in the timeline.
  const tailDiscoversRuns = entry.target.backend === "codex" || entry.target.backend === "opencode2"
  const mayDiscoverRuns = !entry.initialPageCaptured || Boolean(before) || tailDiscoversRuns
  if (!mayDiscoverRuns) return

  // A tail page is also the only place a transport identity change becomes visible. Bind an unseen
  // native user row to the turn already representing the same prompt when that turn's own id is no
  // longer on the page, rather than minting a duplicate from the new id space. Only OpenCode 2 changes
  // id space mid-Session; Codex ids are stable, so a matching prompt there is a genuine repeat.
  const reconcileIdentities = entry.target.backend === "opencode2" && entry.initialPageCaptured && !before
  const pageUserIDs = new Set(page.messages
    .filter((message) => message.info.role === "user" && message.info.id)
    .map((message) => message.info.id))
  const claimedTurns = new Set<string>()
  let changed = false
  for (const message of page.messages) {
    if (message.info.role !== "user" || !message.info.id) continue
    // A queued prompt is not a turn yet; reconcileQueuedPrompts hands it over once it starts.
    if (message.info.queued === true) continue
    const prompt = visiblePrompt(message)
    if (!prompt) continue
    const id = `${conversationID(entry.target)}:native-user:${message.info.id}`
    if (entry.turns.has(id)) {
      claimedTurns.add(id)
      continue
    }
    const nativeBound = [...entry.turns.values()].find((turn) => turn.nativeMessageID === message.info.id)
    if (nativeBound) {
      claimedTurns.add(nativeBound.id)
      continue
    }
    const created = Number(message.info.time?.created) || entry.createdAt
    if (reconcileIdentities) {
      let reusable: NativeTurnRecord | undefined
      let reusableDistance = Number.POSITIVE_INFINITY
      for (const turn of entry.turns.values()) {
        if (claimedTurns.has(turn.id) || canonicalText(turn.prompt) !== prompt) continue
        // An id still present on the page belongs to that other occurrence; only a turn whose
        // previous identity has disappeared can be the same message under a new transport id.
        if (turn.nativeMessageID && pageUserIDs.has(turn.nativeMessageID)) continue
        // An accepted request row is the next native envelope for that exact prompt; its local
        // accept clock need not agree with the harness journal's timestamp.
        const acceptedTurn = turn.id.includes(":request:") && !turn.nativeMessageID
        const distance = Math.abs(turn.created - created)
        if (!acceptedTurn && distance > PENDING_TRANSCRIPT_CLOCK_SKEW_MS) continue
        if (distance >= reusableDistance) continue
        reusable = turn
        reusableDistance = distance
      }
      if (reusable) {
        reusable.nativeMessageID = message.info.id
        claimedTurns.add(reusable.id)
        changed = true
        continue
      }
    }
    // A prompt sent from this view already has a durable request identity. Its native user row can
    // arrive on a later tail read; bind that row to the accepted turn instead of drawing it twice.
    const accepted = tailDiscoversRuns
      ? [...entry.turns.values()].reverse().find((turn) =>
        turn.id.includes(":request:") && !turn.nativeMessageID
        && canonicalText(turn.prompt) === prompt
        && Math.abs(turn.created - created) <= PENDING_TRANSCRIPT_CLOCK_SKEW_MS
      )
      : undefined
    if (accepted) {
      accepted.nativeMessageID = message.info.id
      claimedTurns.add(accepted.id)
      continue
    }
    entry.turns.set(id, { id, prompt, created, model: entry.currentModel, nativeMessageID: message.info.id })
    claimedTurns.add(id)
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
    if (message.info.queued === true) continue
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
    if (usesOpenCodeLifecycle(entry.target.backend) || !nativeAssistantCompleted(message)) continue
    completed = true
    completedAt = Math.max(
      completedAt,
      Number(message.info.time?.completed) || Number(message.info.time?.created) || 0
    )
  }
  if (usesOpenCodeLifecycle(entry.target.backend) && latestAssistant) {
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

/**
 * A queued prompt is not a turn. Its row carries `info.queued` and the conversation keeps tracking
 * the turn that is running, so every reply, "getting started" and "working" state stays on that turn.
 * When the daemon dequeues the prompt the flag clears, and only then does it become the newest turn.
 *
 * Tail pages also adopt queued rows this controller never sent - another client, or an app reload
 * while one was waiting - so the hand-over never depends on in-memory send state. A row that vanished
 * from a live page was discarded by a Stop; one missing from an idle page has run, because idle pages
 * can come from the harness journal under the harness's own ids.
 */
function reconcileQueuedPrompts(entry: NativeConversationEntry, page: MessagePage, before?: string): void {
  if (before) return
  const byID = new Map(page.messages.map((message) => [message.info.id, message]))
  for (const message of page.messages) {
    if (message.info.role !== "user" || message.info.queued !== true || !message.info.id) continue
    const tracked = entry.queuedPrompts.get(message.info.id)
    if (tracked) {
      tracked.seen = true
      continue
    }
    if ([...entry.turns.values()].some((turn) => turn.nativeMessageID === message.info.id)) continue
    const prompt = visiblePrompt(message)
    if (prompt) entry.queuedPrompts.set(message.info.id, { prompt, model: entry.currentModel, seen: true })
  }
  if (!entry.queuedPrompts.size) return

  const working = entry.forcedStatus === "running" || nativeSessionIsWorking(entry.statusType)
  let started = 0
  for (const [messageID, queued] of [...entry.queuedPrompts]) {
    const message = byID.get(messageID)
    if (message?.info.queued === true) continue
    if (!message && working) {
      if (queued.seen) entry.queuedPrompts.delete(messageID)
      continue
    }
    entry.queuedPrompts.delete(messageID)
    const scope = conversationID(entry.target)
    const id = queued.clientRequestId ? `${scope}:request:${queued.clientRequestId}` : `${scope}:native-user:${messageID}`
    if (entry.turns.has(id)) continue
    // Later than every turn already known, in queue order: the newest turn is the current one.
    const created = Math.max(Date.now(), ...[...entry.turns.values()].map((turn) => turn.created + 1)) + started
    entry.turns.set(id, { id, prompt: queued.prompt, created, model: queued.model, ...(message ? { nativeMessageID: messageID } : {}) })
    entry.updatedAt = Math.max(entry.updatedAt, created)
    started += 1
  }
  if (started) notify(entry)
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
    page = stabilizeTailPage(entry, page)
    reconcilePendingPromptFromTranscript(entry, page)
    captureUserTurns(entry, page)
    reconcileQueuedPrompts(entry, page)
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

function appendAcceptedTurn(entry: NativeConversationEntry, prompt: string, model: ModelSelection | null, clientRequestId: string, nativeMessageID?: string): ConversationRuntime {
  const id = `${conversationID(entry.target)}:request:${clientRequestId}`
  if (!entry.turns.has(id)) {
    const created = Date.now()
    entry.turns.set(id, { id, prompt: canonicalText(prompt), created, model, ...(nativeMessageID ? { nativeMessageID } : {}) })
    entry.updatedAt = created
  }
  entry.currentModel = model
  entry.forcedStatus = "running"
  entry.statusType = "running"
  entry.openCodeIdleObservedAt = null
  entry.openCodeRecoveryWatchUntil = 0
  entry.error = null
  const conversation = notify(entry)
  armOpenCodeSilentTurnRecovery(entry, id)
  return conversation
}

async function refreshStatus(entry: NativeConversationEntry): Promise<void> {
  // OpenCode's legacy /session/status has changed scope across recent releases and can omit a child
  // directory Session entirely. Never put it back in the ordinary idle pre-Send path: a slow status
  // endpoint must not delay prompt delivery before OpenCode even starts reasoning.
  //
  // After HR has accepted a prompt, status remains useful to detect busy/retry edges. An idle edge is
  // not success proof: real OpenCode can report idle while the newest assistant envelope contains
  // reasoning and `finish: stop` but no user-visible final text. Keep the optimistic turn running
  // until the durable transcript proves a final answer or the bounded silent-turn recovery converts
  // stable idle/no-final state into an explicit failure.
  const now = Date.now()
  const openCodeRecoveryWatchActive = usesOpenCodeLifecycle(entry.target.backend)
    && entry.openCodeRecoveryWatchUntil > now
  const openCodeTurnActive = entry.forcedStatus === "running" || nativeSessionIsWorking(entry.statusType)
  if (usesOpenCodeLifecycle(entry.target.backend)
    && !openCodeTurnActive
    && !openCodeRecoveryWatchActive) return

  try {
    const statuses = await api.listStatuses(entry.target.config)
    const next = statuses[entry.target.sessionID]?.type
    if (typeof next !== "string" || !next) return

    if (usesOpenCodeLifecycle(entry.target.backend)) {
      if (nativeSessionIsWorking(next)) {
        entry.statusType = next
        entry.error = null
        entry.openCodeIdleObservedAt = null
        if (openCodeRecoveryWatchActive && entry.forcedStatus !== "running") {
          entry.forcedStatus = "running"
          entry.openCodeRecoveryWatchUntil = 0
        }
        return
      }
      // Once an explicit no-final failure has been confirmed, another idle observation during the
      // recovery watch changes nothing. A later busy edge is the only signal that may resurrect it.
      if (entry.forcedStatus !== "running") {
        // An external turn has no optimistic request state to keep alive. Native idle alone still
        // does not prove a final answer exists, so let the durable transcript settle it; the periodic
        // mounted reconcile keeps reading that tail while this status remains working.
        if (entry.openCodeIdleObservedAt === null) entry.openCodeIdleObservedAt = now
        // A turn that stopped without final text (aborted elsewhere, reasoning-only) would otherwise
        // stay Working forever. After the same grace an own prompt gets, trust stable native idle.
        if (now - entry.openCodeIdleObservedAt >= OPENCODE_SILENT_TURN_GRACE_MS && nativeSessionIsWorking(entry.statusType)) {
          entry.statusType = next
          entry.openCodeIdleObservedAt = null
          notify(entry)
        }
        return
      }
      if (entry.openCodeIdleObservedAt === null) {
        entry.openCodeIdleObservedAt = now
        return
      }
      if (now - entry.openCodeIdleObservedAt < OPENCODE_IDLE_CONFIRM_MS) return
      entry.statusType = next
      // Do not clear forcedStatus here. Native idle is enrichment, not final-answer evidence. The
      // transcript or bounded silent-turn recovery owns the terminal transition.
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
        page = stabilizeTailPage(entry, page, before)
        reconcilePendingPromptFromTranscript(entry, page, before)
        captureUserTurns(entry, page, before)
        reconcileQueuedPrompts(entry, page, before)
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
      // A queued prompt is not a turn yet: the conversation keeps tracking the turn that is running,
      // and the prompt becomes a turn when the transcript shows the daemon started it.
      if (result.outcome?.disposition === "queued" && result.outcome.messageID) {
        entry.queuedPrompts.set(result.outcome.messageID, {
          prompt: canonicalText(prompt),
          model: model ?? null,
          clientRequestId: result.clientRequestId,
          seen: false
        })
        entry.error = null
        notifyTranscript(entry)
        return notify(entry)
      }
      return appendAcceptedTurn(entry, prompt, model ?? null, result.clientRequestId, result.outcome?.messageID)
    },

    async cancelQueuedPrompt(_config, conversationId, messageID) {
      requireConversationScope(entry, conversationId)
      await ensureWriter(entry)
      await api.cancelQueuedPrompt(entry.target.config, entry.target.sessionID, messageID, entry.target.directory)
      entry.queuedPrompts.delete(messageID)
      notifyTranscript(entry)
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
      entry.error = null
      // A Stop discards everything still queued behind the turn, in the daemon as here.
      entry.queuedPrompts.clear()
      clearOpenCodeSilentTurn(entry)
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
  onConversationUpdate: (conversation: ConversationRuntime) => void,
  onTranscriptRefresh?: () => void
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
      openCodeSilentTurn: null,
      currentModel: target.model,
      error: null,
      initialPageCaptured: false,
      piTailMessages: [],
      openCode2TailMessages: [],
      writerReady: !target.requiresExplicitClaim,
      writerClaimInFlight: null,
      turns: new Map(),
      queuedPrompts: new Map(),
      listeners: new Set(),
      transcriptListeners: new Set()
    }
    conversations.set(id, entry)
  } else {
    entry.target = target
    entry.statusType = target.status?.type || entry.statusType
    entry.currentModel = target.model ?? entry.currentModel
    if (!target.requiresExplicitClaim) entry.writerReady = true
  }
  entry.listeners.add(onConversationUpdate)
  if (onTranscriptRefresh) entry.transcriptListeners.add(onTranscriptRefresh)
  return {
    conversation: conversationSnapshot(entry),
    controller: nativeConversationController(entry),
    dispose: () => {
      entry?.listeners.delete(onConversationUpdate)
      if (onTranscriptRefresh) entry?.transcriptListeners.delete(onTranscriptRefresh)
      if (entry && entry.listeners.size === 0) clearOpenCodeSilentTurn(entry)
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
