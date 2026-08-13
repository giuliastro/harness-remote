import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequest, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { MachineSnapshot, ServerConfig } from "./types"

function headers(config: ServerConfig): Record<string, string> {
  const value: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) value.Authorization = authHeader(config)
  return value
}

/**
 * Best-effort daemon discovery. A legacy bridge/OpenCode server simply returns null, which keeps
 * every pre-daemon saved profile working exactly as before.
 */
export async function discoverMachine(config: ServerConfig): Promise<MachineSnapshot | null> {
  if (isDesktopPlatform()) {
    try {
      const response = await desktopRequest(config, { path: "/v1/machine" })
      return response.data as MachineSnapshot
    } catch (error) {
      if (error instanceof Error && /404|not found/i.test(error.message)) return null
      throw error
    }
  }

  const target = `${machineBaseUrl(config)}/v1/machine`
  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.get({ url: target, headers: headers(config), connectTimeout: 12_000, readTimeout: 12_000 })
    } catch {
      throw new Error(`Cannot reach ${config.host}:${config.port}.`)
    }
    if (response.status === 404) return null
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
    return response.data as MachineSnapshot
  }

  let response: Response
  try {
    response = await fetch(target, { headers: headers(config) })
  } catch {
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  }
  if (response.status === 404) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as MachineSnapshot
}

export function selectableMachineAgents(machine: MachineSnapshot): MachineSnapshot["agents"] {
  return machine.agents.filter((agent) => agent.state === "available" || agent.state === "configured")
}
