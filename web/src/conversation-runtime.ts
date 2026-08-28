import type { MachineTask, MachineTaskRun, TaskCheckpoint } from "./taskClient"
import type { ModelSelection } from "./types"

export type ConversationTurn = {
  id?: string
  sequence?: number
  agentId?: string
  model?: ModelSelection | null
  role?: string
  clientRequestId?: string
  sessionId?: string | null
  sessionID?: string | null
  status?: string
  transport?: string | null
  directory?: string
  prompt?: string
  outcome?: string
  startedAt?: string
  finishedAt?: string
  error?: { message?: string } | string | null
}

export type ConversationRuntime = {
  id: string
  machineId: string
  title?: string
  agentId: string
  initialPrompt: string
  model?: ModelSelection | null
  status: string
  directory: string
  currentTurn: ConversationTurn | null
  turns: ConversationTurn[]
  checkpoints?: TaskCheckpoint[]
  workspaceMode?: string
  error?: { message?: string } | null
  finishedAt?: string | null
  createdAt: string
  updatedAt: string
}

/**
 * Legacy Task-backed surfaces can enter the neutral conversation domain here. Native Sessions never
 * travel in the opposite direction: they stay native from discovery through rendering and mutation.
 */
export function conversationRuntimeFromTask(task: MachineTask): ConversationRuntime {
  const turns = Array.isArray(task.runs) && task.runs.length
    ? task.runs.map((run) => ({ ...run }))
    : task.run ? [{ ...task.run }] : []
  return {
    id: task.id,
    machineId: task.machineId,
    title: task.title,
    agentId: task.agentId,
    initialPrompt: task.prompt,
    model: task.model,
    status: task.status,
    directory: task.workspace.path,
    currentTurn: task.run ? { ...task.run } : null,
    turns,
    checkpoints: task.checkpoints,
    workspaceMode: task.workspace.mode,
    error: task.error,
    finishedAt: task.finishedAt,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt
  }
}

export function conversationTurns(conversation: ConversationRuntime): ConversationTurn[] {
  const turns = conversation.turns.length
    ? conversation.turns
    : conversation.currentTurn ? [conversation.currentTurn] : []
  return [...turns].sort((left, right) => {
    const sequence = (Number(left.sequence) || 0) - (Number(right.sequence) || 0)
    if (sequence) return sequence
    return Date.parse(left.startedAt || "") - Date.parse(right.startedAt || "")
  })
}

export function conversationTurnSessionID(turn?: ConversationTurn | MachineTaskRun | null): string | null {
  return turn?.sessionId || turn?.sessionID || null
}
