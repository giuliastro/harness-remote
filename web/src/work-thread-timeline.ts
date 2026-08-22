import type { MachineTask, MachineTaskRun } from "./taskClient"
import type { MessageEnvelope, MessagePart } from "./types"

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

type RunWithError = MachineTaskRun & { error?: { message?: string } | string | null }

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

export function runSessionID(run?: MachineTaskRun | null): string | null {
  return run?.sessionId || run?.sessionID || null
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
  meta,
  error
}: {
  id: string
  role: string
  sessionID: string
  created: number
  text?: string
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
    parts: text ? [{ id: `${id}:text`, messageID: id, type: "text", text }] : [],
    taskdesk: meta
  }
}

function runStart(task: MachineTask, run: MachineTaskRun, index: number): number {
  const parsed = Date.parse(run.startedAt || "")
  if (Number.isFinite(parsed)) return parsed
  const taskCreated = Date.parse(task.createdAt || "")
  return (Number.isFinite(taskCreated) ? taskCreated : Date.now()) + index * 10
}

function modelLabel(run?: MachineTaskRun | null): string {
  const model = run?.model
  if (!model?.modelID) return ""
  return `${model.modelID}${model.variant ? ` · ${model.variant}` : ""}`
}

function sameModel(left?: MachineTaskRun | null, right?: MachineTaskRun | null): boolean {
  const a = left?.model
  const b = right?.model
  if (!a && !b) return true
  if (!a || !b) return false
  return a.providerID === b.providerID && a.modelID === b.modelID && (a.variant || "") === (b.variant || "")
}

function eventText(runs: MachineTaskRun[], index: number, agents: WorkThreadAgentMeta): string | null {
  if (index === 0) return null
  const run = runs[index]
  const previous = runs[index - 1]
  const currentAgent = run.agentId || ""
  const previousAgent = previous.agentId || ""
  const label = agents[currentAgent]?.label || currentAgent || "coding agent"
  const model = modelLabel(run)

  if (currentAgent && currentAgent !== previousAgent) {
    return `Continued with ${label}${model ? ` · ${model}` : ""} · context transferred`
  }

  if (!sameModel(previous, run) && model) {
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

function runErrorText(task: MachineTask, run: MachineTaskRun): string {
  const persisted = (run as RunWithError).error
  if (typeof persisted === "string") return persisted.trim()
  if (persisted?.message) return persisted.message.trim()
  if (run.id && run.id === task.run?.id && task.error?.message) return task.error.message.trim()
  return ""
}

function assistantForRun({
  task,
  run,
  index,
  turn,
  session,
  agentID,
  agentLabel,
  agentBackend
}: {
  task: MachineTask
  run: MachineTaskRun
  index: number
  turn: NativeTurn | null
  session: string
  agentID: string
  agentLabel?: string
  agentBackend?: string
}): WorkThreadMessage | null {
  const assistants = (turn?.messages ?? []).filter((message) => message.info.role === "assistant")
  const outcome = typeof run.outcome === "string" ? run.outcome.trim() : ""
  const persistedError = run.status === "failed" ? runErrorText(task, run) : ""
  const nativeError = assistants.find((message) => message.info.error)?.info.error
  const active = Boolean(run.id && run.id === task.run?.id && (task.status === "starting" || task.status === "running"))

  if (!assistants.length && !outcome && !persistedError) return null

  const id = `work-thread:${task.id}:run:${run.id || index}:assistant`
  const parts = assistantParts(assistants, id)
  if (outcome && !parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.trim())) {
    parts.push({ id: `${id}:outcome`, messageID: id, type: "text", text: outcome })
  }

  const created = Number(assistants[0]?.info?.time?.created) || runStart(task, run, index) + 1
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
      runId: run.id,
      agentId: agentID,
      agentLabel,
      agentBackend,
      active
    }
  }
}

export function buildWorkThreadTimeline(
  task: MachineTask,
  messagesBySession: Record<string, MessageEnvelope[]>,
  agents: WorkThreadAgentMeta
): WorkThreadMessage[] {
  const runs = runsFor(task)
  if (runs.length === 0) {
    const created = Date.parse(task.createdAt || "")
    return task.prompt?.trim() ? [syntheticMessage({
      id: `work-thread:${task.id}:objective`,
      role: "user",
      sessionID: `work-thread:${task.id}`,
      created: Number.isFinite(created) ? created : Date.now(),
      text: task.prompt.trim(),
      meta: { kind: "synthetic-user", agentId: task.agentId, agentLabel: agents[task.agentId]?.label, agentBackend: agents[task.agentId]?.backend }
    })] : []
  }

  const runIndexesBySession = new Map<string, number[]>()
  runs.forEach((run, index) => {
    const session = runSessionID(run)
    if (!session) return
    const indexes = runIndexesBySession.get(session) ?? []
    indexes.push(index)
    runIndexesBySession.set(session, indexes)
  })

  const turnByRunIndex = new Map<number, NativeTurn | null>()
  for (const [session, indexes] of runIndexesBySession) {
    const prompts = indexes.map((index) => (runs[index].prompt || (index === 0 ? task.prompt : "")).trim())
    const matched = turnsForRunPrompts(messagesBySession[session] ?? [], prompts)
    indexes.forEach((runIndex, ordinal) => turnByRunIndex.set(runIndex, matched[ordinal] ?? null))
  }

  const timeline: WorkThreadMessage[] = []
  runs.forEach((run, index) => {
    const start = runStart(task, run, index)
    const session = runSessionID(run) || `work-thread:${task.id}`
    const agentID = run.agentId || task.agentId
    const agent = agents[agentID]
    const event = eventText(runs, index, agents)
    if (event) {
      timeline.push(syntheticMessage({
        id: `work-thread:${task.id}:run:${run.id || index}:handoff`,
        role: "taskdesk",
        sessionID: session,
        created: start - 1,
        text: event,
        meta: { kind: "event", runId: run.id, agentId: agentID, agentLabel: agent?.label, agentBackend: agent?.backend }
      }))
    }

    const prompt = (run.prompt || (index === 0 ? task.prompt : "")).trim()
    if (prompt) {
      timeline.push(syntheticMessage({
        id: `work-thread:${task.id}:run:${run.id || index}:user`,
        role: "user",
        sessionID: session,
        created: start,
        text: prompt,
        meta: { kind: "synthetic-user", runId: run.id, agentId: agentID, agentLabel: agent?.label, agentBackend: agent?.backend }
      }))
    }

    const assistant = assistantForRun({
      task,
      run,
      index,
      turn: turnByRunIndex.get(index) ?? null,
      session,
      agentID,
      agentLabel: agent?.label,
      agentBackend: agent?.backend
    })
    if (assistant) timeline.push(assistant)
  })

  return timeline
}
