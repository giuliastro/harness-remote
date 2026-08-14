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

function parseMachineSnapshot(value: unknown): MachineSnapshot {
  let candidate: unknown = value
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate)
    } catch {
      throw new Error("The machine daemon returned invalid JSON.")
    }
  }
  if (candidate && typeof candidate === "object" && "data" in candidate) {
    const wrapped = (candidate as { data?: unknown }).data
    if (wrapped && typeof wrapped === "object") candidate = wrapped
  }
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
    const value = result.response.data as { projects?: unknown } | null
    return Array.isArray(value?.projects)
  }

  if (Capacitor.isNativePlatform()) {
    const response = await nativeGet(config, "/v1/projects")
    if (response.status >= 400) return false
    let value: unknown = response.data
    if (typeof value === "string") {
      try { value = JSON.parse(value) } catch { return false }
    }
    return Boolean(value && typeof value === "object" && Array.isArray((value as { projects?: unknown }).projects))
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

/**
 * Best-effort daemon discovery. New daemons expose /v1/machine and /global/machine. OpenCode-only
 * daemons can also be positively identified by the machine-level /v1/projects route, which gives
 * the Android client a safe fallback if a native HTTP layer mangles the machine snapshot payload.
 * A direct/legacy OpenCode server does not expose that route, so it still returns null here.
 */
export async function discoverMachine(config: ServerConfig): Promise<MachineSnapshot | null> {
  let lastError: Error | null = null
  for (const path of ["/v1/machine", "/global/machine"]) {
    try {
      const machine = await discoverMachinePath(config, path)
      if (machine) return machine
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (config.backend === "opencode") {
    try {
      if (await hasDaemonProjectsRoute(config)) return fallbackOpenCodeSnapshot(config)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
    }
  }

  if (lastError && !/HTTP (404|503)/.test(lastError.message)) throw lastError
  return null
}

export function selectableMachineAgents(machine: MachineSnapshot): MachineSnapshot["agents"] {
  return (Array.isArray(machine.agents) ? machine.agents : []).filter((agent) => agent.state === "available" || agent.state === "configured")
}
