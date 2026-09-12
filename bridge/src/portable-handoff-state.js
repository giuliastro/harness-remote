const EVIDENCE = new Set(["match", "different", "unverified"])
const DECISIONS = new Set(["automatic", "review"])
const REASONS = new Set(["exact_workspace", "workspace_diverged", "project_unverified"])
const MAX_PROJECT_ID = 500
const MAX_TITLE = 200
const MAX_SERIALIZED = 4_096

function invalidState(message) {
  const error = new Error(message)
  error.code = "invalid_request"
  return error
}

function normalizedString(value, label, maxLength) {
  const normalized = typeof value === "string" ? value.trim() : ""
  if (!normalized || normalized.length > maxLength) throw invalidState(`${label} is invalid`)
  return normalized
}

function normalizedEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidState("Portable handoff Project evidence is required")
  }
  const names = ["project", "repository", "history", "branch", "head"]
  const normalized = {}
  for (const name of names) {
    if (!EVIDENCE.has(value[name])) throw invalidState(`Portable handoff ${name} evidence is invalid`)
    normalized[name] = value[name]
  }
  if (typeof value.exactWorkspace !== "boolean") throw invalidState("Portable handoff exactWorkspace evidence is invalid")
  if (value.sourceDirty !== undefined && typeof value.sourceDirty !== "boolean") throw invalidState("Portable handoff sourceDirty evidence is invalid")
  if (value.targetDirty !== undefined && typeof value.targetDirty !== "boolean") throw invalidState("Portable handoff targetDirty evidence is invalid")
  return {
    ...normalized,
    ...(typeof value.sourceDirty === "boolean" ? { sourceDirty: value.sourceDirty } : {}),
    ...(typeof value.targetDirty === "boolean" ? { targetDirty: value.targetDirty } : {}),
    exactWorkspace: value.exactWorkspace
  }
}

/**
 * Validate and canonicalize the only structured metadata allowed to cross a machine handoff.
 * Unknown fields are discarded, so permission/approval/tool/path material cannot become durable
 * merely because a client smuggled it alongside an otherwise valid record.
 */
export function normalizePortableHandoffState(value) {
  if (value === undefined || value === null) return undefined
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1) {
    throw invalidState("Portable handoff state version is invalid")
  }
  const task = value.task
  const project = value.project
  const controls = value.controls
  if (!task || typeof task !== "object" || Array.isArray(task) || task.state !== "continuing") {
    throw invalidState("Portable handoff task state is invalid")
  }
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    throw invalidState("Portable handoff Project state is required")
  }
  if (!DECISIONS.has(project.decision) || !REASONS.has(project.reason)) {
    throw invalidState("Portable handoff Project decision is invalid")
  }
  if (project.decision === "automatic" && project.reason !== "exact_workspace") {
    throw invalidState("Automatic portable handoff state requires exact workspace evidence")
  }
  if (project.decision === "review" && project.reason === "exact_workspace") {
    throw invalidState("Reviewed portable handoff state cannot claim exact workspace continuity")
  }
  const evidence = normalizedEvidence(project.evidence)
  if (evidence.project === "different" || evidence.repository === "different" || evidence.history === "different") {
    throw invalidState("Portable handoff state cannot represent a blocked Project mismatch")
  }
  if (project.decision === "automatic" && !evidence.exactWorkspace) {
    throw invalidState("Automatic portable handoff state requires exactWorkspace=true")
  }
  if (project.decision === "review" && evidence.exactWorkspace) {
    throw invalidState("Reviewed portable handoff state requires exactWorkspace=false")
  }
  if (!controls || typeof controls !== "object" || Array.isArray(controls)
      || controls.sourceAuthority !== "invalidated"
      || controls.targetAuthorization !== "re_evaluate"
      || controls.attachments !== "not_transferred") {
    throw invalidState("Portable handoff control boundary is invalid")
  }

  const normalized = {
    version: 1,
    task: {
      title: normalizedString(task.title, "Portable handoff task title", MAX_TITLE),
      state: "continuing"
    },
    project: {
      sourceProjectId: normalizedString(project.sourceProjectId, "Portable handoff source Project id", MAX_PROJECT_ID),
      targetProjectId: normalizedString(project.targetProjectId, "Portable handoff target Project id", MAX_PROJECT_ID),
      decision: project.decision,
      reason: project.reason,
      evidence
    },
    controls: {
      sourceAuthority: "invalidated",
      targetAuthorization: "re_evaluate",
      attachments: "not_transferred"
    }
  }
  if (JSON.stringify(normalized).length > MAX_SERIALIZED) throw invalidState("Portable handoff state is too large")
  return normalized
}
