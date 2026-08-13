import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { MachineSnapshot, ServerConfig } from "./types"

function headers(config: ServerConfig): Record<string, string> {
  const value: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) value.Authorization = authHeader(config)
  return value
}

export function noMachineStatus(status: number | undefined): boolean {
  return status === 404 || status === 503
}

/**
 * Best-effort daemon discovery. A legacy bridge/OpenCode server, or a bridge without a machine
 * registry configured, returns null so every pre-daemon saved profile keeps working as before.
 */
export async function discoverMachine(config: ServerConfig): Promise<MachineSnapshot | null> {
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path: "/v1/machine" })
    if (!result.ok) {
      if (result.error.code === "http" && noMachineStatus(result.error.status)) return null
      throw new Error(result.error.message)
    }
    return result.response.data as MachineSnapshot
  }

  const target = `${machineBaseUrl(config)}/v1/machine`
  if (Capacitor.isNativePlatform()) {
    let response
    try {
      response = await CapacitorHttp.get({ url: target, headers: headers(config), connectTimeout: 12_000, readTimeout: 12_000 })
    } catch {
      throw new Error(`Cannot reach ${config.host}:${config.port}.`)
    }
    if (noMachineStatus(response.status)) return null
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
    return response.data as MachineSnapshot
  }

  let response: Response
  try {
    response = await fetch(target, { headers: headers(config) })
  } catch {
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  }
  if (noMachineStatus(response.status)) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return await response.json() as MachineSnapshot
}

export function selectableMachineAgents(machine: MachineSnapshot): MachineSnapshot["agents"] {
  return machine.agents.filter((agent) => agent.state === "available" || agent.state === "configured")
}
