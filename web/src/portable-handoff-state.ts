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
