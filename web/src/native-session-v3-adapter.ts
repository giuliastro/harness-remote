import { api, type MessagePage } from "./api"
import { probeNativeSessionContinuation } from "./native-session-continuation"
import { lastNativeMessageModel } from "./native-session-model"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import { sendNativeSessionCommand, sendNativeSessionPrompt } from "./native-session-prompt"
import { stopNativeSession } from "./native-session-stop"
import type { ConversationContinueInput, ConversationController } from "./conversation-controller"
import type { ConversationRuntime, ConversationTurn } from "./conversation-runtime"
import type { MessageEnvelope, ModelSelection, ServerConfig } from "./types"

// Keep the value stable so drafts/local UI identity survive the architecture migration.
const NATIVE_CONVERSATION_ID_PREFIX = "native-session-v3:"

type NativeTurnRecord = {
  id: string
  prompt: string
  created: number
  model: ModelSelection | null
}

type NativeConversationEntry = {
  target: NativeSessionSurfaceTarget
  createdAt: number
  updatedAt: number
  statusType: string
  forcedStatus: "running" | "cancelled" | null
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
 * PI exposes two legitimate identities for one completed assistant reply: while the turn is live the
 * ACP stream has one message id, then the authoritative JSONL journal can expose the same reply with
 * its persisted record id. The mature v3 tail merge intentionally retains unseen ids, so letting that
 * transport identity swap through would display the same answer twice after Stop/reopen or any other
 * live-to-journal transition.
 *
 * Preserve the prior browser identity only for one unambiguous assistant final-text match. Reasoning
 * may accompany the final text because PI journals thinking and the answer in the same assistant
 * record. Repeated identical answers stay distinct because neither side may contain more than one
 * candidate. Errors and tool-bearing messages keep their native identities unchanged.
 */
function piStableAssistantKey(message: MessageEnvelope): string | null {
  if (message.info.role !== "assistant" || message.info.error || !message.parts.length) return null
  if (message.parts.some((part) => part.type !== "text" && part.type !== "reasoning")) return null
  const textParts = message.parts.filter((part) => part.type === "text" && typeof part.text === "string")
  if (!textParts.length) return null
  const text = canonicalText(textParts.map((part) => part.text || "").join("\n"))
  return text ? text : null
}

export function stabilizePiTailMessageIDs(
  previous: MessageEnvelope[],
  next: MessageEnvelope[]
): MessageEnvelope[] {
  if (!previous.length || !next.length) return next

  const previousIDs = new Set(previous.map((message) => message.info.id))
  const nextIDs = new Set(next.map((message) => message.info.id))
  const previousByKey = new Map<string, MessageEnvelope[]>()
  const nextKeyCounts = new Map<string, number>()

  for (const message of previous) {
    if (nextIDs.has(message.info.id)) continue
    const key = piStableAssistantKey(message)
    if (!key) continue
    const candidates = previousByKey.get(key) ?? []
    candidates.push(message)
    previousByKey.set(key, candidates)
  }
  for (const message of next) {
    if (previousIDs.has(message.info.id)) continue
    const key = piStableAssistantKey(message)
    if (key) nextKeyCounts.set(key, (nextKeyCounts.get(key) ?? 0) + 1)
  }

  let changed = false
  const stabilized = next.map((message) => {
    if (previousIDs.has(message.info.id)) return message
    const key = piStableAssistantKey(message)
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
  if (entry.target.backend !== "opencode" || before || entry.forcedStatus !== "running") return

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

  let completedAt = 0
  let completed = false
  for (let index = userIndex + 1; index < page.messages.length; index += 1) {
    const message = page.messages[index]
    if (message.info.role === "user") break
    if (!nativeAssistantCompleted(message)) continue
    completed = true
    completedAt = Math.max(completedAt, Number(message.info.time?.completed) || Number(message.info.time?.created) || 0)
  }
  if (!completed) return

  const priorStatus = conversationStatus(entry)
  entry.statusType = "idle"
  entry.forcedStatus = null
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
    if (entry.turns.has(id)) continue
    const created = Number(message.info.time?.created) || entry.createdAt
    entry.turns.set(id, { id, prompt, created, model: entry.currentModel })
    entry.createdAt = Math.min(entry.createdAt, created)
    entry.updatedAt = Math.max(entry.updatedAt, created)
    changed = true
  }
  if (!entry.initialPageCaptured) entry.initialPageCaptured = true
  if (changed) notify(entry)
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
  return notify(entry)
}

async function refreshStatus(entry: NativeConversationEntry): Promise<void> {
  // OpenCode's legacy /session/status has changed scope across recent releases and can omit a child
  // directory Session entirely. More importantly, this read sits in the v3 pre-Send reconciliation
  // path, so a slow status endpoint delays prompt delivery before OpenCode even starts reasoning.
  // Once HR accepts an OpenCode prompt, reconcileOpenCodeTranscriptStatus clears Working only after
  // the same native transcript consumed by the UI contains a terminal assistant envelope.
  if (entry.target.backend === "opencode") return

  try {
    const statuses = await api.listStatuses(entry.target.config)
    const next = statuses[entry.target.sessionID]?.type
    if (typeof next === "string" && next) {
      entry.statusType = next
      if (!nativeSessionIsWorking(next)) entry.forcedStatus = null
    }
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
      const result = body.command
        ? await sendNativeSessionCommand(entry.target, body.command.name, body.command.arguments, model)
        : await sendNativeSessionPrompt(entry.target, prompt, model, body.attachments ?? [])
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
