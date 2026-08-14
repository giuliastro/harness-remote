import { Capacitor, CapacitorHttp } from "@capacitor/core"
import { desktopRequestResult, isDesktopPlatform } from "./desktopBridge"
import { authHeader, hasCredentials, machineBaseUrl } from "./serverConfig"
import type { MachineSnapshot, ServerConfig } from "./types"

const DEFAULT_MACHINE_DAEMON_PORT = 4097

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

function unwrapPayload(value: unknown): unknown {
  let candidate = value
  for (let pass = 0; pass < 3; pass += 1) {
    if (typeof candidate === "string") {
      const text = candidate.replace(/^\uFEFF/, "").trim()
      if (!text) return candidate
      try {
        candidate = JSON.parse(text)
        continue
      } catch {
        return candidate
      }
    }
    if (candidate && typeof candidate === "object" && "data" in candidate) {
      candidate = (candidate as { data?: unknown }).data
      continue
    }
    break
  }
  return candidate
}

function parseMachineSnapshot(value: unknown): MachineSnapshot {
  const candidate = unwrapPayload(value)
  const snapshot = candidate as Partial<MachineSnapshot> | null
  if (!snapshot?.machine || typeof snapshot.machine.id !== "string" || !Array.isArray(snapshot.agents)) {
    throw new Error("The machine daemon returned an incompatible machine snapshot.")
  }
  return snapshot as MachineSnapshot
}

function fallbackOpenCodeSnapshot(config: ServerConfig): MachineSnapshot {
  return {
    machine: {
      id: `daemon:${config.host.trim()}:${config.port}`,
      name: config.host.trim()
    },
    agents: [{
      id: config.agentId?.trim() || "opencode",
      label: "OpenCode",
      backend: "opencode",
      transport: "http",
      managed: true,
      state: "available",
      capabilities: { sessions: true }
    }]
  }
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

async function discoverMachinePath(config: ServerConfig, path: string): Promise<MachineSnapshot | null> {
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path })
    if (!result.ok) {
      if (result.error.code === "http" && noMachineStatus(result.error.status)) return null
      throw new Error(result.error.message)
    }
    return parseMachineSnapshot(result.response.data)
  }

  if (Capacitor.isNativePlatform()) {
    const response = await nativeGet(config, path)
    if (noMachineStatus(response.status)) return null
    if (response.status >= 400) throw new Error(`HTTP ${response.status}`)
    return parseMachineSnapshot(response.data)
  }

  const response = await browserGet(config, path)
  if (noMachineStatus(response.status)) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return parseMachineSnapshot(await response.json())
}

async function hasDaemonProjectsRoute(config: ServerConfig): Promise<boolean> {
  if (isDesktopPlatform()) {
    const result = await desktopRequestResult(config, { path: "/v1/projects" })
    if (!result.ok) return false
    const value = unwrapPayload(result.response.data) as { projects?: unknown } | null
    return Array.isArray(value?.projects)
  }

  if (Capacitor.isNativePlatform()) {
    const response = await nativeGet(config, "/v1/projects")
    if (response.status >= 400) return false
    const value = unwrapPayload(response.data) as { projects?: unknown } | null
    return Array.isArray(value?.projects)
  }

  const response = await browserGet(config, "/v1/projects")
  if (!response.ok) return false
  try {
    const value = await response.json() as { projects?: unknown }
    return Array.isArray(value.projects)
  } catch {
    return false
  }
}

function machineCandidates(config: ServerConfig): ServerConfig[] {
  const current = { ...config }
  if (config.backend !== "opencode" || config.port === DEFAULT_MACHINE_DAEMON_PORT) return [current]
  return [
    current,
    { ...config, port: DEFAULT_MACHINE_DAEMON_PORT, agentId: config.agentId?.trim() || "opencode" }
  ]
}

async function discoverAt(config: ServerConfig): Promise<MachineSnapshot | null> {
  for (const path of ["/v1/machine", "/global/machine"]) {
    try {
      const machine = await discoverMachinePath(config, path)
      if (machine) return machine
    } catch {
      // A direct OpenCode endpoint can return unrelated payloads for these paths. Keep probing until
      // we either positively identify a machine daemon or exhaust the candidate endpoint.
    }
  }

  if (config.backend === "opencode" && await hasDaemonProjectsRoute(config)) {
    return fallbackOpenCodeSnapshot(config)
  }
  return null
}

/**
 * Resolve the machine-level endpoint separately from the saved agent/session endpoint. An existing
 * OpenCode profile commonly points at 4096, while the Harness machine daemon defaults to 4097. Task
 * APIs must use the daemon connection, not whatever endpoint happens to serve OpenCode sessions.
 */
export async function discoverMachineConnection(config: ServerConfig): Promise<MachineConnection | null> {
  for (const candidate of machineCandidates(config)) {
    try {
      const machine = await discoverAt(candidate)
      if (machine) return { machine, config: candidate }
    } catch {
      // Try the next candidate. The dialog will report the daemon requirement if none qualify.
    }
  }
  return null
}

export async function discoverMachine(config: ServerConfig): Promise<MachineSnapshot | null> {
  return (await discoverMachineConnection(config))?.machine ?? null
}

export function selectableMachineAgents(machine: MachineSnapshot): MachineSnapshot["agents"] {
  return (Array.isArray(machine.agents) ? machine.agents : []).filter((agent) => agent.state === "available" || agent.state === "configured")
}
