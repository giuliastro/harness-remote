import type { CrossMachineRouteProject } from "./cross-machine-route-projects"

/**
 * Keep an explicit target Project choice across refreshes of the same machine catalog.
 *
 * Machine snapshots can legitimately change while this panel is open (agent activity, live refresh,
 * reconnect metadata). Re-reading the same target catalog must not erase the user's Project choice.
 * A machine switch is different: Project ids are machine-local, so even an identical string must not
 * be carried to another machine. The existing single-Project convenience remains unchanged.
 */
export function reconcileCrossMachineProjectSelection(
  currentProjectID: string,
  projects: CrossMachineRouteProject[],
  preserveCurrent: boolean
): string {
  const current = currentProjectID.trim()
  if (preserveCurrent && current && projects.some((project) => project.id === current)) return current
  return projects.length === 1 ? projects[0].id : ""
}
