function runtimeError(code, message, options = {}) {
  const error = new Error(message)
  error.code = code
  Object.assign(error, options)
  return error
}

function internalAuthorization(host) {
  if (!host.username && !host.password) return undefined
  return `Basic ${Buffer.from(`${host.username ?? ""}:${host.password ?? ""}`, "utf8").toString("base64")}`
}

function validSource(source) {
  return source
    && typeof source === "object"
    && [source.machineID, source.agentID, source.sessionID, source.directory].every((value) => typeof value === "string" && value)
}

/**
 * Target-machine runtime for cross-machine Native Session continuation.
 *
 * It owns only creation/recovery of the new local Session and lineage metadata. It never loads or
 * claims the remote source Session, never transfers writer/approval/tool state, and never sends the
 * first prompt. The caller must provide a Project already resolved by the target daemon catalog.
 */
export function createCrossMachineTargetRuntime({ daemon, machineID, acpService, sessionLinkStore, fetchImpl = fetch }) {
  const listSessions = async (targetAgentID, directory) => {
    const targetEntry = daemon.hostEntry(targetAgentID)
    if (!targetEntry) throw runtimeError("unknown_agent", `Unknown target agent: ${targetAgentID}`)

    if (targetEntry.kind === "acp") {
      const service = acpService(targetAgentID)
      if (!service || typeof service.listSessions !== "function") {
        throw runtimeError("agent_unavailable", `Agent ${targetAgentID} cannot list native Sessions for cross-machine recovery`)
      }
      const sessions = await service.listSessions(directory)
      return sessions
        .filter((session) => session?.id && (!directory || session.directory === directory))
        .map((session) => ({ id: session.id, directory: session.directory || directory }))
    }

    const host = targetEntry.host
    try { await host.start?.() }
    catch (error) {
      throw runtimeError("agent_unavailable", error instanceof Error ? error.message : `Agent ${targetAgentID} is unavailable`)
    }
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : ""
    const url = `http://${host.readinessHost ?? host.host ?? "127.0.0.1"}:${host.port}/session${query}`
    const headers = { Accept: "application/json" }
    const authorization = internalAuthorization(host)
    if (authorization) headers.Authorization = authorization
    let response
    try { response = await fetchImpl(url, { method: "GET", headers }) }
    catch { throw runtimeError("agent_unavailable", `Cannot list ${targetAgentID} Sessions for cross-machine recovery`) }
    if (!response.ok) {
      let detail = ""
      try { detail = await response.text() } catch {}
      throw runtimeError("agent_unavailable", detail || `Listing ${targetAgentID} Sessions returned HTTP ${response.status}`)
    }
    let payload
    try { payload = await response.json() }
    catch { throw runtimeError("agent_unavailable", `Listing ${targetAgentID} Sessions returned an unreadable response`) }
    const sessions = Array.isArray(payload) ? payload : Array.isArray(payload?.sessions) ? payload.sessions : []
    return sessions
      .map((session) => ({ id: session?.id || session?.sessionId, directory: session?.directory || session?.cwd || directory }))
      .filter((session) => session.id && (!directory || session.directory === directory))
  }

  const resultForTarget = async (source, targetAgentID, directory, targetSessionID) => {
    const target = { machineID, agentID: targetAgentID, sessionID: targetSessionID, directory }
    let link
    try { link = await sessionLinkStore?.addHandoff({ source, target }) }
    catch {
      // The target identity is authoritative once session/new returned. Link persistence is optional
      // enrichment and can be retried independently without creating another Session.
    }
    return { target, ...(link ? { link } : {}) }
  }

  const recoverySnapshot = async (input) => ({
    kind: "cross-machine-target-create-v1",
    targetAgentID: input.targetAgentID,
    projectId: input.project.id,
    directory: input.project.path,
    beforeSessionIDs: (await listSessions(input.targetAgentID, input.project.path)).map((session) => session.id)
  })

  const reconcileTargetSession = async (input, recovery) => {
    if (
      !recovery
      || recovery.kind !== "cross-machine-target-create-v1"
      || recovery.targetAgentID !== input.targetAgentID
      || recovery.projectId !== input.project.id
      || recovery.directory !== input.project.path
      || !Array.isArray(recovery.beforeSessionIDs)
    ) return undefined
    const before = new Set(recovery.beforeSessionIDs.filter((value) => typeof value === "string" && value))
    const current = await listSessions(input.targetAgentID, input.project.path)
    const candidates = current.filter((session) => !before.has(session.id))
    if (candidates.length !== 1) return undefined
    return resultForTarget(input.source, input.targetAgentID, input.project.path, candidates[0].id)
  }

  const createTargetSession = async (input, { checkpoint } = {}) => {
    if (!validSource(input.source)) throw runtimeError("invalid_request", "Source Session identity is incomplete")
    if (input.source.machineID === machineID) {
      throw runtimeError("invalid_request", "Cross-machine target creation requires a source Session on another machine")
    }
    if (!input.project || input.project.machineId !== machineID || typeof input.project.path !== "string" || !input.project.path) {
      throw runtimeError("invalid_request", "Target Project must belong to this machine")
    }
    const targetAgentID = input.targetAgentID
    const directory = input.project.path
    const targetEntry = daemon.hostEntry(targetAgentID)
    if (!targetEntry) throw runtimeError("unknown_agent", `Unknown target agent: ${targetAgentID}`)
    if (targetEntry.host?.capabilities?.sessions === false || daemon.registry.host(targetAgentID)?.capabilities?.sessions === false) {
      throw runtimeError("unsupported_agent", `Agent ${targetAgentID} does not support native Sessions`)
    }

    const requestedModel = input.model ? { ...input.model, ...(input.variant ? { variant: input.variant } : {}) } : null
    if (requestedModel) await daemon.resolveModel(targetAgentID, requestedModel, { directory })

    // Recovery must be possible before creating a resource. If listing fails, fail closed before
    // session/new instead of creating a target that a lost response could make impossible to find.
    const recovery = await recoverySnapshot(input)
    let targetSession

    if (targetEntry.kind === "acp") {
      const service = acpService(targetAgentID)
      if (!service || typeof service.createSession !== "function") {
        throw runtimeError("unsupported_agent", `Agent ${targetAgentID} cannot create native Sessions`)
      }
      try { targetSession = await service.createSession({ directory }) }
      catch (error) {
        if (error && typeof error === "object") {
          error.ambiguous = true
          error.recovery = recovery
        }
        throw error
      }
    } else {
      const host = targetEntry.host
      try { await host.start?.() }
      catch (error) {
        throw runtimeError("agent_unavailable", error instanceof Error ? error.message : `Agent ${targetAgentID} is unavailable`)
      }
      const url = `http://${host.readinessHost ?? host.host ?? "127.0.0.1"}:${host.port}/session?directory=${encodeURIComponent(directory)}`
      const headers = { Accept: "application/json", "Content-Type": "application/json" }
      const authorization = internalAuthorization(host)
      if (authorization) headers.Authorization = authorization
      let response
      try { response = await fetchImpl(url, { method: "POST", headers, body: "{}" }) }
      catch {
        throw runtimeError("handoff_uncertain", `Creating ${targetAgentID} Session is uncertain`, { ambiguous: true, recovery })
      }
      if (!response.ok) {
        let detail = ""
        try { detail = await response.text() } catch {}
        const message = detail || `Creating ${targetAgentID} Session returned HTTP ${response.status}`
        if (response.status >= 500) throw runtimeError("handoff_uncertain", message, { ambiguous: true, recovery })
        throw runtimeError("handoff_rejected", message)
      }
      try { targetSession = await response.json() }
      catch {
        throw runtimeError("handoff_uncertain", `Creating ${targetAgentID} Session returned an unreadable response`, { ambiguous: true, recovery })
      }
    }

    if (!targetSession?.id) {
      throw runtimeError("handoff_uncertain", `Agent ${targetAgentID} did not return a native Session id`, { ambiguous: true, recovery })
    }

    let result = { target: { machineID, agentID: targetAgentID, sessionID: targetSession.id, directory } }
    if (typeof checkpoint === "function") {
      try { await checkpoint(result) }
      catch (error) {
        if (error && typeof error === "object") {
          error.ambiguous = true
          error.recovery = recovery
        }
        throw error
      }
    }

    if (input.title && targetEntry.kind === "acp") {
      const service = acpService(targetAgentID)
      try { await service?.renameSession?.(targetSession.id, input.title) } catch {}
    }

    result = await resultForTarget(input.source, targetAgentID, directory, targetSession.id)
    if (typeof checkpoint === "function") await checkpoint(result)
    return result
  }

  return { createTargetSession, reconcileTargetSession }
}
