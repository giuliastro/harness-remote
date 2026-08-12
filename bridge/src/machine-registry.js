import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"

const IDENTITY_FILE = "machine.json"

function validIdentity(value) {
  return value && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && value.name.length > 0
}

export async function loadMachineIdentity(stateDirectory, options = {}) {
  const machineFile = path.join(stateDirectory, IDENTITY_FILE)
  try {
    const parsed = JSON.parse(await readFile(machineFile, "utf8"))
    if (validIdentity(parsed)) return parsed
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
  }

  const identity = {
    id: `machine_${(options.randomUUID ?? randomUUID)()}`,
    name: (options.hostname ?? hostname)(),
    createdAt: new Date().toISOString()
  }
  await mkdir(stateDirectory, { recursive: true })
  const temporary = `${machineFile}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, machineFile)
  return identity
}

export class MachineRegistry {
  constructor(identity) {
    if (!validIdentity(identity)) throw new Error("MachineRegistry requires a stable machine identity")
    this.identity = { ...identity }
    this.hosts = new Map()
  }

  registerHost(host) {
    if (!host?.id || typeof host.id !== "string") throw new Error("Agent host requires an id")
    if (this.hosts.has(host.id)) throw new Error(`Agent host already registered: ${host.id}`)
    const normalized = {
      id: host.id,
      label: host.label ?? host.id,
      backend: host.backend ?? host.id,
      transport: host.transport ?? "acp",
      managed: host.managed !== false,
      state: host.state ?? "configured",
      capabilities: host.capabilities ? { ...host.capabilities } : {}
    }
    this.hosts.set(normalized.id, normalized)
    return { ...normalized, capabilities: { ...normalized.capabilities } }
  }

  updateHost(id, patch) {
    const current = this.hosts.get(id)
    if (!current) throw new Error(`Unknown agent host: ${id}`)
    const next = {
      ...current,
      ...patch,
      id: current.id,
      capabilities: patch.capabilities ? { ...patch.capabilities } : current.capabilities
    }
    this.hosts.set(id, next)
    return { ...next, capabilities: { ...next.capabilities } }
  }

  host(id) {
    const value = this.hosts.get(id)
    return value ? { ...value, capabilities: { ...value.capabilities } } : undefined
  }

  snapshot() {
    return {
      machine: { ...this.identity },
      agents: [...this.hosts.values()].map((host) => ({
        ...host,
        capabilities: { ...host.capabilities }
      }))
    }
  }
}
