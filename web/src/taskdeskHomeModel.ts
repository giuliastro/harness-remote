import type { MachineAgentHost } from "./types"
import type { MachineTask } from "./taskClient"

export type TaskDeskTaskStatus = "preparing" | "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown"

export function taskTitle(task: Pick<MachineTask, "prompt">): string {
  const firstLine = task.prompt.split(/\r?\n/, 1)[0]?.trim() ?? ""
  if (!firstLine) return "Untitled task"
  return firstLine.length > 88 ? `${firstLine.slice(0, 85).trimEnd()}...` : firstLine
}

export function normalizeTaskStatus(status: string): TaskDeskTaskStatus {
  const value = status.trim().toLowerCase()
  if (["preparing", "created", "ready"].includes(value)) return "preparing"
  if (["queued", "pending"].includes(value)) return "queued"
  if (["running", "busy", "working", "in_progress", "in-progress"].includes(value)) return "running"
  if (["waiting", "blocked", "attention", "needs_attention", "needs-attention"].includes(value)) return "waiting"
  if (["completed", "complete", "done", "finished", "success", "succeeded"].includes(value)) return "completed"
  if (["failed", "error"].includes(value)) return "failed"
  if (["cancelled", "canceled", "aborted"].includes(value)) return "cancelled"
  return "unknown"
}

export function taskStatusLabel(status: string): string {
  const normalized = normalizeTaskStatus(status)
  if (normalized === "unknown") return status.trim() || "Unknown"
  return normalized[0].toUpperCase() + normalized.slice(1)
}

export function agentLabel(agents: MachineAgentHost[], agentId: string): string {
  return agents.find((agent) => agent.id === agentId)?.label?.trim() || agentId || "Unknown agent"
}

export function modelLabel(task: Pick<MachineTask, "model">): string {
  const model = task.model
  if (!model) return "Default model"
  return model.variant ? `${model.modelID} · ${model.variant}` : model.modelID
}

export function taskTimestamp(task: Pick<MachineTask, "updatedAt" | "createdAt">): number {
  const updated = Date.parse(task.updatedAt)
  if (Number.isFinite(updated)) return updated
  const created = Date.parse(task.createdAt)
  return Number.isFinite(created) ? created : 0
}

export function sortTasksByActivity(tasks: MachineTask[]): MachineTask[] {
  return [...tasks].sort((left, right) => taskTimestamp(right) - taskTimestamp(left))
}
