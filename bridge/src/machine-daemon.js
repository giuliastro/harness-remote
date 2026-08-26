import { createAgentRoutingServer } from "./agent-router.js"
import { createAgentModelServer } from "./agent-model-server.js"
import { MachineRegistry, trackAgentHostLifecycle } from "./machine-registry.js"
import { trackManagedHostLifecycle } from "./opencode-host.js"
import { discoverProjects } from "./project-catalog.js"
import { createBridgeServer } from "./server.js"
import { createSessionClaimServer } from "./session-claim-server.js"
import { SessionLinkStore } from "./session-link-store.js"
import { SessionOperationLedger } from "./session-operation-ledger.js"
import { createTaskFinishServer } from "./task-finish-server.js"
import { createTaskLaunchServer } from "./task-launch-server.js"
import { TaskLauncher } from "./task-launcher.js"
import { TaskRunController } from "./task-run-controller.js"
import { TaskRunStore } from "./task-run-store.js"
import { WorktreeManager } from "./worktree-manager.js"
import { WorkThreadController } from "./work-thread-controller.js"
import { createWorkThreadServer } from "./work-thread-server.js"

function daemonError(code, message, options = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, options)
  return error
}

function internalAuthorization(host) {
  if (!host.username && !host.password) return undefined
  return `Basic ${Buffer.from(`${host.username ?? ""}:${host.password ?? ""}`, "utf8").toString("base64")}`
}

function nativeSessionKey(agentID, sessionID) {
  return `${agentID}\u0000${sessionID}`
}

function modelWireName(model) {
  return model ? `${model.providerID}/${model.modelID}` : undefined
}

/** Only a variant the catalog actually resolved from adapter-advertised options is applied. */
function acpModelVariant(model) {
  return model?.variant && model?.variantConfigId
    ? { configId: model.variantConfigId, value: model.variant }
    : undefined
}

/*
 * How long sending a prompt may wait for model discovery before proceeding without it.
 *
 * This mirrors the ceiling the model route already applies to a client-facing request. Discovery
 * itself keeps its full budget and stays owned by the daemon's single-flight catalog, so a cold ACP
 * adapter continues warming and the next prompt gets the resolved answer; what this bounds is only
 * how long the user waits. Without it, sending on a cold catalog blocked for the catalog's whole
 * 90s budget, which is what made a Session look wedged after a model change.
 */
const PROMPT_MODEL_RESOLVE_BUDGET_MS = 8_000

/**
 * A native Session that the harness can still serve must not be made unusable, or unusably slow, by
 * model discovery.
 *
 * `model_unavailable` is an authoritative catalog answer about the user's explicit choice and stays a
 * conflict. Any other outcome - a cold adapter, a timeout, a transport error, or discovery simply
 * taking longer than a person should wait - only costs the variant/metadata enrichment, so the
 * requested model is still sent and the Session keeps working.
 */
async function resolvePromptModel(daemon, agentID, requestedModel, directory) {
  if (!requestedModel) return null
  const unenriched = { ...requestedModel, variant: undefined, variantConfigId: undefined }
  const discovery = daemon.resolveModel(agentID, requestedModel, directory ? { directory } : undefined)
  let timer
  try {
    return await Promise.race([
      discovery,
      new Promise((resolve) => { timer = setTimeout(() => resolve(unenriched), PROMPT_MODEL_RESOLVE_BUDGET_MS) })
    ])
  } catch (error) {
    if (error?.code === "model_unavailable") throw error
    return unenriched
  } finally {
    clearTimeout(timer)
    // The catalog keeps this operation; this await only stops an unobserved rejection from the race.
    void discovery.catch(() => undefined)
  }
}

export class MachineDaemon {
  constructor(identity, { registry = new MachineRegistry(identity) } = {}) {
    this.registry = registry
    this.hosts = new Map()
  }

  registerAcpHost({ id, label, backend = id, capabilities = {}, contract = {}, agent, modelCatalog, bridgeConfig, serviceOptions, managed = true }) {
    this.registry.registerHost({ id, label, backend, transport: "acp", managed, state: "configured", capabilities, contract })
    const tracked = trackAgentHostLifecycle(agent, this.registry, id)
    this.hosts.set(id, { id, kind: "acp", host: tracked, modelCatalog, bridgeConfig, serviceOptions, eager: false })
    return tracked
  }

  registerManagedHttpHost({ id, label, backend = id, capabilities = {}, contract = {}, host, modelCatalog, managed = true, eager = true }) {
    this.registry.registerHost({ id, label, backend, transport: "http", managed, state: "configured", capabilities, contract })
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

  modelDiagnostics(id, options) {
    const entry = this.hostEntry(id)
    if (!entry) return undefined
    return entry.modelCatalog?.diagnostics?.(options) ?? {
      source: "unavailable",
      cachedModels: 0,
      refreshedAt: null,
      ageMs: null,
      inFlight: false,
      lastAttemptAt: null,
      lastError: "Model discovery is not configured"
    }
  }

  async resolveModel(id, model, options) {
    if (!model) return null
    const entry = this.hostEntry(id)
    if (!entry) throw new Error(`Unknown agent: ${id}`)
    if (!entry.modelCatalog) throw new Error(`Agent ${id} does not expose model discovery`)
    if (typeof entry.modelCatalog.resolve === "function") return entry.modelCatalog.resolve(model, options)
    await entry.modelCatalog.validate(model, options)
    return model
  }

  async validateModel(id, model, options) {
    if (!model) return
    await this.resolveModel(id, model, options)
  }

  async startManagedHosts() {
    const eager = [...this.hosts.values()].filter((entry) => entry.eager)
    const settled = await Promise.allSettled(eager.map((entry) => entry.host.start()))
    return eager.map((entry, index) => settled[index].status === "fulfilled"
      ? { id: entry.id, status: "available" }
      : { id: entry.id, status: "unavailable", error: settled[index].reason })
  }

  /**
   * The registry holds each harness's declared capabilities. Attachment support is not declarable:
   * it is whatever the running ACP adapter negotiated (`promptCapabilities.image`), which is only
   * known once that adapter has started. Overlay it here so the client can offer an image picker
   * exactly where a prompt can carry one, and hide it - rather than fail on send - where it cannot.
   * Before the adapter starts the answer is "not yet", which is the safe default.
   */
  snapshot() {
    const snapshot = this.registry.snapshot()
    return {
      ...snapshot,
      agents: snapshot.agents.map((agent) => {
        const entry = this.hostEntry(agent.id)
        if (entry?.kind !== "acp") return agent
        return {
          ...agent,
          capabilities: {
            ...agent.capabilities,
            attachments: Boolean(entry.host?.promptCapabilities?.image)
          }
        }
      })
    }
  }

  diagnostics() {
    return {
      state: "running",
      machine: this.snapshot().machine,
      agents: this.snapshot().agents.map((agent) => {
        const entry = this.hostEntry(agent.id)
        return {
          ...agent,
          process: entry?.host?.diagnostics?.() ?? { processID: entry?.host?.processID },
          modelCatalog: entry?.modelCatalog?.diagnostics?.() ?? null
        }
      })
    }
  }

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
  createClaimServer = createSessionClaimServer,
  createModelServer = createAgentModelServer,
  createLaunchServer = createTaskLaunchServer,
  createFinishServer = createTaskFinishServer,
  createWorkThreadServerFactory = createWorkThreadServer,
  taskStore,
  projectCatalog,
  worktreeManager,
  taskLauncher,
  taskRunController,
  workThreadController,
  sessionOperationLedger,
  sessionLinkStore
}) {
  const bridgeServer = createServer({ config, acp: primaryAcp, machineRegistry: daemon.registry, serviceOptions })
  const scopedAcpServers = new Map()
  // Writer ownership belongs to one live adapter process. An adapter that exits takes every loaded
  // Session with it, so remembering a claim across a restart made Stop skip the reload it needs and
  // fail against a Session the new process had never opened.
  const claimedAcpSessions = new Set()
  const forgetClaimsOnAgentExit = (agentID, host) => {
    host?.on?.("exit", () => {
      for (const key of [...claimedAcpSessions]) {
        if (key.startsWith(`${agentID}\u0000`)) claimedAcpSessions.delete(key)
      }
    })
  }
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
  const operations = sessionOperationLedger ?? new SessionOperationLedger({ machineID, stateDirectory })
  const links = sessionLinkStore ?? new SessionLinkStore({ machineID, stateDirectory })
  const acpService = (agentID) => {
    const server = agentID === primaryAgentID ? bridgeServer : acpBridgeServer(agentID)
    return server?.acpService
  }
  const claimedAgents = new Set()
  const claimSession = async (agentID, sessionID) => {
    const entry = daemon.hostEntry(agentID)
    if (!entry) throw daemonError("unknown_agent", `Unknown agent: ${agentID}`)
    if (entry.kind !== "acp") throw daemonError("unsupported_agent", `Agent ${agentID} does not require ACP Session claiming`)
    if (!claimedAgents.has(agentID)) {
      claimedAgents.add(agentID)
      forgetClaimsOnAgentExit(agentID, entry.host)
    }
    const service = acpService(agentID)
    if (!service || typeof service.claimSession !== "function") {
      throw daemonError("session_unavailable", `Agent ${agentID} cannot claim native Sessions`)
    }
    try {
      await service.claimSession(sessionID)
    } catch (error) {
      if (/session not found/i.test(error instanceof Error ? error.message : String(error))) {
        throw daemonError("session_unavailable", `Native Session ${sessionID} is no longer available`)
      }
      throw error
    }
    claimedAcpSessions.add(nativeSessionKey(agentID, sessionID))
  }
  const promptSession = async (agentID, sessionID, { text, directory, model, variant, attachments = [] }) => {
    const entry = daemon.hostEntry(agentID)
    if (!entry) throw daemonError("unknown_agent", `Unknown agent: ${agentID}`)
    const requestedModel = model ? { ...model, ...(variant ? { variant } : {}) } : null
    const resolvedModel = await resolvePromptModel(daemon, agentID, requestedModel, directory)

    if (entry.kind === "acp") {
      const service = acpService(agentID)
      if (!service) throw daemonError("session_unavailable", `Agent ${agentID} cannot load native Sessions`)
      // Model and variant travel with the prompt through AcpService so they are applied in the one
      // place that already loads configOptions, orders the model before its variant, and defers both
      // to dequeue when a turn is still running. Setting them here directly reordered the model
      // after the variant and mutated a live turn's configuration.
      // The empty array here was why an attachment could never reach an ACP harness: the client and
      // the bridge server both carried images, and the daemon dropped them on the floor.
      await service.prompt(sessionID, text, modelWireName(resolvedModel), attachments, acpModelVariant(resolvedModel))
      return
    }

    const host = entry.host
    try {
      await host.start?.()
    } catch (error) {
      throw daemonError("agent_unavailable", error instanceof Error ? error.message : `Agent ${agentID} is unavailable`)
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const url = `http://${host.readinessHost ?? host.host ?? "127.0.0.1"}:${host.port}/session/${encodeURIComponent(sessionID)}/prompt_async${query}`
    const headers = { Accept: "application/json", "Content-Type": "application/json" }
    const authorization = internalAuthorization(host)
    if (authorization) headers.Authorization = authorization
    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          parts: [
            ...(text ? [{ type: "text", text }] : []),
            ...attachments.map((file) => ({
              type: "file",
              mime: file.mime,
              filename: file.filename,
              url: `data:${file.mime};base64,${file.data}`
            }))
          ],
          model: resolvedModel ? { providerID: resolvedModel.providerID, modelID: resolvedModel.modelID } : undefined,
          variant: resolvedModel?.variant || undefined
        })
      })
    } catch {
      throw daemonError("session_prompt_uncertain", `OpenCode prompt delivery for Session ${sessionID} is uncertain`, { ambiguous: true })
    }
    if (!response.ok) {
      let detail = ""
      try { detail = await response.text() } catch {}
      const message = detail || `OpenCode returned HTTP ${response.status}`
      if (response.status >= 500) throw daemonError("session_prompt_uncertain", message, { ambiguous: true })
      throw daemonError("session_prompt_rejected", message)
    }
  }
  const stopSession = async (agentID, sessionID, { directory }) => {
    const entry = daemon.hostEntry(agentID)
    if (!entry) throw daemonError("unknown_agent", `Unknown agent: ${agentID}`)

    if (entry.kind === "acp") {
      const service = acpService(agentID)
      if (!service) throw daemonError("session_unavailable", `Agent ${agentID} cannot stop native Sessions`)
      if (!claimedAcpSessions.has(nativeSessionKey(agentID, sessionID))) {
        await claimSession(agentID, sessionID)
      }
      await service.abort(sessionID)
      return
    }

    const host = entry.host
    try {
      await host.start?.()
    } catch (error) {
      throw daemonError("agent_unavailable", error instanceof Error ? error.message : `Agent ${agentID} is unavailable`)
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const url = `http://${host.readinessHost ?? host.host ?? "127.0.0.1"}:${host.port}/session/${encodeURIComponent(sessionID)}/abort${query}`
    const headers = { Accept: "application/json", "Content-Type": "application/json" }
    const authorization = internalAuthorization(host)
    if (authorization) headers.Authorization = authorization
    let response
    try {
      response = await fetch(url, { method: "POST", headers, body: "{}" })
    } catch {
      throw daemonError("session_stop_uncertain", `Stop delivery for Session ${sessionID} is uncertain`, { ambiguous: true })
    }
    if (!response.ok) {
      let detail = ""
      try { detail = await response.text() } catch {}
      const message = detail || `Stopping ${agentID} returned HTTP ${response.status}`
      if (response.status >= 500) throw daemonError("session_stop_uncertain", message, { ambiguous: true })
      throw daemonError("session_stop_rejected", message)
    }
  }
  const handoffSession = async (sourceAgentID, sourceSessionID, { targetAgentID, directory, model, variant, title }) => {
    const sourceEntry = daemon.hostEntry(sourceAgentID)
    if (!sourceEntry) throw daemonError("unknown_agent", `Unknown source agent: ${sourceAgentID}`)
    const targetEntry = daemon.hostEntry(targetAgentID)
    if (!targetEntry) throw daemonError("unknown_agent", `Unknown target agent: ${targetAgentID}`)
    if (targetEntry.host?.capabilities?.sessions === false || daemon.registry.host(targetAgentID)?.capabilities?.sessions === false) {
      throw daemonError("unsupported_agent", `Agent ${targetAgentID} does not support native Sessions`)
    }

    const requestedModel = model ? { ...model, ...(variant ? { variant } : {}) } : null
    const resolvedModel = requestedModel
      ? await daemon.resolveModel(targetAgentID, requestedModel, { directory })
      : null
    const targetTitle = title || `Handoff from ${sourceAgentID}`
    let targetSession
    let nativeCreated = false

    try {
      if (targetEntry.kind === "acp") {
        const service = acpService(targetAgentID)
        if (!service || typeof service.createSession !== "function") {
          throw daemonError("unsupported_agent", `Agent ${targetAgentID} cannot create native Sessions`)
        }
        try {
          targetSession = await service.createSession({
            directory,
            title: targetTitle,
            model: modelWireName(resolvedModel)
          })
        } catch (error) {
          if (error && typeof error === "object") error.ambiguous = true
          throw error
        }
        if (!targetSession?.id) throw daemonError("handoff_rejected", `Agent ${targetAgentID} did not return a native Session id`, { ambiguous: true })
        nativeCreated = true
        // createSession already applied the base model, so only the variant is left. Apply it through
        // the service that owns this Session's configOptions rather than as a raw adapter request.
        const variantToApply = acpModelVariant(resolvedModel)
        if (variantToApply) await service.setModel(targetSession.id, modelWireName(resolvedModel), variantToApply)
      } else {
        const host = targetEntry.host
        try {
          await host.start?.()
        } catch (error) {
          throw daemonError("agent_unavailable", error instanceof Error ? error.message : `Agent ${targetAgentID} is unavailable`)
        }
        const query = `?directory=${encodeURIComponent(directory)}`
        const url = `http://${host.readinessHost ?? host.host ?? "127.0.0.1"}:${host.port}/session${query}`
        const headers = { Accept: "application/json", "Content-Type": "application/json" }
        const authorization = internalAuthorization(host)
        if (authorization) headers.Authorization = authorization
        let response
        try {
          response = await fetch(url, {
            method: "POST",
            headers,
            body: JSON.stringify({
              title: targetTitle,
              model: resolvedModel ? {
                providerID: resolvedModel.providerID,
                id: resolvedModel.modelID,
                variant: resolvedModel.variant || undefined
              } : undefined
            })
          })
        } catch {
          throw daemonError("handoff_uncertain", `Creating ${targetAgentID} Session is uncertain`, { ambiguous: true })
        }
        if (!response.ok) {
          let detail = ""
          try { detail = await response.text() } catch {}
          const message = detail || `Creating ${targetAgentID} Session returned HTTP ${response.status}`
          if (response.status >= 500) throw daemonError("handoff_uncertain", message, { ambiguous: true })
          throw daemonError("handoff_rejected", message)
        }
        try {
          targetSession = await response.json()
        } catch {
          throw daemonError("handoff_uncertain", `Creating ${targetAgentID} Session returned an unreadable response`, { ambiguous: true })
        }
        if (!targetSession?.id) throw daemonError("handoff_uncertain", `Agent ${targetAgentID} did not return a native Session id`, { ambiguous: true })
        nativeCreated = true
      }

      const source = { machineID, agentID: sourceAgentID, sessionID: sourceSessionID, directory }
      const target = { machineID, agentID: targetAgentID, sessionID: targetSession.id, directory }
      const link = await links.addHandoff({ source, target })
      return { target, link }
    } catch (error) {
      if (nativeCreated && error && typeof error === "object") error.ambiguous = true
      throw error
    }
  }
  const launcher = taskLauncher ?? new TaskLauncher({ daemon, acpService })
  const runs = taskRunController ?? new TaskRunController({ taskStore: tasks, taskLauncher: launcher, acpService })
  const threads = workThreadController ?? new WorkThreadController({ taskStore: tasks, taskRunController: runs })
  const innerServer = createRouter({
    daemon,
    config,
    primaryAgentID,
    bridgeServer,
    acpBridgeServer,
    taskStore: tasks,
    projectCatalog: projects,
    worktreeManager: worktrees,
    diagnostics: () => ({
      ...daemon.diagnostics(),
      services: Object.fromEntries([
        [primaryAgentID, bridgeServer.acpService?.diagnostics?.()],
        ...[...scopedAcpServers.entries()].map(([agentID, server]) => [agentID, server.acpService?.diagnostics?.()])
      ].filter(([, value]) => value)),
      // Session-first control-plane state. Writer claims are per live adapter process, so a count
      // that outlives an adapter restart is itself the bug worth seeing here. Session ids are
      // harness-owned identifiers, never credentials or prompt content.
      nativeSessions: {
        claimedWriters: [...claimedAcpSessions].map((key) => {
          const [agentID, sessionID] = key.split("\u0000")
          return { agentID, sessionID }
        }),
        operationLedger: operations.diagnostics?.() ?? null
      }
    })
  })
  const claimServer = createClaimServer({
    innerServer,
    config,
    claimSession,
    promptSession,
    stopSession,
    handoffSession,
    operationLedger: operations
  })
  const launchServer = createLaunchServer({ innerServer: claimServer, config, taskRunController: runs })
  const modelServer = createModelServer({ innerServer: launchServer, config, daemon, taskStore: tasks, projectCatalog: projects })
  const finishServer = createFinishServer({ innerServer: modelServer, config, taskStore: tasks, worktreeManager: worktrees, taskRunController: runs })
  return createWorkThreadServerFactory({ innerServer: finishServer, config, controller: threads })
}