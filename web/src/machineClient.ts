import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { MachineSnapshot, ServerConfig } from "./types"

const BROWSER_DISCOVERY_TIMEOUT_MS = 12_000
const DISCOVERY_STALE_GRACE_MS = 45_000
const discoveryCache = new Map<string, { snapshot: MachineSnapshot; at: number }>()

function headers(config: ServerConfig): Record<string, string> {
  const value: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) value.Authorization = authHeader(config)
  return value
}

function machineSnapshot(value: unknown): MachineSnapshot {
  let parsed = value
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      throw new Error("Invalid machine discovery response")
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid machine discovery response")
  }
  const candidate = parsed as Partial<MachineSnapshot>
  if (!candidate.machine || !Array.isArray(candidate.agents)) {
    throw new Error("Invalid machine discovery response")
  }
  return candidate as MachineSnapshot
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
export async function discoverMachine(config: ServerConfig): Promise<MachineSnapshot | null> {
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path: "/v1/machine" })
    if (!result.ok) {
      if (result.error.code === "http" && noMachineStatus(result.error.status)) return null
      if (result.error.code !== "http") {
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
      const cached = recentCachedSnapshot(config)
      if (cached) return cached
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
    const cached = recentCachedSnapshot(config)
    if (cached) return cached
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

export function selectableMachineAgents(machine: MachineSnapshot): MachineSnapshot["agents"] {
  return machine.agents.filter((agent) => agent.state === "available" || agent.state === "configured")
}
