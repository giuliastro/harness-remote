import type { ModelSelection, Session, SessionStatus } from "./types"

export type FederatedSessionBucket = "active" | "attention" | "failed" | "completed" | "recent"

export type FederatedSessionPresentationState = "working" | "attention" | "stopped" | "ready"

export type FederatedSessionIdentity = {
  machineID: string
  machineName: string
  agentID: string
  agentLabel: string
  session: Session
  projectName?: string
  projectPath?: string
}

export type FederatedSessionProjection = FederatedSessionIdentity & {
  bucket: FederatedSessionBucket
  projectKey: string
  projectLabel: string
  modelKey: string
  modelLabel: string
  searchText: string
}

const ACTIVE_STATUS = new Set([
  "working",
  "busy",
  "running",
  "in_progress",
  "in-progress",
  "retry",
  "retrying",
  "waiting"
])

const ATTENTION_STATUS = new Set([
  "attention",
  "needs-attention",
  "needs_attention",
  "blocked",
  "input-required",
  "input_required"
])

const FAILED_STATUS = new Set([
  "error",
  "failed",
  "failure",
  "rejected",
  "permission-denied",
  "permission_denied",
  "forbidden",
  "fail_closed",
  "fail-closed",
  "interrupted",
  "aborted",
  "cancelled",
  "canceled",
  "disconnected",
  "offline",
  "stopped"
])

const COMPLETED_STATUS = new Set([
  "completed",
  "complete",
  "done",
  "finished",
  "succeeded",
  "success"
])

function normalizedStatus(status?: SessionStatus): string {
  return status?.type?.trim().toLowerCase() || ""
}

/**
 * Map one already-discovered native Session into an operational bucket. A live presentation state
 * wins over stale discovery metadata because it reflects what the currently observed native
 * Session is doing now. Unknown states deliberately remain Recent rather than being guessed into a
 * stronger operational meaning.
 */
export function federatedSessionBucket(
  status?: SessionStatus,
  liveState?: FederatedSessionPresentationState
): FederatedSessionBucket {
  if (liveState === "working") return "active"
  if (liveState === "attention") return "attention"
  if (liveState === "stopped") return "failed"

  const type = normalizedStatus(status)
  if (FAILED_STATUS.has(type)) return "failed"
  if (ATTENTION_STATUS.has(type)) return "attention"
  if (COMPLETED_STATUS.has(type)) return "completed"
  if (ACTIVE_STATUS.has(type)) return "active"
  return "recent"
}

export function federatedProjectIdentity({
  machineID,
  session,
  projectName,
  projectPath
}: Pick<FederatedSessionIdentity, "machineID" | "session" | "projectName" | "projectPath">): {
  key: string
  label: string
} {
  const path = projectPath || session.project?.worktree || session.directory || ""
  const name = projectName || session.project?.name || path.split(/[\\/]/).filter(Boolean).at(-1) || "Project"
  return {
    key: `${machineID}:${path}`,
    label: name
  }
}

export function federatedModelIdentity(model?: Session["model"] | ModelSelection | null): {
  key: string
  label: string
} {
  if (!model) return { key: "", label: "Unknown model" }
  const providerID = "providerID" in model ? model.providerID : ""
  const modelID = "modelID" in model ? model.modelID : model.id
  const variant = model.variant?.trim()
  const key = [providerID, modelID, variant].filter(Boolean).join(":")
  const label = [providerID, modelID, variant].filter(Boolean).join(" · ")
  return { key, label: label || "Unknown model" }
}

function searchValue(value: string | undefined): string {
  return value?.trim().toLowerCase() || ""
}

/**
 * Build a client-side federation projection from data that Session discovery already returned.
 * This helper must stay side-effect free: no transcript fetches, no per-Session probes and no writer
 * calls belong in the federated index.
 */
export function projectFederatedSession(
  identity: FederatedSessionIdentity,
  liveState?: FederatedSessionPresentationState
): FederatedSessionProjection {
  const project = federatedProjectIdentity(identity)
  const model = federatedModelIdentity(identity.session.model)
  const searchText = [
    identity.session.title,
    identity.machineName,
    identity.agentLabel,
    identity.agentID,
    project.label,
    identity.projectPath,
    identity.session.project?.worktree,
    identity.session.model?.providerID,
    identity.session.model?.id,
    identity.session.model?.variant
  ].map(searchValue).filter(Boolean).join("\n")

  return {
    ...identity,
    bucket: federatedSessionBucket(identity.session.status, liveState),
    projectKey: project.key,
    projectLabel: project.label,
    modelKey: model.key,
    modelLabel: model.label,
    searchText
  }
}

export function matchesFederatedSessionQuery(
  projection: FederatedSessionProjection,
  query: string
): boolean {
  const normalized = query.trim().toLowerCase()
  return !normalized || projection.searchText.includes(normalized)
}
