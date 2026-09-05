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

function acpPromptAttachments(attachments = []) {
  return attachments.map((attachment) => {
    const match = /^data:[^;,]+;base64,(.+)$/s.exec(attachment.url)
    if (!match) throw daemonError("session_prompt_rejected", "An attachment must be a base64 data URL")
    return { mime: attachment.mime, filename: attachment.filename, data: match[1] }
  })
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

  snapshot() { return this.registry.snapshot() }

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
  const primaryEntry = daemon.hostEntry(primaryAgentID)
  const bridgeServer = primaryEntry?.kind === "acp" && primaryAcp
    ? createServer({ config, acp: primaryAcp, machineRegistry: daemon.registry, serviceOptions })
    : undefined
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
    if (agentID === primaryAgentID && bridgeServer) return bridgeServer
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
    const server = agentID === primaryAgentID && bridgeServer ? bridgeServer : acpBridgeServer(agentID)
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
      await service.prompt(sessionID, text, modelWireName(resolvedModel), acpPromptAttachments(attachments), acpModelVariant(resolvedModel))
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
            { type: "text", text },
            ...attachments.map((attachment) => ({
              type: "file",
              mime: attachment.mime,
              filename: attachment.filename,
              url: attachment.url
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
  const commandSession = async (agentID, sessionID, { command, arguments: argumentsText, directory, model, variant }) => {
    const entry = daemon.hostEntry(agentID)
    if (!entry) throw daemonError("unknown_agent", `Unknown agent: ${agentID}`)
    const requestedModel = model ? { ...model, ...(variant ? { variant } : {}) } : null
    const resolvedModel = await resolvePromptModel(daemon, agentID, requestedModel, directory)
    const text = argumentsText ? `/${command} ${argumentsText}` : `/${command}`

    if (entry.kind === "acp") {
      const service = acpService(agentID)
      if (!service) throw daemonError("session_unavailable", `Agent ${agentID} cannot load native Sessions`)
      await service.prompt(sessionID, text, modelWireName(resolvedModel), [], acpModelVariant(resolvedModel))
      return
    }

    const host = entry.host
    try {
      await host.start?.()
    } catch (error) {
      throw daemonError("agent_unavailable", error instanceof Error ? error.message : `Agent ${agentID} is unavailable`)
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const url = `http://${host.readinessHost ?? host.host ?? "127.0.0.1"}:${host.port}/session/${encodeURIComponent(sessionID)}/command${query}`
    const headers = { Accept: "application/json", "Content-Type": "application/json" }
    const authorization = internalAuthorization(host)
    if (authorization) headers.Authorization = authorization
    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          command,
          arguments: argumentsText,
          model: resolvedModel ? `${resolvedModel.providerID}/${resolvedModel.modelID}` : undefined,
          variant: resolvedModel?.variant || undefined
        })
      })
    } catch {
      throw daemonError("session_command_uncertain", `Command delivery for Session ${sessionID} is uncertain`, { ambiguous: true })
    }
    if (!response.ok) {
      let detail = ""
      try { detail = await response.text() } catch {}
      const message = detail || `Running command on ${agentID} returned HTTP ${response.status}`
      if (response.status >= 500) throw daemonError("session_command_uncertain", message, { ambiguous: true })
      throw daemonError("session_command_rejected", message)
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
  const listHandoffSessions = async (targetAgentID, directory) => {
    const targetEntry = daemon.hostEntry(targetAgentID)
    if (!targetEntry) throw daemonError("unknown_agent", `Unknown target agent: ${targetAgentID}`)

    if (targetEntry.kind === "acp") {
      const service = acpService(targetAgentID)
      if (!service || typeof service.listSessions !== "function") {
        throw daemonError("agent_unavailable", `Agent ${targetAgentID} cannot list native Sessions for handoff recovery`)
      }
      const sessions = await service.listSessions(directory)
      return sessions
        .filter((session) => session?.id && (!directory || session.directory === directory))
        .map((session) => ({ id: session.id, directory: session.directory || directory }))
    }

    const host = targetEntry.host
    try {
      await host.start?.()
    } catch (error) {
      throw daemonError("agent_unavailable", error instanceof Error ? error.message : `Agent ${targetAgentID} is unavailable`)
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const url = `http://${host.readinessHost ?? host.host ?? "127.0.0.1"}:${host.port}/session${query}`
    const headers = { Accept: "application/json" }
    const authorization = internalAuthorization(host)
    if (authorization) headers.Authorization = authorization
    let response
    try {
      response = await fetch(url, { method: "GET", headers })
    } catch {
      throw daemonError("agent_unavailable", `Cannot list ${targetAgentID} Sessions for handoff recovery`)
    }
    if (!response.ok) {
      let detail = ""
      try { detail = await response.text() } catch {}
      throw daemonError("agent_unavailable", detail || `Listing ${targetAgentID} Sessions returned HTTP ${response.status}`)
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      throw daemonError("agent_unavailable", `Listing ${targetAgentID} Sessions returned an unreadable response`)
    }
    const sessions = Array.isArray(payload) ? payload : Array.isArray(payload?.sessions) ? payload.sessions : []
    return sessions
      .map((session) => ({
        id: session?.id || session?.sessionId,
        directory: session?.directory || session?.cwd || directory
      }))
      .filter((session) => session.id && (!directory || session.directory === directory))
  }

  const handoffRecoverySnapshot = async (targetAgentID, directory) => ({
    kind: "native-session-handoff-create",
    targetAgentID,
    directory,
    beforeSessionIDs: (await listHandoffSessions(targetAgentID, directory)).map((session) => session.id)
  })

  const handoffResultForTarget = async (sourceAgentID, sourceSessionID, targetAgentID, directory, targetSessionID) => {
    const source = { machineID, agentID: sourceAgentID, sessionID: sourceSessionID, directory }
    const target = { machineID, agentID: targetAgentID, sessionID: targetSessionID, directory }
    let link
    try {
      link = await links.addHandoff({ source, target })
    } catch {
      // The target identity is the resource-creation result. Link persistence is retried by the
      // client before first-prompt completion and must never make an existing target "unknown".
    }
    return { target, ...(link ? { link } : {}) }
  }

  const reconcileHandoff = async (sourceAgentID, sourceSessionID, input, recovery) => {
    if (
      !recovery
      || recovery.kind !== "native-session-handoff-create"
      || recovery.targetAgentID !== input.targetAgentID
      || recovery.directory !== input.directory
      || !Array.isArray(recovery.beforeSessionIDs)
    ) return undefined

    const before = new Set(recovery.beforeSessionIDs.filter((value) => typeof value === "string" && value))
    const current = await listHandoffSessions(input.targetAgentID, input.directory)
    const candidates = current.filter((session) => !before.has(session.id))
    if (candidates.length !== 1) return undefined
    return handoffResultForTarget(sourceAgentID, sourceSessionID, input.targetAgentID, input.directory, candidates[0].id)
  }

  const handoffSession = async (
    sourceAgentID,
    sourceSessionID,
    { targetAgentID, directory, model, variant, title },
    { checkpoint } = {}
  ) => {
    const sourceEntry = daemon.hostEntry(sourceAgentID)
    if (!sourceEntry) throw daemonError("unknown_agent", `Unknown source agent: ${sourceAgentID}`)
    const targetEntry = daemon.hostEntry(targetAgentID)
    if (!targetEntry) throw daemonError("unknown_agent", `Unknown target agent: ${targetAgentID}`)
    if (targetEntry.host?.capabilities?.sessions === false || daemon.registry.host(targetAgentID)?.capabilities?.sessions === false) {
      throw daemonError("unsupported_agent", `Agent ${targetAgentID} does not support native Sessions`)
    }

    // Validate the explicit model before creating a resource, but do not apply it during Session
    // creation. The first prompt already carries model + variant through the mature prompt path.
    // Keeping post-create model changes out of this mutation removes a large ambiguous window.
    const requestedModel = model ? { ...model, ...(variant ? { variant } : {}) } : null
    if (requestedModel) await daemon.resolveModel(targetAgentID, requestedModel, { directory })

    // Recovery needs a durable "before" set. If the target cannot be listed, fail before session/new
    // rather than create a resource we would have no safe way to identify after a lost response.
    const recovery = await handoffRecoverySnapshot(targetAgentID, directory)
    let targetSession

    if (targetEntry.kind === "acp") {
      const service = acpService(targetAgentID)
      if (!service || typeof service.createSession !== "function") {
        throw daemonError("unsupported_agent", `Agent ${targetAgentID} cannot create native Sessions`)
      }
      try {
        // Deliberately bare: title/model enrichment must not sit between session/new and durable
        // knowledge of the returned Session id.
        targetSession = await service.createSession({ directory })
      } catch (error) {
        if (error && typeof error === "object") {
          error.ambiguous = true
          error.recovery = recovery
        }
        throw error
      }
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
        response = await fetch(url, { method: "POST", headers, body: "{}" })
      } catch {
        throw daemonError("handoff_uncertain", `Creating ${targetAgentID} Session is uncertain`, {
          ambiguous: true,
          recovery
        })
      }
      if (!response.ok) {
        let detail = ""
        try { detail = await response.text() } catch {}
        const message = detail || `Creating ${targetAgentID} Session returned HTTP ${response.status}`
        if (response.status >= 500) {
          throw daemonError("handoff_uncertain", message, { ambiguous: true, recovery })
        }
        throw daemonError("handoff_rejected", message)
      }
      try {
        targetSession = await response.json()
      } catch {
        throw daemonError("handoff_uncertain", `Creating ${targetAgentID} Session returned an unreadable response`, {
          ambiguous: true,
          recovery
        })
      }
    }

    if (!targetSession?.id) {
      throw daemonError("handoff_uncertain", `Agent ${targetAgentID} did not return a native Session id`, {
        ambiguous: true,
        recovery
      })
    }

    // From this point on the target is durable knowledge. Persist it in the operation ledger before
    // any optional title/link enrichment so a later failure or daemon crash can only return/reuse X.
    let result = { target: { machineID, agentID: targetAgentID, sessionID: targetSession.id, directory } }
    if (typeof checkpoint === "function") {
      try {
        await checkpoint(result)
      } catch (error) {
        // session/new already returned X. If the ledger write itself fails before X becomes durable,
        // the only safe fallback is the same read-only reconciliation baseline used for a lost
        // session/new response; never allow the client to generate a fresh creation id blindly.
        if (error && typeof error === "object") {
          error.ambiguous = true
          error.recovery = recovery
        }
        throw error
      }
    }

    // Naming is cosmetic and model/variant are intentionally deferred to the first prompt. A naming
    // failure therefore cannot downgrade an already-known target into an uncertain creation.
    if (title && targetEntry.kind === "acp") {
      const service = acpService(targetAgentID)
      try { await service?.renameSession?.(targetSession.id, title) } catch {}
    }

    result = await handoffResultForTarget(sourceAgentID, sourceSessionID, targetAgentID, directory, targetSession.id)
    if (typeof checkpoint === "function") await checkpoint(result)
    return result
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
        ...(bridgeServer ? [[primaryAgentID, bridgeServer.acpService?.diagnostics?.()]] : []),
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
    commandSession,
    stopSession,
    handoffSession,
    reconcileHandoff,
    operationLedger: operations,
    sessionLinkStore: links
  })
  const launchServer = createLaunchServer({ innerServer: claimServer, config, taskRunController: runs })
  const modelServer = createModelServer({ innerServer: launchServer, config, daemon, taskStore: tasks, projectCatalog: projects })
  const finishServer = createFinishServer({ innerServer: modelServer, config, taskStore: tasks, worktreeManager: worktrees, taskRunController: runs })
  return createWorkThreadServerFactory({ innerServer: finishServer, config, controller: threads })
}