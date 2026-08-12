import type { BackendKind, PermissionRequest, QuestionRequest, SessionView } from "./types"

export type AgentRunStatus =
  | "idle"
  | "working"
  | "waiting"
  | "retrying"
  | "completed"
  | "failed"
  | "stopped"

export type AgentAttention =
  | { reason: "permission"; requestId: string }
  | { reason: "question"; requestId: string }
  | { reason: "failure" }
  | { reason: "completion" }

export type AgentRun = {
  id: string
  backend: BackendKind
  sessionId: string
  title: string
  directory: string
  status: AgentRunStatus
  attention?: AgentAttention
  projectId?: string
  machineId?: string
  startedAt?: number
  updatedAt?: number
}

export type AgentRunSignals = {
  questions?: readonly Pick<QuestionRequest, "id" | "sessionID">[]
  permissions?: readonly Pick<PermissionRequest, "id" | "sessionID">[]
  terminalStatus?: Extract<AgentRunStatus, "completed" | "failed" | "stopped">
  projectId?: string
  machineId?: string
  startedAt?: number
}

const WORKING_STATUSES = new Set(["busy", "working", "running"])
const RETRYING_STATUSES = new Set(["retry", "retrying"])
const WAITING_STATUSES = new Set(["waiting"])

/**
 * Normalize the status vocabulary exposed by currently supported harnesses into the operational
 * states used by the control-plane layer. Terminal states are deliberately supplied only through
 * the explicit terminalStatus signal: inferring them from raw harness words such as "error" or
 * "done" could turn transient or backend-specific states into false terminal runs in the Inbox.
 */
export function normalizeAgentRunStatus(status: string, terminalStatus?: AgentRunSignals["terminalStatus"]): AgentRunStatus {
  if (terminalStatus) return terminalStatus

  const normalized = status.trim().toLowerCase()
  if (WORKING_STATUSES.has(normalized)) return "working"
  if (RETRYING_STATUSES.has(normalized)) return "retrying"
  if (WAITING_STATUSES.has(normalized)) return "waiting"
  return "idle"
}

function attentionFor(
  sessionId: string,
  status: AgentRunStatus,
  signals: AgentRunSignals
): AgentAttention | undefined {
  const permission = signals.permissions?.find((request) => request.sessionID === sessionId)
  if (permission) return { reason: "permission", requestId: permission.id }

  const question = signals.questions?.find((request) => request.sessionID === sessionId)
  if (question) return { reason: "question", requestId: question.id }

  if (status === "failed") return { reason: "failure" }
  if (status === "completed") return { reason: "completion" }
  return undefined
}

/**
 * Convert an existing session into the backend-agnostic representation consumed by cross-agent
 * operational views. This deliberately retains backend/session identity: AgentRun is a projection,
 * not a replacement for the underlying session and its harness-specific capabilities.
 */
export function toAgentRun(
  session: SessionView,
  backend: BackendKind,
  signals: AgentRunSignals = {}
): AgentRun {
  const status = normalizeAgentRunStatus(session.status, signals.terminalStatus)
  const run: AgentRun = {
    id: `${backend}:${session.id}`,
    backend,
    sessionId: session.id,
    title: session.title,
    directory: session.directory,
    status,
    updatedAt: session.updated
  }

  const attention = attentionFor(session.id, status, signals)
  if (attention) run.attention = attention
  if (signals.projectId) run.projectId = signals.projectId
  if (signals.machineId) run.machineId = signals.machineId
  if (signals.startedAt !== undefined) run.startedAt = signals.startedAt

  return run
}
