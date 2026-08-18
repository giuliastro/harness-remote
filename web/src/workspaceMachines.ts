import type { ServerConfig } from "./types"

export const WORKSPACE_MACHINES_STORAGE_KEY = "harness-remote.workspace.machines.v1"

export type WorkspaceMachine = {
  id: string
  name: string
  config: ServerConfig
}

function machineID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `machine-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function normalizeMachine(value: unknown): WorkspaceMachine | null {
  if (!value || typeof value !== "object") return null
  const candidate = value as {
    id?: unknown
    name?: unknown
    config?: Partial<ServerConfig>
  }
  const config = candidate.config
  if (!config || typeof config.host !== "string" || typeof config.port !== "number") return null
  if (typeof config.username !== "string" || typeof config.password !== "string") return null
  if (!config.host.trim() || !Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) return null

  return {
    id: typeof candidate.id === "string" && candidate.id ? candidate.id : machineID(),
    name: typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name.trim()
      : config.host.trim(),
    config: {
      backend: "opencode",
      host: config.host.trim(),
      port: config.port,
      username: config.username,
      password: config.password
    }
  }
}

export function loadWorkspaceMachines(): WorkspaceMachine[] {
  try {
    const raw = localStorage.getItem(WORKSPACE_MACHINES_STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((value) => {
      const machine = normalizeMachine(value)
      return machine ? [machine] : []
    })
  } catch {
    return []
  }
}

export function persistWorkspaceMachines(machines: WorkspaceMachine[]): void {
  const normalized = machines.flatMap((machine) => {
    const next = normalizeMachine(machine)
    return next ? [next] : []
  })
  localStorage.setItem(WORKSPACE_MACHINES_STORAGE_KEY, JSON.stringify(normalized))
}

export function createWorkspaceMachine(): WorkspaceMachine {
  return {
    id: machineID(),
    name: "New machine",
    config: {
      backend: "opencode",
      host: "",
      port: 4097,
      username: "harness",
      password: ""
    }
  }
}
