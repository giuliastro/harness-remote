import { listMachineProjects, type MachineProject } from "./machineClient"
import type { NativeSessionSurfaceTarget } from "./native-session-discovery"
import type { NativeSessionRouteMachine } from "./native-session-routing"
import type { ServerConfig } from "./types"

export type CrossMachineRouteProject = {
  id: string
  machineID: string
  name: string
  kind: string
  configured: boolean
}

export type CrossMachineProjectRoute = {
  sourceProject: CrossMachineRouteProject
  targetProjects: CrossMachineRouteProject[]
}

function machineConfig(config: ServerConfig): ServerConfig {
  return { ...config, agentId: undefined }
}

function normalizedPath(value: string): { value: string; caseInsensitive: boolean } {
  let normalized = value.trim().replace(/\\/g, "/").replace(/\/+$/, "")
  if (!normalized) normalized = "/"
  const caseInsensitive = /^[A-Za-z]:\//.test(normalized)
  if (caseInsensitive) normalized = normalized.toLowerCase()
  return { value: normalized, caseInsensitive }
}

function pathContains(projectPath: string, sessionDirectory: string): boolean {
  if (!projectPath || !sessionDirectory) return false
  const project = normalizedPath(projectPath)
  const session = normalizedPath(sessionDirectory)
  let root = project.value
  let candidate = session.value
  if (project.caseInsensitive || session.caseInsensitive) {
    root = root.toLowerCase()
    candidate = candidate.toLowerCase()
  }
  return candidate === root || candidate.startsWith(root === "/" ? "/" : `${root}/`)
}

function routeProject(project: MachineProject): CrossMachineRouteProject {
  return {
    id: project.id,
    machineID: project.machineId,
    name: project.name,
    kind: project.kind,
    configured: project.configured === true
  }
}

/**
 * Resolve the source Project only inside the source machine's own catalog. A native Session may run
 * below a Project root, so the most-specific containing catalog entry wins. Windows drive paths are
 * compared case-insensitively; POSIX paths keep their native case semantics.
 *
 * This helper must never be used to compare source and target filesystem paths. Cross-machine
 * equivalence is established later by the privacy-preserving Git identity preflight.
 */
export function resolveSourceSessionProject(
  source: Pick<NativeSessionSurfaceTarget, "machineID" | "directory">,
  projects: MachineProject[]
): CrossMachineRouteProject | null {
  const candidates = projects
    .filter((project) => project.machineId === source.machineID && pathContains(project.path, source.directory))
    .sort((left, right) => normalizedPath(right.path).value.length - normalizedPath(left.path).value.length)
  return candidates[0] ? routeProject(candidates[0]) : null
}

/** Return only Project identities owned by the selected target daemon; never expose their paths. */
export function targetRouteProjects(machineID: string, projects: MachineProject[]): CrossMachineRouteProject[] {
  return projects
    .filter((project) => project.machineId === machineID)
    .map(routeProject)
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
}

export function requireTargetRouteProject(
  machineID: string,
  projectID: string,
  projects: CrossMachineRouteProject[]
): CrossMachineRouteProject {
  const project = projects.find((candidate) => candidate.machineID === machineID && candidate.id === projectID)
  if (!project) throw new Error("The selected Project is no longer available on the target machine.")
  return project
}

/**
 * Load exactly one Project catalog per endpoint. machineClient owns the short stale-grace cache, so
 * opening a route picker does not create a per-Session or per-harness N+1 read pattern.
 */
export async function loadCrossMachineProjectRoute({
  source,
  targetMachine
}: {
  source: NativeSessionSurfaceTarget
  targetMachine: NativeSessionRouteMachine
}): Promise<CrossMachineProjectRoute> {
  if (targetMachine.machineID === source.machineID) {
    throw new Error("Cross-machine Project routing requires a different target machine.")
  }

  const [sourceCatalog, targetCatalog] = await Promise.all([
    listMachineProjects(machineConfig(source.config)),
    listMachineProjects(machineConfig(targetMachine.config))
  ])
  const sourceProject = resolveSourceSessionProject(source, sourceCatalog)
  if (!sourceProject) {
    throw new Error("This Session is not associated with a canonical Project on its source machine, so cross-machine continuation cannot be verified safely.")
  }
  const targetProjects = targetRouteProjects(targetMachine.machineID, targetCatalog)
  if (!targetProjects.length) {
    throw new Error("The target machine does not expose any canonical Projects for cross-machine continuation.")
  }
  return { sourceProject, targetProjects }
}
