import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { machineCandidates, parseMachineSnapshot } from "./machinePayload"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { MachineSnapshot, ServerConfig } from "./types"

export { selectableMachineAgents } from "./machinePayload"

export type MachineConnection = {
  machine: MachineSnapshot
  config: ServerConfig
}

function headers(config: ServerConfig): Record<string, string> {
  const value: Record<string, string> = { Accept: "application/json" }
  if (hasCredentials(config)) value.Authorization = authHeader(config)
  return value
}

export function noMachineStatus(status: number | undefined): boolean {
  return status === 404 || status === 503
}

function unauthorized(config: ServerConfig): Error {
  return new Error(hasCredentials(config)
    ? "HTTP 401: the server rejected these credentials."
    : "HTTP 401: this server requires a username and password, and none were sent.")
}

async function nativeGet(config: ServerConfig, path: string) {
  const target = `${machineBaseUrl(config)}${path}`
  try {
    return await CapacitorHttp.get({ url: target, headers: headers(config), connectTimeout: 12_000, readTimeout: 12_000 })
  } catch {
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  }
}

async function browserGet(config: ServerConfig, path: string): Promise<Response> {
  const target = `${machineBaseUrl(config)}${path}`
  try {
    return await fetch(target, { headers: headers(config) })
  } catch {
    throw new Error(`Cannot reach ${config.host}:${config.port}.`)
  }
}

/**
 * Resolves to a snapshot when this endpoint is a machine daemon, to null when it demonstrably is
 * not — 404, a registry-less 503, or a 200 carrying something else, which is what a direct OpenCode
 * server answers. Anything else throws, because a rejected password and an unreachable host are
 * facts the caller has to be able to tell apart from "there is no daemon here".
 */
async function discoverMachinePath(config: ServerConfig, path: string): Promise<MachineSnapshot | null> {
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path })
    if (!result.ok) {
      if (result.error.code === "http" && noMachineStatus(result.error.status)) return null
      if (result.error.code === "http" && result.error.status === 401) throw unauthorized(config)
      throw new Error(result.error.message)
    }
    return parseMachineSnapshot(result.response.data)
  }

  if (Capacitor.isNativePlatform()) {
    const response = await nativeGet(config, path)
    if (noMachineStatus(response.status)) return null
    if (response.status === 401) throw unauthorized(config)
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
    return parseMachineSnapshot(response.data)
  }

  const response = await browserGet(config, path)
  if (noMachineStatus(response.status)) return null
  if (response.status === 401) throw unauthorized(config)
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseMachineSnapshot(await response.json())
}

/** Both routes are published; older daemons answer only the second. */
async function discoverAt(config: ServerConfig): Promise<MachineSnapshot | null> {
  for (const path of ["/v1/machine", "/global/machine"]) {
    const machine = await discoverMachinePath(config, path)
    if (machine) return machine
  }
  return null
}

/**
 * Resolve the machine-level endpoint separately from the saved agent/session endpoint. An existing
 * OpenCode profile commonly points at 4096 while the daemon defaults to 4097, so the task APIs may
 * live one port away from the sessions the profile was saved for.
 *
 * A candidate that answers "no daemon" is a clean negative and the next candidate is tried. A
 * candidate that fails for any other reason is remembered: if nothing is found, that failure is
 * what the caller is told, so a wrong password never surfaces as a missing daemon.
 */
export async function discoverMachineConnection(config: ServerConfig): Promise<MachineConnection | null> {
  let failure: unknown
  for (const candidate of machineCandidates(config)) {
    try {
      const machine = await discoverAt(candidate)
      if (machine) return { machine, config: candidate }
    } catch (cause) {
      failure ??= cause
    }
  }
  if (failure !== undefined) throw failure
  return null
}

export async function discoverMachine(config: ServerConfig): Promise<MachineSnapshot | null> {
  return (await discoverMachineConnection(config))?.machine ?? null
}
