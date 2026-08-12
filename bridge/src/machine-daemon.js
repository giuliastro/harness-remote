import { MachineRegistry, trackAgentHostLifecycle } from "./machine-registry.js"
import { trackManagedHostLifecycle } from "./opencode-host.js"
import { createBridgeServer } from "./server.js"

export class MachineDaemon {
  constructor(identity, { registry = new MachineRegistry(identity) } = {}) {
    this.registry = registry
    this.hosts = new Map()
  }

  registerAcpHost({ id, label, backend = id, capabilities = {}, agent, managed = true }) {
    this.registry.registerHost({
      id,
      label,
      backend,
      transport: "acp",
      managed,
      state: "configured",
      capabilities
    })
    const tracked = trackAgentHostLifecycle(agent, this.registry, id)
    this.hosts.set(id, { id, kind: "acp", host: tracked, eager: false })
    return tracked
  }

  registerManagedHttpHost({ id, label, backend = id, capabilities = {}, host, managed = true }) {
    this.registry.registerHost({
      id,
      label,
      backend,
      transport: "http",
      managed,
      state: "configured",
      capabilities
    })
    const tracked = trackManagedHostLifecycle(host, this.registry, id)
    this.hosts.set(id, { id, kind: "http", host: tracked, eager: true })
    return tracked
  }

  async startManagedHosts() {
    const results = []
    for (const entry of this.hosts.values()) {
      if (!entry.eager) continue
      try {
        await entry.host.start()
        results.push({ id: entry.id, status: "available" })
      } catch (error) {
        results.push({ id: entry.id, status: "unavailable", error })
      }
    }
    return results
  }

  snapshot() {
    return this.registry.snapshot()
  }

  close() {
    for (const entry of this.hosts.values()) {
      if (entry.kind === "acp") entry.host.close?.()
      else entry.host.stop?.("SIGTERM")
    }
  }
}

export function createMachineDaemonServer({
  daemon,
  config,
  primaryAcp,
  serviceOptions,
  createServer = createBridgeServer
}) {
  return createServer({
    config,
    acp: primaryAcp,
    machineRegistry: daemon.registry,
    serviceOptions
  })
}
