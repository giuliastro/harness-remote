import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { MachineSnapshot, ServerConfig } from "./types"

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
    return machineSnapshot(result.response.data)
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
    return machineSnapshot(response.data)
  }

  let response: Response
  try {
    response = await fetch(target, { headers: headers(config) })
  } catch {
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  }
  if (noMachineStatus(response.status)) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return machineSnapshot(await response.json())
}

export function selectableMachineAgents(machine: MachineSnapshot): MachineSnapshot["agents"] {
  return machine.agents.filter((agent) => agent.state === "available" || agent.state === "configured")
}
