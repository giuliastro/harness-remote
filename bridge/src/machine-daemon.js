import { createAgentRoutingServer } from "./agent-router.js"
import { createAgentModelServer } from "./agent-model-server.js"
import { MachineRegistry, trackAgentHostLifecycle } from "./machine-registry.js"
import { trackManagedHostLifecycle } from "./opencode-host.js"
import { discoverProjects } from "./project-catalog.js"
import { createBridgeServer } from "./server.js"
import { createTaskFinishServer } from "./task-finish-server.js"
import { createTaskLaunchServer } from "./task-launch-server.js"
import { TaskLauncher } from "./task-launcher.js"
import { TaskRunController } from "./task-run-controller.js"
import { TaskRunStore } from "./task-run-store.js"
import { WorktreeManager } from "./worktree-manager.js"
import { WorkThreadController } from "./work-thread-controller.js"
import { createWorkThreadServer } from "./work-thread-server.js"

export class MachineDaemon {
  constructor(identity, { registry = new MachineRegistry(identity) } = {}) {
    this.registry = registry
    this.hosts = new Map()
  }

  registerAcpHost({ id, label, backend = id, capabilities = {}, agent, modelCatalog, bridgeConfig, serviceOptions, managed = true }) {
    this.registry.registerHost({ id, label, backend, transport: "acp", managed, state: "configured", capabilities })
    const tracked = trackAgentHostLifecycle(agent, this.registry, id)
    this.hosts.set(id, { id, kind: "acp", host: tracked, modelCatalog, bridgeConfig, serviceOptions, eager: false })
    return tracked
  }

  registerManagedHttpHost({ id, label, backend = id, capabilities = {}, host, modelCatalog, managed = true, eager = true }) {
    this.registry.registerHost({ id, label, backend, transport: "http", managed, state: "configured", capabilities })
    const tracked = trackManagedHostLifecycle(host, this.registry, id)
    this.hosts.set(id, { id, kind: "http", host: tracked, modelCatalog, eager })
    return tracked
  }

  hostEntry(id) { return this.hosts.get(id) }

  async listModels(id, options) {
    const entry = this.hostEntry(id)
    if (!entry) throw new Error(`Unknown agent: ${id}`)
    if (!entry.modelCatalog) throw new Error(`Agent ${id} does not expose model discovery`)
    return entry.modelCatalog.list(options)
  }

  async validateModel(id, model) {
    if (!model) return
    const entry = this.hostEntry(id)
    if (!entry) throw new Error(`Unknown agent: ${id}`)
    if (!entry.modelCatalog) throw new Error(`Agent ${id} does not expose model discovery`)
    await entry.modelCatalog.validate(model)
  }

  async startManagedHosts() {
    const eager = [...this.hosts.values()].filter((entry) => entry.eager)
    const settled = await Promise.allSettled(eager.map((entry) => entry.host.start()))
    return eager.map((entry, index) => settled[index].status === "fulfilled"
      ? { id: entry.id, status: "available" }
      : { id: entry.id, status: "unavailable", error: settled[index].reason })
  }

  snapshot() { return this.registry.snapshot() }

  close() {
    for (const entry of this.hosts.values()) {
      entry.modelCatalog?.close?.()
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
  createModelServer = createAgentModelServer,
  createLaunchServer = createTaskLaunchServer,
  createFinishServer = createTaskFinishServer,
  createWorkThreadServerFactory = createWorkThreadServer,
  taskStore,
  projectCatalog,
  worktreeManager,
  taskLauncher,
  taskRunController,
  workThreadController
}) {
  const bridgeServer = createServer({ config, acp: primaryAcp, machineRegistry: daemon.registry, serviceOptions })
  const scopedAcpServers = new Map()
  const acpBridgeServer = (agentID) => {
    if (agentID === primaryAgentID) return bridgeServer
    const cached = scopedAcpServers.get(agentID)
    if (cached) return cached
    const entry = daemon.hostEntry(agentID)
    if (!entry || entry.kind !== "acp") return undefined
    const server = createServer({
      config: entry.bridgeConfig ?? { ...config, backend: agentID },
      acp: entry.host,
      machineRegistry: daemon.registry,
      serviceOptions: entry.serviceOptions
    })
    scopedAcpServers.set(agentID, server)
    return server
  }
  const machineID = daemon.snapshot().machine.id
  const roots = config.roots?.length ? config.roots : [process.cwd()]
  const stateDirectory = config.stateDirectory ?? process.cwd()
  const tasks = taskStore ?? new TaskRunStore({ machineID, stateDirectory })
  const projects = projectCatalog ?? (() => discoverProjects({ machineID, roots }))
  const worktrees = worktreeManager ?? new WorktreeManager({ stateDirectory })
  const acpService = (agentID) => {
    const server = agentID === primaryAgentID ? bridgeServer : acpBridgeServer(agentID)
    return server?.acpService
  }
  const launcher = taskLauncher ?? new TaskLauncher({ daemon, acpService })
  const runs = taskRunController ?? new TaskRunController({ taskStore: tasks, taskLauncher: launcher, acpService })
  const threads = workThreadController ?? new WorkThreadController({ taskStore: tasks, taskRunController: runs })
  const innerServer = createRouter({ daemon, config, primaryAgentID, bridgeServer, acpBridgeServer, taskStore: tasks, projectCatalog: projects, worktreeManager: worktrees })
  const launchServer = createLaunchServer({ innerServer, config, taskRunController: runs })
  const modelServer = createModelServer({ innerServer: launchServer, config, daemon, taskStore: tasks })
  const finishServer = createFinishServer({ innerServer: modelServer, config, taskStore: tasks, worktreeManager: worktrees, taskRunController: runs })
  return createWorkThreadServerFactory({ innerServer: finishServer, config, controller: threads })
}
