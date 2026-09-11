import {
  assessProjectContinuity,
  loadProjectIdentity,
  type ProjectContinuityAssessment
} from "./project-continuity"
import type { ServerConfig } from "./types"

export type CrossMachineProjectDecision = "automatic" | "review" | "blocked"
export type CrossMachineProjectReason = "exact_workspace" | "workspace_diverged" | "project_unverified" | "project_mismatch"

export type CrossMachineProjectPreflight = {
  sourceMachineID: string
  targetMachineID: string
  sourceProjectId: string
  targetProjectId: string
  sourceIdentityVerified: boolean
  targetIdentityVerified: boolean
  decision: CrossMachineProjectDecision
  reason: CrossMachineProjectReason
  assessment: ProjectContinuityAssessment
}

function machineConfig(config: ServerConfig): ServerConfig {
  return { ...config, agentId: undefined }
}

export function classifyCrossMachineProjectContinuity(
  assessment: ProjectContinuityAssessment
): Pick<CrossMachineProjectPreflight, "decision" | "reason"> {
  if (assessment.project === "different") {
    return { decision: "blocked", reason: "project_mismatch" }
  }
  if (assessment.exactWorkspace) {
    return { decision: "automatic", reason: "exact_workspace" }
  }
  if (assessment.project === "unverified") {
    return { decision: "review", reason: "project_unverified" }
  }
  return { decision: "review", reason: "workspace_diverged" }
}

/**
 * Read-only cross-machine preflight. It deliberately runs before target Session creation and sends
 * only machine-local Project ids to the corresponding daemons. Filesystem paths are never compared
 * across machines and a name/branch coincidence can never promote an unverified Project to a match.
 */
export async function preflightCrossMachineProject({
  sourceMachineID,
  targetMachineID,
  sourceConfig,
  sourceProjectId,
  targetConfig,
  targetProjectId
}: {
  sourceMachineID: string
  targetMachineID: string
  sourceConfig: ServerConfig
  sourceProjectId: string
  targetConfig: ServerConfig
  targetProjectId: string
}): Promise<CrossMachineProjectPreflight> {
  const sourceMachine = sourceMachineID.trim()
  const targetMachine = targetMachineID.trim()
  const sourceProject = sourceProjectId.trim()
  const targetProject = targetProjectId.trim()

  if (!sourceMachine || !targetMachine) throw new Error("Both source and target machine identities are required.")
  if (sourceMachine === targetMachine) throw new Error("Cross-machine Project preflight requires two different machines.")
  if (!sourceProject || !targetProject) throw new Error("Both source and target Project identities are required.")

  const [sourceIdentity, targetIdentity] = await Promise.all([
    loadProjectIdentity(machineConfig(sourceConfig), sourceProject),
    loadProjectIdentity(machineConfig(targetConfig), targetProject)
  ])
  const assessment = assessProjectContinuity(sourceIdentity, targetIdentity)
  const classification = classifyCrossMachineProjectContinuity(assessment)

  return {
    sourceMachineID: sourceMachine,
    targetMachineID: targetMachine,
    sourceProjectId: sourceProject,
    targetProjectId: targetProject,
    sourceIdentityVerified: sourceIdentity !== null,
    targetIdentityVerified: targetIdentity !== null,
    ...classification,
    assessment
  }
}

/**
 * Mutation gate used by later orchestration. Exact clean workspace continuity may proceed directly;
 * any incomplete or diverged-but-same Project evidence requires an explicit caller confirmation.
 * A contradictory Project identity is never overridable here.
 */
export function requireCrossMachineProjectApproval(
  preflight: CrossMachineProjectPreflight,
  { confirmed = false }: { confirmed?: boolean } = {}
): void {
  if (preflight.decision === "blocked") {
    throw new Error("The target Project does not match the source Project. Cross-machine continuation is blocked.")
  }
  if (preflight.decision === "review" && !confirmed) {
    throw new Error("Cross-machine Project continuity needs confirmation before creating a target Session.")
  }
}
