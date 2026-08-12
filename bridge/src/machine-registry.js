import { randomUUID } from "node:crypto"
import { link, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises"
import { hostname } from "node:os"
import path from "node:path"

const IDENTITY_FILE = "machine.json"

function validIdentity(value) {
  return value && typeof value.id === "string" && value.id.length > 0 && typeof value.name === "string" && value.name.length > 0
}

async function readIdentity(machineFile) {
  const parsed = JSON.parse(await readFile(machineFile, "utf8"))
  return validIdentity(parsed) ? parsed : undefined
}

async function preserveCorruptIdentity(machineFile, warn) {
  const corruptFile = `${machineFile}.corrupt-${Date.now()}-${process.pid}`
  try {
    await rename(machineFile, corruptFile)
  } catch (error) {
    if (error?.code === "ENOENT") return undefined
    throw error
  }
  warn(`Invalid Harness machine identity moved to ${corruptFile}; generating a new identity.`)
  return corruptFile
}

async function installIdentity(machineFile, identity) {
  const temporary = `${machineFile}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 })
  try {
    // Hard-linking the complete temp file is an atomic "create if absent" operation. If
    // another daemon wins the race, use its identity rather than returning two identities
    // for the same state directory.
    await link(temporary, machineFile)
    return identity
  } catch (error) {
    if (error?.code !== "EEXIST") throw error
    const existing = await readIdentity(machineFile)
    if (existing) return existing
    throw new Error("Concurrent Harness daemon created an invalid machine identity")
  } finally {
    await unlink(temporary).catch(() => {})
  }
}

export async function loadMachineIdentity(stateDirectory, options = {}) {
  const machineFile = path.join(stateDirectory, IDENTITY_FILE)
  const warn = options.warn ?? ((message) => process.stderr.write(`[machine] ${message}\n`))

  try {
    const existing = await readIdentity(machineFile)
    if (existing) return existing
    await preserveCorruptIdentity(machineFile, warn)
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
    if (error instanceof SyntaxError) await preserveCorruptIdentity(machineFile, warn)
  }

  const identity = {
    id: `machine_${(options.randomUUID ?? randomUUID)()}`,
    name: (options.hostname ?? hostname)(),
    createdAt: new Date().toISOString()
  }
  await mkdir(stateDirectory, { recursive: true })
  return installIdentity(machineFile, identity)
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

/**
 * ACP starts lazily, so lifecycle tracking has to wrap every start attempt rather than only
 * initial daemon boot. A successful restart restores availability after a prior process exit.
 */
export function trackAgentHostLifecycle(agent, registry, hostID) {
  const start = agent.start.bind(agent)
  agent.start = async (...args) => {
    try {
      const result = await start(...args)
      registry.updateHost(hostID, { state: "available" })
      return result
    } catch (error) {
      registry.updateHost(hostID, { state: "unavailable" })
      throw error
    }
  }
  agent.on("exit", () => registry.updateHost(hostID, { state: "unavailable" }))
  return agent
}
