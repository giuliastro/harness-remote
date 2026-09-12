import type { CrossMachineProjectPreflight } from "./cross-machine-project-preflight"
import type { ProjectContinuityAssessment, ProjectContinuityEvidence } from "./project-continuity"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"

export type NativeSessionPortableHandoffState = {
  version: 1
  task: {
    title: string
    state: "continuing"
  }
  project: {
    sourceProjectId: string
    targetProjectId: string
    decision: "automatic" | "review"
    reason: "exact_workspace" | "workspace_diverged" | "project_unverified"
    evidence: {
      project: ProjectContinuityEvidence
      repository: ProjectContinuityEvidence
      history: ProjectContinuityEvidence
      branch: ProjectContinuityEvidence
      head: ProjectContinuityEvidence
      sourceDirty?: boolean
      targetDirty?: boolean
      exactWorkspace: boolean
    }
  }
  controls: {
    sourceAuthority: "invalidated"
    targetAuthorization: "re_evaluate"
    attachments: "not_transferred"
  }
}

const EVIDENCE = new Set<ProjectContinuityEvidence>(["match", "different", "unverified"])
const REASONS = new Set<NativeSessionPortableHandoffState["project"]["reason"]>([
  "exact_workspace",
  "workspace_diverged",
  "project_unverified"
])

function portableEvidence(assessment: ProjectContinuityAssessment): NativeSessionPortableHandoffState["project"]["evidence"] {
  return {
    project: assessment.project,
    repository: assessment.repository,
    history: assessment.history,
    branch: assessment.branch,
    head: assessment.head,
    ...(typeof assessment.sourceDirty === "boolean" ? { sourceDirty: assessment.sourceDirty } : {}),
    ...(typeof assessment.targetDirty === "boolean" ? { targetDirty: assessment.targetDirty } : {}),
    exactWorkspace: assessment.exactWorkspace
  }
}

export function parsePortableHandoffState(value: unknown): NativeSessionPortableHandoffState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const candidate = value as Partial<NativeSessionPortableHandoffState>
  if (candidate.version !== 1) return null
  const task = candidate.task as Partial<NativeSessionPortableHandoffState["task"]> | undefined
  const project = candidate.project as Partial<NativeSessionPortableHandoffState["project"]> | undefined
  const controls = candidate.controls as Partial<NativeSessionPortableHandoffState["controls"]> | undefined
  const evidence = project?.evidence as Partial<NativeSessionPortableHandoffState["project"]["evidence"]> | undefined
  if (!task || typeof task.title !== "string" || !task.title.trim() || task.title.length > 200 || task.state !== "continuing") return null
  if (!project || typeof project.sourceProjectId !== "string" || !project.sourceProjectId.trim() || typeof project.targetProjectId !== "string" || !project.targetProjectId.trim()) return null
  if (project.decision !== "automatic" && project.decision !== "review") return null
  if (!project.reason || !REASONS.has(project.reason)) return null
  if (!evidence || ![evidence.project, evidence.repository, evidence.history, evidence.branch, evidence.head].every((entry) => EVIDENCE.has(entry as ProjectContinuityEvidence))) return null
  if (typeof evidence.exactWorkspace !== "boolean") return null
  if (evidence.sourceDirty !== undefined && typeof evidence.sourceDirty !== "boolean") return null
  if (evidence.targetDirty !== undefined && typeof evidence.targetDirty !== "boolean") return null
  if (!controls || controls.sourceAuthority !== "invalidated" || controls.targetAuthorization !== "re_evaluate" || controls.attachments !== "not_transferred") return null
  return {
    version: 1,
    task: { title: task.title.trim(), state: "continuing" },
    project: {
      sourceProjectId: project.sourceProjectId.trim(),
      targetProjectId: project.targetProjectId.trim(),
      decision: project.decision,
      reason: project.reason,
      evidence: {
        project: evidence.project as ProjectContinuityEvidence,
        repository: evidence.repository as ProjectContinuityEvidence,
        history: evidence.history as ProjectContinuityEvidence,
        branch: evidence.branch as ProjectContinuityEvidence,
        head: evidence.head as ProjectContinuityEvidence,
        ...(typeof evidence.sourceDirty === "boolean" ? { sourceDirty: evidence.sourceDirty } : {}),
        ...(typeof evidence.targetDirty === "boolean" ? { targetDirty: evidence.targetDirty } : {}),
        exactWorkspace: evidence.exactWorkspace
      }
    },
    controls: {
      sourceAuthority: "invalidated",
      targetAuthorization: "re_evaluate",
      attachments: "not_transferred"
    }
  }
}

/**
 * Runtime-neutral state that may cross the machine boundary without becoming a universal transcript.
 *
 * This deliberately carries no filesystem paths, branch/HEAD values, prompt text, permissions,
 * approvals, tool state, credentials or provider-specific payloads. Project evidence is reduced to
 * match/different/unverified classifications already produced by the conservative preflight.
 */
export function buildPortableHandoffState(
  source: NativeSessionSurfaceTarget,
  preflight: CrossMachineProjectPreflight
): NativeSessionPortableHandoffState {
  if (preflight.decision === "blocked" || preflight.reason === "project_mismatch") {
    throw new Error("Blocked Project continuity cannot produce portable handoff state.")
  }
  return {
    version: 1,
    task: {
      title: source.title.trim().slice(0, 200) || "Session",
      state: "continuing"
    },
    project: {
      sourceProjectId: preflight.sourceProjectId,
      targetProjectId: preflight.targetProjectId,
      decision: preflight.decision,
      reason: preflight.reason,
      evidence: portableEvidence(preflight.assessment)
    },
    controls: {
      sourceAuthority: "invalidated",
      targetAuthorization: "re_evaluate",
      attachments: "not_transferred"
    }
  }
}
