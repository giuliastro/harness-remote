import { createAgentRoutingServer } from "./agent-router.js"
import { MachineRegistry, trackAgentHostLifecycle } from "./machine-registry.js"
import { trackManagedHostLifecycle } from "./opencode-host.js"
import { discoverProjects } from "./project-catalog.js"
import { createBridgeServer } from "./server.js"
import { TaskStore } from "./task-store.js"
import { WorktreeManager } from "./worktree-manager.js"

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

  hostEntry(id) {
    return this.hosts.get(id)
  }

  async startManagedHosts() {
    const eager = [...this.hosts.values()].filter((entry) => entry.eager)
    const settled = await Promise.allSettled(eager.map((entry) => entry.host.start()))
    return eager.map((entry, index) => settled[index].status === "fulfilled"
      ? { id: entry.id, status: "available" }
      : { id: entry.id, status: "unavailable", error: settled[index].reason })
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
  primaryAgentID = config.backend,
  serviceOptions,
  createServer = createBridgeServer,
  createRouter = createAgentRoutingServer,
  taskStore,
  projectCatalog,
  worktreeManager
}) {
  const bridgeServer = createServer({
    config,
    acp: primaryAcp,
    machineRegistry: daemon.registry,
    serviceOptions
  })
  const machineID = daemon.snapshot().machine.id
  const roots = config.roots?.length ? config.roots : [process.cwd()]
  const stateDirectory = config.stateDirectory ?? process.cwd()
  const tasks = taskStore ?? new TaskStore({ machineID, stateDirectory })
  const projects = projectCatalog ?? (() => discoverProjects({ machineID, roots }))
  const worktrees = worktreeManager ?? new WorktreeManager({ stateDirectory })
  return createRouter({
    daemon,
    config,
    primaryAgentID,
    bridgeServer,
    taskStore: tasks,
    projectCatalog: projects,
    worktreeManager: worktrees
  })
}
