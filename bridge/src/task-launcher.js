import { taskLaunchError } from "./task-errors.js"
import { promptModelBody } from "./task-model.js"

const MAX_OUTCOME_CHARS = 6_000
const ACP_LATE_COMPLETION_QUIET_MS = 12_000
const ACP_LATE_COMPLETION_MAX_MS = 10 * 60_000

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
    if (part?.type !== "reasoning" && part?.type !== "tool") continue
    if (foundText) break
    return ""
  }
  return chunks.reverse().join("\n").trim()
}

function latestAssistantOutcome(messages) {
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index]
    // A Task run owns one user turn. Never fall through to an assistant answer from a previous turn
    // when the latest turn ended in tool/reasoning activity without a natural-language result.
    if (message?.info?.role === "user") break
    if (message?.info?.role !== "assistant") continue
    const text = boundOutcome(terminalMessageText(message))
    if (text) return text
  }
  return undefined
}

function outcomeFromResult(result) {
  if (!result || typeof result !== "object") return undefined
  const direct = boundOutcome(result.outcome || result.text || result.content)
  if (direct) return direct
  if (Array.isArray(result.parts)) return boundOutcome(terminalMessageText(result))
  if (result.message && typeof result.message === "object") return outcomeFromResult(result.message)
  return undefined
}

export function isAcpPromptTimeout(error) {
  return /^ACP adapter request timed out: session\/prompt\b/.test(error?.message ?? "")
}

/**
 * ACP is a streaming protocol carried over a request/response pipe. A slow agent can outlive the
 * request timeout while continuing to emit valid assistant chunks. Treating that transport timeout
 * as the agent's final result made a Task permanently failed even though its native Session kept
 * working and eventually produced a good answer.
 *
 * After the timeout, only late Session activity can recover the Run. We wait until assistant updates
 * have been quiet for a short window, then read the native transcript and accept its terminal answer.
 * No late activity means the original timeout still wins after the bounded recovery window.
 */
export function recoverLateAcpOutcome(service, sessionID, {
  timeoutError = new Error("ACP prompt timed out"),
  quietMs = ACP_LATE_COMPLETION_QUIET_MS,
  maxMs = ACP_LATE_COMPLETION_MAX_MS
} = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    let sawLateActivity = false
    let quietTimer
    let maxTimer
    const unsubscribe = typeof service?.subscribe === "function"
      ? service.subscribe((event) => {
          if (event?.sessionId !== sessionID || settled) return
          if (event.type === "message.updated" || event.type === "todo.updated") {
            sawLateActivity = true
            clearTimeout(quietTimer)
            quietTimer = setTimeout(() => { void inspect() }, quietMs)
            return
          }
          if (event.type === "session.error" && !isAcpPromptTimeout({ message: event.message })) {
            finish(new Error(event.message ?? "Harness prompt failed"))
          }
        })
      : () => {}

    const cleanup = () => {
      clearTimeout(quietTimer)
      clearTimeout(maxTimer)
      unsubscribe()
    }
    const finish = (error, outcome) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(outcome)
    }
    const inspect = async () => {
      if (settled || !sawLateActivity) return
      try {
        const outcome = latestAssistantOutcome(await service.messages(sessionID))
        if (outcome) finish(null, outcome)
      } catch {}
    }

    maxTimer = setTimeout(() => finish(timeoutError), maxMs)
  })
}

export class TaskLauncher {
  constructor({ daemon, fetchImpl = fetch, acpService } = {}) {
    this.daemon = daemon
    this.fetchImpl = fetchImpl
    this.acpService = acpService
  }

  async #entry(agentID) {
    const entry = this.daemon.hostEntry(agentID)
    if (!entry) throw taskLaunchError("unknown_agent", `Unknown agent: ${agentID}`)
    if (this.daemon.registry.host(agentID)?.state === "unavailable") {
      throw taskLaunchError("agent_unavailable", `Agent ${agentID} is unavailable`)
    }
    return entry
  }

  async validateModelSelection(agentID, model) {
    if (!model) return
    await this.#entry(agentID)
    if (typeof this.daemon.validateModel !== "function") return
    await this.daemon.validateModel(agentID, model)
  }

  async createSession(task) {
    const agentID = runAgentID(task)
    const model = runModel(task)
    const entry = await this.#entry(agentID)
    if (!task.workspace?.path) throw taskLaunchError("workspace_required", "Task workspace is not prepared")
    const title = taskSessionTitle(task)

    if (entry.kind === "acp") {
      const service = this.acpService?.(agentID)
      if (service) {
        const session = await service.createSession({ directory: task.workspace.path, title, model: acpModelWireName(model) })
        if (!session?.id) throw new Error(`Agent ${agentID} did not return a session id`)
        return { sessionId: session.id, transport: "acp", directory: task.workspace.path }
      }
      await entry.host.start()
      const result = await entry.host.request("session/new", { cwd: task.workspace.path, mcpServers: [] })
      if (!result?.sessionId) throw new Error(`Agent ${agentID} did not return a session id`)
      const value = acpModelValue(result.configOptions, model)
      if (value) await entry.host.request("session/set_config_option", { sessionId: result.sessionId, configId: "model", value })
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
    if (!task.workspace?.path) throw taskLaunchError("workspace_required", "Task workspace is not prepared")
    const modelChanged = !sameModel(previousRun.model ?? null, model)

    if (entry.kind === "acp") {
      const service = this.acpService?.(agentID)
      if (service) {
        const adopted = await service.adoptTaskSession(previousRun.sessionId, { title: taskSessionTitle(task) })
        if (adopted === false) throw taskLaunchError("session_unavailable", "The previous native Session can no longer be resumed")
        if (modelChanged && model) await service.setModel(previousRun.sessionId, acpModelWireName(model))
        return { sessionId: previousRun.sessionId, transport: "acp", directory: task.workspace.path }
      }
      await entry.host.start()
      if (modelChanged && model) {
        await entry.host.request("session/set_config_option", { sessionId: previousRun.sessionId, configId: "model", value: acpModelWireName(model) })
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
        }).catch(async (error) => {
          if (!isAcpPromptTimeout(error)) {
            onFailed?.(error)
            return
          }
          try {
            const outcome = await recoverLateAcpOutcome(service, run.sessionId, { timeoutError: error })
            onCompleted?.({ outcome })
          } catch (recoveryError) {
            onFailed?.(recoveryError)
          }
        })
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
        .then((result) => onCompleted?.({ outcome: outcomeFromResult(result) }))
        .catch((error) => onFailed?.(error))
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
