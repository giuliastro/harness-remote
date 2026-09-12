import { normalizeServerConfig } from "./serverConfig"
import type { ServerConfig } from "./types"

export const WORKSPACE_MACHINES_STORAGE_KEY = "harness-remote.workspace.machines.v1"
export const DESKTOP_LOCAL_MACHINE_ID = "desktop-local-runtime"

export type WorkspaceMachine = {
  id: string
  name: string
  config: ServerConfig
}

function machineID(): string {
  return globalThis.crypto?.randomUUID?.() ?? `machine-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function isDesktopLocalMachine(machine: Pick<WorkspaceMachine, "id">): boolean {
  return machine.id === DESKTOP_LOCAL_MACHINE_ID
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
  const normalized = normalizeServerConfig({
    backend: "opencode",
    host: config.host,
    port: config.port,
    username: config.username,
    password: config.password
  })
  if (!normalized) return null

  const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : machineID()
  if (id === DESKTOP_LOCAL_MACHINE_ID) return null
  return {
    id,
    name: typeof candidate.name === "string" && candidate.name.trim()
      ? candidate.name.trim()
      : normalized.host,
    config: {
      ...normalized,
      backend: "opencode",
      agentId: undefined
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
    if (isDesktopLocalMachine(machine)) return []
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