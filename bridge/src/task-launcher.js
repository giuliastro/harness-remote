import { taskLaunchError } from "./task-errors.js"
import { promptModelBody } from "./task-model.js"

const MAX_OUTCOME_CHARS = 6_000
const DEFAULT_HTTP_RECOVERY_POLL_MS = 750
const DEFAULT_HTTP_RECOVERY_GRACE_MS = 6_000
const DEFAULT_HTTP_RECOVERY_TIMEOUT_MS = 30 * 60_000

function basicAuthorization(username, password) {
  if (!username && !password) return undefined
  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`
}

function httpHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

async function responseJSON(response, label) {
  if (!response.ok) {
    let detail = ""
    try {
      const body = await response.json()
      detail = typeof body?.error === "string" ? `: ${body.error}` : ""
    } catch {}
    throw new Error(`${label} failed with HTTP ${response.status}${detail}`)
  }
  return response.json()
}

function openCodeStatus(value) {
  const type = typeof value === "string" ? value : value?.type
  if (type === "idle") return "completed"
  if (type === "busy" || type === "retry") return "running"
  return "unknown"
}

function canonicalText(value) {
  return typeof value === "string" ? value.replace(/\r\n/g, "\n").trim() : ""
}

function messageText(message) {
  return (Array.isArray(message?.parts) ? message.parts : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function latestUserMatches(messages, prompt) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.info?.role !== "user") continue
    return canonicalText(messageText(message)) === canonicalText(prompt)
  }
  return false
}

function readableError(value, depth = 0) {
  if (depth > 4 || value == null) return ""
  if (typeof value === "string") {
    const text = value.trim()
    if (!text) return ""
    if ((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]"))) {
      try { return readableError(JSON.parse(text), depth + 1) || text } catch { return text }
    }
    return text
  }
  if (typeof value !== "object") return ""
  for (const key of ["message", "error", "detail", "data"]) {
    const text = readableError(value[key], depth + 1)
    if (text) return text
  }
  return ""
}

function latestAssistantFailure(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.info?.role === "user") break
    if (message?.info?.role !== "assistant") continue
    return readableError(message.info.error)
  }
  return ""
}

function recoverableHttpTransportError(error) {
  if (error instanceof TypeError) return true
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /fetch failed|network|socket|econnreset|econnrefused|terminated|other side closed/i.test(message)
}

function acpModelValue(configOptions, model) {
  if (!model) return undefined
  const option = configOptions?.find((item) => item.id === "model")
  const qualified = `${model.providerID}/${model.modelID}`
  if (option?.options?.some((candidate) => candidate.value === qualified)) return qualified
  return option?.options?.find((candidate) => candidate.value === model.modelID)?.value
}

function acpModelWireName(model) {
  return model ? `${model.providerID}/${model.modelID}` : undefined
}

function sameModel(left, right) {
  if (!left && !right) return true
  if (!left || !right) return false
  return left.providerID === right.providerID && left.modelID === right.modelID && (left.variant || "") === (right.variant || "")
}

function missingNativeSession(error) {
  if (error?.code === "session_unavailable") return true
  const message = error instanceof Error ? error.message : String(error ?? "")
  return /\bsession\b.{0,180}\b(not found|unknown|unavailable|does not exist|no longer exists)\b/i.test(message)
}

function sessionUnavailableError(error) {
  return taskLaunchError("session_unavailable", "The previous native Session can no longer be resumed", { cause: error })
}

function runAgentID(task, run = task?.run) {
  return run?.agentId || task?.agentId
}

function runModel(task, run = task?.run) {
  return run?.model ?? task?.model ?? null
}

function taskSessionTitle(task) {
  const base = `Task ${task.id.slice(0, 8)}`
  return Number(task.run?.sequence) > 1 ? `${base} · Run ${task.run.sequence}` : base
}

function boundOutcome(value) {
  const text = typeof value === "string" ? value.trim() : ""
  if (!text) return undefined
  return text.length <= MAX_OUTCOME_CHARS ? text : `…${text.slice(-(MAX_OUTCOME_CHARS - 1))}`
}

function terminalMessageText(message) {
  const parts = Array.isArray(message?.parts) ? message.parts : []
  const chunks = []
  let foundText = false
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index]
    if (part?.type === "text") {
      const text = typeof part.text === "string" ? part.text.trim() : ""
      if (!text) continue
      chunks.push(part.text)
      foundText = true
      continue
    }
    if (["step-start", "step-finish", "snapshot", "patch"].includes(part?.type)) continue
    if (part?.type !== "reasoning" && part?.type !== "tool") continue
    if (foundText) break
    return ""
  }
  return chunks.reverse().join("\n").trim()
}

function latestAssistantOutcome(messages) {
  const assistantMessages = []
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.info?.role === "user") break
    if (message?.info?.role === "assistant") assistantMessages.push(message)
  }
  if (!assistantMessages.length) return undefined
  const parts = assistantMessages.reverse().flatMap((message) => Array.isArray(message.parts) ? message.parts : [])
  return boundOutcome(terminalMessageText({ parts }))
}

function outcomeFromResult(result) {
  if (!result || typeof result !== "object") return undefined
  const direct = boundOutcome(result.outcome || result.text || result.content)
  if (direct) return direct
  if (Array.isArray(result.parts)) return boundOutcome(terminalMessageText(result))
  if (result.message && typeof result.message === "object") return outcomeFromResult(result.message)
  return undefined
}

export class TaskLauncher {
  constructor({
    daemon,
    fetchImpl = fetch,
    acpService,
    httpRecoveryPollMs = DEFAULT_HTTP_RECOVERY_POLL_MS,
    httpRecoveryGraceMs = DEFAULT_HTTP_RECOVERY_GRACE_MS,
    httpRecoveryTimeoutMs = DEFAULT_HTTP_RECOVERY_TIMEOUT_MS,
    sleepImpl = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  } = {}) {
    this.daemon = daemon
    this.fetchImpl = fetchImpl
    this.acpService = acpService
    this.httpRecoveryPollMs = httpRecoveryPollMs
    this.httpRecoveryGraceMs = httpRecoveryGraceMs
    this.httpRecoveryTimeoutMs = httpRecoveryTimeoutMs
    this.sleepImpl = sleepImpl
  }

  async #entry(agentID) {
    const entry = this.daemon.hostEntry(agentID)
    if (!entry) throw taskLaunchError("unknown_agent", `Unknown agent: ${agentID}`)
    if (this.daemon.registry.host(agentID)?.state === "unavailable") {
      throw taskLaunchError("agent_unavailable", `Agent ${agentID} is unavailable`)
    }
    return entry
  }

  async #resolvedModel(agentID, model) {
    if (!model || typeof this.daemon.resolveModel !== "function") return model
    return this.daemon.resolveModel(agentID, model)
  }

  async #applyAcpVariant(entry, sessionID, resolvedModel) {
    if (!resolvedModel?.variant || !resolvedModel?.variantConfigId) return
    await entry.host.request("session/set_config_option", {
      sessionId: sessionID,
      configId: resolvedModel.variantConfigId,
      value: resolvedModel.variant
    })
  }

  async validateModelSelection(agentID, model) {
    if (!model) return
    await this.#entry(agentID)
    if (typeof this.daemon.validateModel !== "function") return
    await this.daemon.validateModel(agentID, model)
  }

  async #httpSessionMessages(task, run, agentID) {
    const response = await this.fetchImpl(
      `${run.base}/session/${encodeURIComponent(run.sessionId)}/message?limit=40&directory=${encodeURIComponent(task.workspace.path)}`,
      { headers: run.authorization ? { Authorization: run.authorization } : {} }
    )
    return responseJSON(response, `Reading ${agentID} session after transport recovery`)
  }

  async #httpSessionStatus(task, run, agentID) {
    const response = await this.fetchImpl(
      `${run.base}/session/status?directory=${encodeURIComponent(task.workspace.path)}`,
      { headers: run.authorization ? { Authorization: run.authorization } : {} }
    )
    const statuses = await responseJSON(response, `Reading ${agentID} status after transport recovery`)
    return openCodeStatus(statuses?.[run.sessionId])
  }

  async #recoverHttpPrompt(task, run, agentID, originalError) {
    const started = Date.now()
    let accepted = false
    let sawRunning = false
    let lastEvidenceError = null

    while (Date.now() - started < this.httpRecoveryTimeoutMs) {
      let status = "unknown"
      try {
        status = await this.#httpSessionStatus(task, run, agentID)
        sawRunning ||= status === "running"
      } catch (error) {
        lastEvidenceError = error
      }

      try {
        const messages = await this.#httpSessionMessages(task, run, agentID)
        accepted ||= latestUserMatches(messages, task.prompt)
        if (accepted) {
          const outcome = latestAssistantOutcome(messages)
          if (outcome) return { outcome }
          const failure = latestAssistantFailure(messages)
          if (failure && status !== "running") throw new Error(failure)
          if (status === "completed") {
            throw new Error(`${agentID} stopped before producing a final response`)
          }
        }
      } catch (error) {
        if (accepted && !recoverableHttpTransportError(error)) throw error
        lastEvidenceError = error
      }

      if (!accepted && !sawRunning && Date.now() - started >= this.httpRecoveryGraceMs) throw originalError
      await this.sleepImpl(this.httpRecoveryPollMs)
    }

    if (accepted || sawRunning) {
      throw new Error(`${agentID} did not reach a confirmed final response before the recovery timeout`)
    }
    throw lastEvidenceError ?? originalError
  }

  async createSession(task) {
    const agentID = runAgentID(task)
    const model = runModel(task)
    const entry = await this.#entry(agentID)
    const resolvedModel = entry.kind === "acp" ? await this.#resolvedModel(agentID, model) : model
    if (!task.workspace?.path) throw taskLaunchError("workspace_required", "Task workspace is not prepared")
    const title = taskSessionTitle(task)

    if (entry.kind === "acp") {
      const service = this.acpService?.(agentID)
      if (service) {
        const session = await service.createSession({ directory: task.workspace.path, title, model: acpModelWireName(model) })
        if (!session?.id) throw new Error(`Agent ${agentID} did not return a session id`)
        await this.#applyAcpVariant(entry, session.id, resolvedModel)
        return { sessionId: session.id, transport: "acp", directory: task.workspace.path }
      }
      await entry.host.start()
      const result = await entry.host.request("session/new", { cwd: task.workspace.path, mcpServers: [] })
      if (!result?.sessionId) throw new Error(`Agent ${agentID} did not return a session id`)
      const value = acpModelValue(result.configOptions, model)
      if (value) await entry.host.request("session/set_config_option", { sessionId: result.sessionId, configId: "model", value })
      await this.#applyAcpVariant(entry, result.sessionId, resolvedModel)
      return { sessionId: result.sessionId, transport: "acp", directory: task.workspace.path }
    }

    if (entry.kind === "http") {
      await entry.host.start?.()
      const host = entry.host.readinessHost ?? entry.host.host ?? "127.0.0.1"
      const base = `http://${httpHost(host)}:${entry.host.port}`
      const authorization = basicAuthorization(entry.host.username, entry.host.password)
      const response = await this.fetchImpl(`${base}/session?directory=${encodeURIComponent(task.workspace.path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
        body: JSON.stringify({ title })
      })
      const session = await responseJSON(response, `Creating ${agentID} session`)
      if (!session?.id) throw new Error(`Agent ${agentID} did not return a session id`)
      return { sessionId: session.id, transport: "http", directory: task.workspace.path, base, authorization }
    }

    throw taskLaunchError("unsupported_agent", `Agent ${agentID} cannot launch tasks`)
  }

  async resumeSession(task, previousRun) {
    const agentID = runAgentID(task)
    const model = runModel(task)
    if (!previousRun?.sessionId) throw taskLaunchError("session_unavailable", "The previous Task session is unavailable")
    if (previousRun.agentId && previousRun.agentId !== agentID) throw taskLaunchError("session_unavailable", "A native Session can only be resumed by the harness that owns it")
    const entry = await this.#entry(agentID)
    const resolvedModel = entry.kind === "acp" ? await this.#resolvedModel(agentID, model) : model
    if (!task.workspace?.path) throw taskLaunchError("workspace_required", "Task workspace is not prepared")
    const modelChanged = !sameModel(previousRun.model ?? null, model)

    if (entry.kind === "acp") {
      const service = this.acpService?.(agentID)
      if (service) {
        const adopted = await service.adoptTaskSession(previousRun.sessionId, { title: taskSessionTitle(task) })
        if (adopted === false) throw taskLaunchError("session_unavailable", "The previous native Session can no longer be resumed")
        try {
          await service.models(previousRun.sessionId)
        } catch (error) {
          if (missingNativeSession(error)) throw sessionUnavailableError(error)
          throw error
        }
        if (modelChanged && model) {
          await service.setModel(previousRun.sessionId, acpModelWireName(model))
          await this.#applyAcpVariant(entry, previousRun.sessionId, resolvedModel)
        }
        return { sessionId: previousRun.sessionId, transport: "acp", directory: task.workspace.path }
      }
      await entry.host.start()
      let configOptions
      try {
        const loaded = await entry.host.request("session/load", {
          sessionId: previousRun.sessionId,
          cwd: task.workspace.path,
          mcpServers: []
        }, 300_000)
        configOptions = loaded?.configOptions
      } catch (error) {
        if (missingNativeSession(error)) throw sessionUnavailableError(error)
        throw error
      }
      if (modelChanged && model) {
        const value = acpModelValue(configOptions, model) || acpModelWireName(model)
        await entry.host.request("session/set_config_option", { sessionId: previousRun.sessionId, configId: "model", value })
        await this.#applyAcpVariant(entry, previousRun.sessionId, resolvedModel)
      }
      return { sessionId: previousRun.sessionId, transport: "acp", directory: task.workspace.path }
    }

    if (entry.kind === "http") {
      await entry.host.start?.()
      const host = entry.host.readinessHost ?? entry.host.host ?? "127.0.0.1"
      const base = `http://${httpHost(host)}:${entry.host.port}`
      const authorization = basicAuthorization(entry.host.username, entry.host.password)
      return { sessionId: previousRun.sessionId, transport: "http", directory: task.workspace.path, base, authorization }
    }

    throw taskLaunchError("unsupported_agent", `Agent ${agentID} cannot resume tasks`)
  }

  async startPrompt(task, run, { onFailed, onCompleted } = {}) {
    const agentID = runAgentID(task, run)
    const model = runModel(task, run)
    const entry = await this.#entry(agentID)

    if (entry.kind === "acp") {
      const service = this.acpService?.(agentID)
      if (service) {
        void service.promptAndWait(run.sessionId, task.prompt).then(async () => {
          let outcome
          try { outcome = latestAssistantOutcome(await service.messages(run.sessionId)) } catch {}
          onCompleted?.({ outcome })
        }).catch((error) => onFailed?.(error))
        return
      }
      void entry.host.request("session/prompt", {
        sessionId: run.sessionId,
        prompt: [{ type: "text", text: task.prompt }]
      }, 300_000).then((result) => onCompleted?.({ outcome: outcomeFromResult(result) })).catch((error) => onFailed?.(error))
      return
    }

    if (entry.kind === "http") {
      void this.fetchImpl(`${run.base}/session/${encodeURIComponent(run.sessionId)}/message?directory=${encodeURIComponent(task.workspace.path)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(run.authorization ? { Authorization: run.authorization } : {}) },
        body: JSON.stringify({ parts: [{ type: "text", text: task.prompt }], model: promptModelBody(model), variant: model?.variant || undefined })
      }).then((response) => responseJSON(response, `Starting ${agentID} task`))
        .then((result) => {
          const failure = readableError(result?.info?.error)
          if (failure) throw new Error(failure)
          const outcome = outcomeFromResult(result)
          if (!outcome) throw new Error(`${agentID} stopped before producing a final response`)
          onCompleted?.({ outcome })
        })
        .catch(async (error) => {
          if (!recoverableHttpTransportError(error)) {
            onFailed?.(error)
            return
          }
          try {
            onCompleted?.(await this.#recoverHttpPrompt(task, run, agentID, error))
          } catch (recoveryError) {
            onFailed?.(recoveryError)
          }
        })
    }
  }

  async inspectRun(task) {
    const run = task?.run
    if (!run?.sessionId) return "unknown"
    const agentID = runAgentID(task, run)
    const entry = this.daemon.hostEntry(agentID)
    if (!entry || entry.kind !== "http") return "unknown"

    try {
      await entry.host.start?.()
      const host = entry.host.readinessHost ?? entry.host.host ?? "127.0.0.1"
      const base = `http://${httpHost(host)}:${entry.host.port}`
      const authorization = basicAuthorization(entry.host.username, entry.host.password)
      const response = await this.fetchImpl(`${base}/session/status?directory=${encodeURIComponent(task.workspace?.path ?? run.directory ?? "")}`, {
        headers: authorization ? { Authorization: authorization } : {}
      })
      if (!response.ok) return "unknown"
      const statuses = await response.json()
      return openCodeStatus(statuses?.[run.sessionId])
    } catch {
      return "unknown"
    }
  }
}
