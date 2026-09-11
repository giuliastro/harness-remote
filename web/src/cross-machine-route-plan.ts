import { canCreateNativeSession } from "./native-session-create"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import type { NativeSessionRouteMachine } from "./native-session-routing"
import {
  preflightCrossMachineProject,
  type CrossMachineProjectPreflight
} from "./cross-machine-project-preflight"
import {
  loadCrossMachineProjectRoute,
  requireTargetRouteProject,
  type CrossMachineProjectRoute,
  type CrossMachineRouteProject
} from "./cross-machine-route-projects"
import type { MachineAgentHost } from "./types"

export type CrossMachineRoutePlan = {
  sourceProject: CrossMachineRouteProject
  targetProject: CrossMachineRouteProject
  targetMachineID: string
  targetAgentID: string
  preflight: CrossMachineProjectPreflight
  disposition: "ready" | "confirm" | "blocked"
}

export type CrossMachineRoutePlanServices = {
  loadProjectRoute: typeof loadCrossMachineProjectRoute
  preflightProject: typeof preflightCrossMachineProject
}

const defaultServices: CrossMachineRoutePlanServices = {
  loadProjectRoute: loadCrossMachineProjectRoute,
  preflightProject: preflightCrossMachineProject
}

function disposition(preflight: CrossMachineProjectPreflight): CrossMachineRoutePlan["disposition"] {
  if (preflight.decision === "blocked") return "blocked"
  if (preflight.decision === "review") return "confirm"
  return "ready"
}

/**
 * Read-only planning boundary for the cross-machine route picker.
 *
 * This function may tell the UI whether a selected route is ready, needs explicit confirmation, or
 * is blocked. It creates no Session, sends no prompt, stores no lineage and grants no authority.
 * Execution must still call continueNativeSessionAcrossMachine(), which reruns the Project preflight
 * immediately before mutation so this plan can never be treated as a stale authorization token.
 */
export async function planCrossMachineContinuation({
  source,
  targetMachine,
  targetAgent,
  targetProjectId,
  services = defaultServices
}: {
  source: NativeSessionSurfaceTarget
  targetMachine: NativeSessionRouteMachine
  targetAgent: MachineAgentHost
  targetProjectId: string
  services?: CrossMachineRoutePlanServices
}): Promise<CrossMachineRoutePlan> {
  if (targetMachine.machineID === source.machineID) {
    throw new Error("Cross-machine route planning requires a different target machine.")
  }
  if (!targetMachine.agents.some((candidate) => candidate.id === targetAgent.id)) {
    throw new Error("The selected harness does not belong to the target machine.")
  }
  if (!canCreateNativeSession(targetAgent)) {
    throw new Error("The selected target harness cannot create a writable native Session right now.")
  }

  const route: CrossMachineProjectRoute = await services.loadProjectRoute({ source, targetMachine })
  const targetProject = requireTargetRouteProject(targetMachine.machineID, targetProjectId.trim(), route.targetProjects)
  const preflight = await services.preflightProject({
    sourceMachineID: source.machineID,
    targetMachineID: targetMachine.machineID,
    sourceConfig: source.config,
    sourceProjectId: route.sourceProject.id,
    targetConfig: targetMachine.config,
    targetProjectId: targetProject.id
  })

  return {
    sourceProject: route.sourceProject,
    targetProject,
    targetMachineID: targetMachine.machineID,
    targetAgentID: targetAgent.id,
    preflight,
    disposition: disposition(preflight)
  }
}
