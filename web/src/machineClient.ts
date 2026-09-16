import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { MachineProject } from "./taskClient"
import type { MachineSnapshot, ServerConfig } from "./types"

export type { MachineProject }

const BROWSER_DISCOVERY_TIMEOUT_MS = 12_000
const DISCOVERY_STALE_GRACE_MS = 45_000
const discoveryCache = new Map<string, { snapshot: MachineSnapshot; at: number }>()
const projectCache = new Map<string, { projects: MachineProject[]; at: number }>()

function headers(config: ServerConfig): Record<string, string> {
  const value: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) value.Authorization = authHeader(config)
  return value
}

function parseJSONValue(value: unknown, label: string): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) }
  catch { throw new Error(`Invalid ${label} response`) }
}

function machineSnapshot(value: unknown): MachineSnapshot {
  const parsed = parseJSONValue(value, "machine discovery")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid machine discovery response")
  }
  const candidate = parsed as Partial<MachineSnapshot>
  if (!candidate.machine || !Array.isArray(candidate.agents)) {
    throw new Error("Invalid machine discovery response")
  }
  return candidate as MachineSnapshot
}

function machineProjects(value: unknown): MachineProject[] {
  const parsed = parseJSONValue(value, "Project catalog")
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid Project catalog response")
  const projects = (parsed as { projects?: unknown }).projects
  if (!Array.isArray(projects)) throw new Error("Invalid Project catalog response")
  return projects.filter((project): project is MachineProject => Boolean(
    project
      && typeof project === "object"
      && typeof (project as MachineProject).id === "string"
      && typeof (project as MachineProject).machineId === "string"
      && typeof (project as MachineProject).name === "string"
      && typeof (project as MachineProject).path === "string"
  ))
}

function cacheKey(config: ServerConfig): string {
  return `${machineBaseUrl(config)}|${config.username || ""}`
}

function remember(config: ServerConfig, snapshot: MachineSnapshot): MachineSnapshot {
  discoveryCache.set(cacheKey(config), { snapshot, at: Date.now() })
  return snapshot
}

function recentCachedSnapshot(config: ServerConfig): MachineSnapshot | null {
  const cached = discoveryCache.get(cacheKey(config))
  if (!cached || Date.now() - cached.at > DISCOVERY_STALE_GRACE_MS) return null
  return cached.snapshot
}

function rememberProjects(config: ServerConfig, projects: MachineProject[]): MachineProject[] {
  projectCache.set(cacheKey(config), { projects, at: Date.now() })
  return projects
}

function recentCachedProjects(config: ServerConfig): MachineProject[] | null {
  const cached = projectCache.get(cacheKey(config))
  if (!cached || Date.now() - cached.at > DISCOVERY_STALE_GRACE_MS) return null
  return cached.projects
}

export function noMachineStatus(status: number | undefined): boolean {
  return status === 404 || status === 503
}

/**
 * Best-effort daemon discovery. A legacy bridge/OpenCode server, or a bridge without a machine
 * registry configured, returns null so every pre-daemon saved profile keeps working as before.
 *
 * Mobile radios and WebViews can briefly drop an otherwise healthy request while switching network
 * state. A short in-memory grace period keeps the already-rendered workspace stable during that
 * transient transport failure instead of making the whole app look unconfigured for one poll.
 */
export async function discoverMachine(
  config: ServerConfig,
  options: { allowCachedOnTransportFailure?: boolean } = {}
): Promise<MachineSnapshot | null> {
  const allowCachedOnTransportFailure = options.allowCachedOnTransportFailure !== false
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path: "/v1/machine" })
    if (!result.ok) {
      if (result.error.code === "http" && noMachineStatus(result.error.status)) return null
      if (result.error.code !== "http" && allowCachedOnTransportFailure) {
        const cached = recentCachedSnapshot(config)
        if (cached) return cached
      }
      throw new Error(result.error.message)
    }
    return remember(config, machineSnapshot(result.response.data))
  }

  const target = `${machineBaseUrl(config)}/v1/machine`
  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.get({ url: target, headers: headers(config), connectTimeout: 12_000, readTimeout: 12_000 })
    } catch {
      if (allowCachedOnTransportFailure) {
        const cached = recentCachedSnapshot(config)
        if (cached) return cached
      }
      throw new Error(`Cannot reach ${config.host}:${config.port}.`)
    }
    if (noMachineStatus(response.status)) return null
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
    return remember(config, machineSnapshot(response.data))
  }

  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), BROWSER_DISCOVERY_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target, { headers: headers(config), signal: controller.signal })
  } catch (error) {
    if (allowCachedOnTransportFailure) {
      const cached = recentCachedSnapshot(config)
      if (cached) return cached
    }
    if (controller.signal.aborted) {
      throw new Error(`Machine discovery at ${config.host}:${config.port} timed out after ${BROWSER_DISCOVERY_TIMEOUT_MS / 1000}s.`)
    }
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  } finally {
    globalThis.clearTimeout(timer)
  }
  if (noMachineStatus(response.status)) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return remember(config, machineSnapshot(await response.json()))
}

/** Read the daemon's canonical, machine-scoped Project catalog without depending on Task storage. */
export async function listMachineProjects(config: ServerConfig): Promise<MachineProject[]> {
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path: "/v1/projects" })
    if (!result.ok) {
      if (result.error.code !== "http") {
        const cached = recentCachedProjects(config)
        if (cached) return cached
      }
      throw new Error(result.error.message)
    }
    return rememberProjects(config, machineProjects(result.response.data))
  }

  const target = `${machineBaseUrl(config)}/v1/projects`
  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.get({ url: target, headers: headers(config), connectTimeout: 12_000, readTimeout: 12_000 })
    } catch {
      const cached = recentCachedProjects(config)
      if (cached) return cached
      throw new Error(`Cannot reach ${config.host}:${config.port}.`)
    }
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
    return rememberProjects(config, machineProjects(response.data))
  }

  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), BROWSER_DISCOVERY_TIMEOUT_MS)
  let response: Response
  try {
    response = await fetch(target, { headers: headers(config), signal: controller.signal })
  } catch (error) {
    const cached = recentCachedProjects(config)
    if (cached) return cached
    if (controller.signal.aborted) {
      throw new Error(`Project catalog at ${config.host}:${config.port} timed out after ${BROWSER_DISCOVERY_TIMEOUT_MS / 1000}s.`)
    }
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  } finally {
    globalThis.clearTimeout(timer)
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return rememberProjects(config, machineProjects(await response.json()))
}

export function selectableMachineAgents(machine: MachineSnapshot): MachineSnapshot["agents"] {
  return machine.agents.filter((agent) => agent.state === "available" || agent.state === "configured")
}

/**
 * The one place that turns a daemon host state into words a user reads.
 *
 * `configured` is not a warning: the daemon registers a harness it knows how to launch and only
 * flips it to `available` once the process is up, so a lazily started agent sits in `configured`
 * while being perfectly usable. Calling it "Ready" is what keeps the machine list from implying a
 * problem that does not exist, and having one definition keeps the machine list, the workspace rail
 * and the harness pills from disagreeing about the same agent.
 */
export function machineAgentStateLabel(state: string): string {
  if (state === "available") return "Running"
  if (state === "configured") return "Ready"
  if (state === "unavailable") return "Unavailable"
  return state
}
