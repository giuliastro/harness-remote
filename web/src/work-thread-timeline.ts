import {
  conversationRuntimeFromTask,
  conversationTurnSessionID,
  conversationTurns,
  type ConversationRuntime,
  type ConversationTurn
} from "./conversation-runtime"
import type { MachineTask, MachineTaskRun } from "./taskClient"
import type { MessageEnvelope, MessagePart } from "./types"

/** Synthetic role for Harness Remote's own timeline lines, distinct from every harness role. */
export const CONVERSATION_EVENT_ROLE = "conversation-event"

export type WorkThreadMessageMeta = {
  kind: "native" | "event" | "synthetic-user" | "fallback-result" | "error"
  agentId?: string
  agentLabel?: string
  agentBackend?: string
  runId?: string
  active?: boolean
}

export type WorkThreadMessage = MessageEnvelope & {
  taskdesk?: WorkThreadMessageMeta
}

export type WorkThreadAgentMeta = Record<string, { label: string; backend: string }>

type TurnWithError = ConversationTurn & { error?: { message?: string } | string | null }

type NativeTurn = {
  user: MessageEnvelope | null
  messages: MessageEnvelope[]
}

function runsFor(task: MachineTask): MachineTaskRun[] {
  const runs = Array.isArray(task.runs) && task.runs.length ? task.runs : task.run ? [task.run] : []
  return [...runs].sort((left, right) => {
    const sequence = (Number(left.sequence) || 0) - (Number(right.sequence) || 0)
    if (sequence) return sequence
    return Date.parse(left.startedAt || "") - Date.parse(right.startedAt || "")
  })
}

export function workThreadRuns(task: MachineTask): MachineTaskRun[] {
  return runsFor(task)
}

export function runSessionID(run?: MachineTaskRun | ConversationTurn | null): string | null {
  return conversationTurnSessionID(run)
}

function textParts(parts: MessagePart[] | undefined): string {
  return (parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function canonicalText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim()
}

/**
 * TaskDesk handoff/context packets are transport, not user dialogue. The native Session remains the
 * source of turn boundaries, but the visible user instruction is the persisted Run prompt.
 */
function userInstructionFromNative(text: string): string {
  const value = canonicalText(text)
  if (!value.startsWith("You are taking over an existing TaskDesk task.")) return value
  const marker = "\nUSER INSTRUCTION\n"
  const start = value.indexOf(marker)
  if (start < 0) return value
  const instructionStart = start + marker.length
  const footer = "\n\nContinue from the shared workspace and the transferred Task Context."
  const end = value.indexOf(footer, instructionStart)
  return canonicalText(value.slice(instructionStart, end >= 0 ? end : undefined))
}

function syntheticMessage({
  id,
  role,
  sessionID,
  created,
  text,
  parts,
  meta,
  error
}: {
  id: string
  role: string
  sessionID: string
  created: number
  text?: string
  parts?: MessagePart[]
  meta: WorkThreadMessageMeta
  error?: { name?: string; message?: string; data?: Record<string, unknown> }
}): WorkThreadMessage {
  return {
    info: {
      id,
      role,
      sessionID,
      time: { created },
      ...(error ? { error } : {})
    },
    parts: [
      ...(text ? [{ id: `${id}:text`, messageID: id, type: "text", text }] : []),
      ...(parts ?? []).map((part, index) => ({
        ...part,
        id: `${id}:attachment:${index}:${part.id || index}`,
        messageID: id
      }))
    ],
    taskdesk: meta
  }
}

function turnStart(conversation: ConversationRuntime, turn: ConversationTurn, index: number): number {
  const parsed = Date.parse(turn.startedAt || "")
  if (Number.isFinite(parsed)) return parsed
  const taskCreated = Date.parse(conversation.createdAt || "")
  return (Number.isFinite(taskCreated) ? taskCreated : Date.now()) + index * 10
}

function modelLabel(turn?: ConversationTurn | null): string {
  const model = turn?.model
  if (!model?.modelID) return ""
  return `${model.modelID}${model.variant ? ` · ${model.variant}` : ""}`
}

function sameModel(left?: ConversationTurn | null, right?: ConversationTurn | null): boolean {
  const a = left?.model
  const b = right?.model
  if (!a && !b) return true
  if (!a || !b) return false
  return a.providerID === b.providerID && a.modelID === b.modelID && (a.variant || "") === (b.variant || "")
}

function eventText(turns: ConversationTurn[], index: number, agents: WorkThreadAgentMeta): string | null {
  if (index === 0) return null
  const turn = turns[index]
  const previous = turns[index - 1]
  const currentAgent = turn.agentId || ""
  const previousAgent = previous.agentId || ""
  const label = agents[currentAgent]?.label || currentAgent || "coding agent"
  const model = modelLabel(turn)

  if (currentAgent && currentAgent !== previousAgent) {
    return `Continued with ${label}${model ? ` · ${model}` : ""} · context transferred`
  }

  if (!sameModel(previous, turn) && model) {
    return `Model changed to ${model} · continuing with ${label}`
  }

  return null
}

/**
 * Native user messages are the only conversation boundary. We deliberately do not use timestamps,
 * replay timing, assistant text prefixes or "latest N turns" to guess ownership.
 */
function nativeTurns(messages: MessageEnvelope[]): NativeTurn[] {
  const turns: NativeTurn[] = []
  let current: NativeTurn | null = null

  for (const message of messages) {
    if (message.info.role === "user") {
      if (current) turns.push(current)
      current = { user: message, messages: [message] }
      continue
    }
    if (!current) current = { user: null, messages: [] }
    current.messages.push(message)
  }
  if (current) turns.push(current)
  return turns
}

function turnsForRunPrompts(messages: MessageEnvelope[], prompts: string[]): Array<NativeTurn | null> {
  const turns = nativeTurns(messages)
  const matchesByPrompt = new Map<string, NativeTurn[]>()

  for (const turn of turns) {
    if (!turn.user) continue
    const visible = userInstructionFromNative(textParts(turn.user.parts))
    if (!visible) continue
    const matches = matchesByPrompt.get(visible) ?? []
    matches.push(turn)
    matchesByPrompt.set(visible, matches)
  }

  const usedByPrompt = new Map<string, number>()
  return prompts.map((prompt) => {
    const key = canonicalText(prompt)
    if (!key) return null
    const candidates = matchesByPrompt.get(key) ?? []
    const ordinal = usedByPrompt.get(key) ?? 0
    usedByPrompt.set(key, ordinal + 1)
    return candidates[ordinal] ?? null
  })
}

function assistantParts(messages: MessageEnvelope[], aggregateID: string): MessagePart[] {
  const parts: MessagePart[] = []
  const seenMessages = new Set<string>()
  const toolIndexes = new Map<string, number>()

  for (const message of messages) {
    if (message.info.role !== "assistant") continue
    const messageIdentity = `${message.info.sessionID}:${message.info.id}`
    if (seenMessages.has(messageIdentity)) continue
    seenMessages.add(messageIdentity)

    for (const raw of message.parts ?? []) {
      const part: MessagePart = {
        ...raw,
        id: `${message.info.id}:${raw.id}`,
        messageID: aggregateID
      }

      // A callID is protocol identity, not a content heuristic. Keep the newest state for the same
      // native tool call while preserving the call's original position in the logical turn.
      if (part.type === "tool" && part.callID) {
        const prior = toolIndexes.get(part.callID)
        if (prior !== undefined) {
          parts[prior] = { ...part, id: parts[prior].id }
          continue
        }
        toolIndexes.set(part.callID, parts.length)
      }
      parts.push(part)
    }
  }
  return parts
}

function turnErrorText(conversation: ConversationRuntime, turn: ConversationTurn): string {
  const persisted = (turn as TurnWithError).error
  if (typeof persisted === "string") return persisted.trim()
  if (persisted?.message) return persisted.message.trim()
  if (turn.id && turn.id === conversation.currentTurn?.id && conversation.error?.message) return conversation.error.message.trim()
  return ""
}

/**
 * OpenCode can journal an interrupted assistant attempt and then recover inside the same user turn.
 * Showing the first error forever made a successful retry arrive underneath a red "response
 * interrupted" banner. Walk backward through meaningful assistant envelopes: a later successful
 * envelope clears an earlier transient error, while a genuinely terminal error still survives.
 */
function terminalNativeAssistantError(assistants: MessageEnvelope[]): MessageEnvelope["info"]["error"] | undefined {
  for (let index = assistants.length - 1; index >= 0; index -= 1) {
    const message = assistants[index]
    if (message.info.error) return message.info.error
    const info = message.info as MessageEnvelope["info"] & { finish?: unknown }
    const meaningful = Boolean(message.info.time?.completed)
      || (typeof info.finish === "string" && Boolean(info.finish.trim()))
      || message.parts.some((part) => {
        if (part.type === "tool") return true
        if (part.type === "reasoning" || part.type === "text") return Boolean(part.text?.trim())
        return false
      })
    if (meaningful) return undefined
  }
  return undefined
}

function assistantForTurn({
  conversation,
  turn,
  index,
  nativeTurn,
  session,
  agentID,
  agentLabel,
  agentBackend
}: {
  conversation: ConversationRuntime
  turn: ConversationTurn
  index: number
  nativeTurn: NativeTurn | null
  session: string
  agentID: string
  agentLabel?: string
  agentBackend?: string
}): WorkThreadMessage | null {
  const assistants = (nativeTurn?.messages ?? []).filter((message) => message.info.role === "assistant")
  const outcome = typeof turn.outcome === "string" ? turn.outcome.trim() : ""
  const persistedError = turn.status === "failed" ? turnErrorText(conversation, turn) : ""
  const nativeError = terminalNativeAssistantError(assistants)
  const active = Boolean(turn.id && turn.id === conversation.currentTurn?.id && (conversation.status === "starting" || conversation.status === "running"))

  if (!assistants.length && !outcome && !persistedError) return null

  const id = `work-thread:${conversation.id}:turn:${turn.id || index}:assistant`
  const parts = assistantParts(assistants, id)
  if (outcome && !parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim())) {
    parts.push({ id: `${id}:outcome`, messageID: id, type: "text", text: outcome })
  }

  const created = Number(assistants[0]?.info?.time?.created) || turnStart(conversation, turn, index) + 1
  const error = nativeError || (persistedError ? { name: "TaskRunError", message: persistedError } : undefined)
  return {
    info: {
      id,
      role: "assistant",
      sessionID: session,
      time: { created },
      ...(error ? { error } : {})
    },
    parts,
    taskdesk: {
      kind: assistants.length ? "native" : persistedError && !outcome ? "error" : "fallback-result",
      runId: turn.id,
      agentId: agentID,
      agentLabel,
      agentBackend,
      active
    }
  }
}

export function buildConversationTimeline(
  conversation: ConversationRuntime,
  messagesBySession: Record<string, MessageEnvelope[]>,
  agents: WorkThreadAgentMeta
): WorkThreadMessage[] {
  const turns = conversationTurns(conversation)
  if (turns.length === 0) {
    const created = Date.parse(conversation.createdAt || "")
    return conversation.initialPrompt?.trim() ? [syntheticMessage({
      id: `work-thread:${conversation.id}:objective`,
      role: "user",
      sessionID: `work-thread:${conversation.id}`,
      created: Number.isFinite(created) ? created : Date.now(),
      text: conversation.initialPrompt.trim(),
      meta: {
        kind: "synthetic-user",
        agentId: conversation.agentId,
        agentLabel: agents[conversation.agentId]?.label,
        agentBackend: agents[conversation.agentId]?.backend
      }
    })] : []
  }

  const turnIndexesBySession = new Map<string, number[]>()
  turns.forEach((turn, index) => {
    const session = conversationTurnSessionID(turn)
    if (!session) return
    const indexes = turnIndexesBySession.get(session) ?? []
    indexes.push(index)
    turnIndexesBySession.set(session, indexes)
  })

  const nativeTurnByIndex = new Map<number, NativeTurn | null>()
  for (const [session, indexes] of turnIndexesBySession) {
    const prompts = indexes.map((index) => (turns[index].prompt || (index === 0 ? conversation.initialPrompt : "")).trim())
    const matched = turnsForRunPrompts(messagesBySession[session] ?? [], prompts)
    indexes.forEach((turnIndex, ordinal) => nativeTurnByIndex.set(turnIndex, matched[ordinal] ?? null))
  }

  const timeline: WorkThreadMessage[] = []
  turns.forEach((turn, index) => {
    const start = turnStart(conversation, turn, index)
    const session = conversationTurnSessionID(turn) || `work-thread:${conversation.id}`
    const agentID = turn.agentId || conversation.agentId
    const agent = agents[agentID]
    const event = eventText(turns, index, agents)
    if (event) {
      timeline.push(syntheticMessage({
        id: `work-thread:${conversation.id}:turn:${turn.id || index}:handoff`,
        role: CONVERSATION_EVENT_ROLE,
        sessionID: session,
        created: start - 1,
        text: event,
        meta: { kind: "event", runId: turn.id, agentId: agentID, agentLabel: agent?.label, agentBackend: agent?.backend }
      }))
    }

    const prompt = (turn.prompt || (index === 0 ? conversation.initialPrompt : "")).trim()
    if (prompt) {
      const nativeUserParts = nativeTurnByIndex.get(index)?.user?.parts ?? []
      const attachmentParts = nativeUserParts.filter((part) =>
        part.type === "file" || part.type === "image" || Boolean(part.mime && part.url)
      )
      timeline.push(syntheticMessage({
        id: `work-thread:${conversation.id}:turn:${turn.id || index}:user`,
        role: "user",
        sessionID: session,
        created: start,
        text: prompt,
        parts: attachmentParts,
        meta: { kind: "synthetic-user", runId: turn.id, agentId: agentID, agentLabel: agent?.label, agentBackend: agent?.backend }
      }))
    }

    const assistant = assistantForTurn({
      conversation,
      turn,
      index,
      nativeTurn: nativeTurnByIndex.get(index) ?? null,
      session,
      agentID,
      agentLabel: agent?.label,
      agentBackend: agent?.backend
    })
    if (assistant) timeline.push(assistant)
  })

  return timeline
}

/**
 * Legacy Task/Run entry point. Task-backed callers adapt inward to the neutral conversation domain;
 * Native Sessions never adapt outward to Task/Run.
 */
export function buildWorkThreadTimeline(
  task: MachineTask,
  messagesBySession: Record<string, MessageEnvelope[]>,
  agents: WorkThreadAgentMeta
): WorkThreadMessage[] {
  return buildConversationTimeline(conversationRuntimeFromTask(task), messagesBySession, agents)
}
