import { spawn } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export const MODEL_CATALOG_TIMEOUT_MS = 5_000

function splitModelValue(value, fallbackProviderID) {
  const separator = value.indexOf("/")
  return separator > 0
    ? { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
    : { providerID: fallbackProviderID, modelID: value }
}

export function modelsFromConfigOptions(configOptions, fallbackProviderID) {
  const option = configOptions?.find((item) => item?.id === "model")
  if (!option || !Array.isArray(option.options)) return []
  return option.options.flatMap((candidate) => {
    if (typeof candidate?.value !== "string" || !candidate.value) return []
    const { providerID, modelID } = splitModelValue(candidate.value, fallbackProviderID)
    if (!providerID || !modelID) return []
    return [{
      providerID,
      providerName: providerID,
      modelID,
      modelName: candidate.name ?? modelID,
      description: candidate.description || undefined,
      isDefault: candidate.value === option.currentValue
    }]
  })
}

export function modelsFromProvidersResponse(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  return providers.flatMap((provider) => {
    if (!provider || typeof provider.id !== "string" || !provider.models || typeof provider.models !== "object") return []
    const defaultModel = payload?.default?.[provider.id]
    return Object.entries(provider.models).flatMap(([key, model]) => {
      if (!model || typeof model !== "object") return []
      const modelID = typeof model.id === "string" && model.id ? model.id : key
      const base = {
        providerID: provider.id,
        providerName: typeof provider.name === "string" && provider.name ? provider.name : provider.id,
        modelID,
        modelName: typeof model.name === "string" && model.name ? model.name : modelID,
        description: typeof model.description === "string" && model.description ? model.description : undefined,
        status: typeof model.status === "string" ? model.status : undefined,
        contextLimit: Number.isFinite(model.limit?.context) ? model.limit.context : undefined,
        outputLimit: Number.isFinite(model.limit?.output) ? model.limit.output : undefined,
        tools: Boolean(model.capabilities?.toolcall || model.capabilities?.tools),
        attachments: Boolean(model.capabilities?.attachment),
        isDefault: defaultModel === key || defaultModel === modelID
      }
      const variants = model.variants && typeof model.variants === "object" ? Object.keys(model.variants) : []
      return [base, ...variants.map((variant) => ({ ...base, variant, isDefault: false }))]
    })
  })
}

export function modelsFromPiRpc(payload) {
  const models = Array.isArray(payload?.models) ? payload.models : []
  return models.flatMap((model) => {
    const providerID = typeof model?.provider === "string" ? model.provider : ""
    const modelID = typeof model?.id === "string" ? model.id : ""
    if (!providerID || !modelID) return []
    return [{
      providerID,
      providerName: providerID,
      modelID,
      modelName: typeof model.name === "string" && model.name ? model.name : modelID,
      contextLimit: Number.isFinite(model.contextWindow) ? model.contextWindow : undefined,
      outputLimit: Number.isFinite(model.maxTokens) ? model.maxTokens : undefined,
      attachments: Array.isArray(model.input) ? model.input.includes("image") : false,
      isDefault: false
    }]
  })
}

function sameModel(left, right) {
  return left.providerID === right.providerID && left.modelID === right.modelID && (left.variant ?? "") === (right.variant ?? "")
}

function authorization(username, password) {
  if (!username && !password) return undefined
  return `Basic ${Buffer.from(`${username ?? ""}:${password ?? ""}`).toString("base64")}`
}

function httpHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

function timed(promise, timeoutMs, label) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.ceil(timeoutMs / 1000)} seconds`)), timeoutMs)
    })
  ]).finally(() => clearTimeout(timer))
}

class CachedCatalog {
  cache = []
  refreshedAt = null

  result(models, stale = false, error) {
    return {
      models,
      stale,
      refreshedAt: this.refreshedAt,
      ...(error ? { error } : {})
    }
  }

  remember(models) {
    this.cache = models
    this.refreshedAt = new Date().toISOString()
    return this.result(models, false)
  }

  stale(error) {
    if (!this.cache.length) throw error
    return this.result(this.cache, true, error instanceof Error ? error.message : String(error))
  }

  validateResult(result, model) {
    if (!model) return result
    if (!result.models.some((candidate) => sameModel(candidate, model))) {
      const suffix = model.variant ? ` (${model.variant})` : ""
      const error = new Error(`Selected model is no longer available: ${model.providerID}/${model.modelID}${suffix}`)
      error.code = "model_unavailable"
      throw error
    }
    return result
  }
}

/**
 * PI already exposes a session-less native RPC command for its configured model registry. Use it
 * directly instead of manufacturing an ACP session merely to read configOptions. This keeps the
 * ordinary ACP session/model path untouched and makes zero-session New Task a first-class case.
 */
export class PiRpcModelCatalog extends CachedCatalog {
  constructor({ command = "pi", cwd = process.cwd(), spawnProcess = spawn, requestTimeoutMs = MODEL_CATALOG_TIMEOUT_MS }) {
    super()
    this.command = command
    this.cwd = cwd
    this.spawnProcess = spawnProcess
    this.requestTimeoutMs = requestTimeoutMs
    this.hiddenSessionIDs = new Set()
  }

  async #refresh() {
    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(this.command, ["--mode", "rpc", "--no-session"], {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: {
          ...process.env,
          PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK ?? "1"
        }
      })
      let buffer = ""
      let stderr = ""
      let settled = false
      const finish = (error, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (!child.killed) child.kill()
        if (error) reject(error)
        else resolve(value)
      }
      const timer = setTimeout(() => finish(new Error(`Refreshing PI models timed out after ${Math.ceil(this.requestTimeoutMs / 1000)} seconds`)), this.requestTimeoutMs)

      child.stdout.setEncoding("utf8")
      child.stderr.setEncoding("utf8")
      child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-800) })
      child.on("error", (error) => finish(error))
      child.on("exit", (code, signal) => {
        if (settled) return
        const detail = stderr.trim()
        finish(new Error(`PI model RPC exited before replying (${code ?? "unknown"}${signal ? `, ${signal}` : ""})${detail ? `: ${detail}` : ""}`))
      })
      child.stdout.on("data", (chunk) => {
        buffer += chunk
        let boundary = buffer.indexOf("\n")
        while (boundary !== -1) {
          const line = buffer.slice(0, boundary).trim()
          buffer = buffer.slice(boundary + 1)
          boundary = buffer.indexOf("\n")
          if (!line) continue
          let message
          try { message = JSON.parse(line) } catch { continue }
          if (message?.type !== "response" || message.command !== "get_available_models") continue
          if (!message.success) {
            finish(new Error(message.error ?? "PI model RPC failed"))
            return
          }
          const models = modelsFromPiRpc(message.data)
          if (!models.length) {
            finish(new Error("PI did not advertise any models"))
            return
          }
          finish(undefined, models)
          return
        }
      })
      child.stdin.write(`${JSON.stringify({ type: "get_available_models" })}\n`)
    })
  }

  async list({ allowStale = true } = {}) {
    try {
      return this.remember(await this.#refresh())
    } catch (error) {
      if (allowStale) return this.stale(error)
      throw error
    }
  }

  async validate(model) {
    return this.validateResult(await this.list({ allowStale: false }), model)
  }

  close() {}
}

export class AcpAgentModelCatalog extends CachedCatalog {
  constructor({ agent, agentID, directory, stateDirectory, requestTimeoutMs = MODEL_CATALOG_TIMEOUT_MS, ownsAgent = true }) {
    super()
    this.agent = agent
    this.agentID = agentID
    this.directory = directory
    this.stateFile = path.join(stateDirectory, `model-catalog-${agentID}.json`)
    this.sessionID = undefined
    this.stateLoaded = false
    this.hiddenSessionIDs = new Set()
    this.requestTimeoutMs = requestTimeoutMs
    this.ownsAgent = ownsAgent
  }

  async #loadState() {
    if (this.stateLoaded) return
    this.stateLoaded = true
    try {
      const state = JSON.parse(await readFile(this.stateFile, "utf8"))
      if (state?.version === 1 && typeof state.sessionID === "string" && state.sessionID) {
        this.sessionID = state.sessionID
        this.hiddenSessionIDs.add(state.sessionID)
      }
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
  }

  async #saveState() {
    await mkdir(path.dirname(this.stateFile), { recursive: true })
    await writeFile(this.stateFile, JSON.stringify({ version: 1, sessionID: this.sessionID, directory: this.directory }), { mode: 0o600 })
  }

  async #newCatalogSession() {
    const created = await this.agent.request("session/new", { cwd: this.directory, mcpServers: [] }, this.requestTimeoutMs)
    if (!created?.sessionId) throw new Error(`Agent ${this.agentID} did not return a catalog session id`)
    this.sessionID = created.sessionId
    this.hiddenSessionIDs.add(created.sessionId)
    await this.#saveState()
    return created.configOptions
  }

  async #refreshOptions() {
    await timed(this.agent.start(), this.requestTimeoutMs, `Starting ${this.agentID} model catalog`)
    await this.#loadState()
    if (this.sessionID) {
      try {
        const loaded = await this.agent.request("session/load", { sessionId: this.sessionID, cwd: this.directory, mcpServers: [] }, this.requestTimeoutMs)
        return loaded?.configOptions
      } catch {
        this.hiddenSessionIDs.delete(this.sessionID)
        this.sessionID = undefined
      }
    }
    return this.#newCatalogSession()
  }

  async list({ allowStale = true } = {}) {
    try {
      const models = modelsFromConfigOptions(await this.#refreshOptions(), this.agentID)
      if (!models.length) throw new Error(`Agent ${this.agentID} did not advertise any models`)
      return this.remember(models)
    } catch (error) {
      if (allowStale) return this.stale(error)
      throw error
    }
  }

  async validate(model) {
    return this.validateResult(await this.list({ allowStale: false }), model)
  }

  close() {
    if (this.ownsAgent) this.agent.close?.()
  }
}

export class HttpAgentModelCatalog extends CachedCatalog {
  constructor({ host, agentID, fetchImpl = fetch, requestTimeoutMs = MODEL_CATALOG_TIMEOUT_MS }) {
    super()
    this.host = host
    this.agentID = agentID
    this.fetchImpl = fetchImpl
    this.hiddenSessionIDs = new Set()
    this.requestTimeoutMs = requestTimeoutMs
  }

  async #refresh() {
    await timed(Promise.resolve(this.host.start?.()), this.requestTimeoutMs, `Starting ${this.agentID} model catalog`)
    const host = this.host.readinessHost ?? this.host.host ?? "127.0.0.1"
    const base = `http://${httpHost(host)}:${this.host.port}`
    const auth = authorization(this.host.username, this.host.password)
    const response = await timed(this.fetchImpl(`${base}/config/providers`, {
      headers: { Accept: "application/json", ...(auth ? { Authorization: auth } : {}) }
    }), this.requestTimeoutMs, `Refreshing ${this.agentID} models`)
    if (!response.ok) throw new Error(`Refreshing ${this.agentID} models failed with HTTP ${response.status}`)
    const models = modelsFromProvidersResponse(await timed(response.json(), this.requestTimeoutMs, `Reading ${this.agentID} models`))
    if (!models.length) throw new Error(`Agent ${this.agentID} did not advertise any models`)
    return models
  }

  async list({ allowStale = true } = {}) {
    try {
      return this.remember(await this.#refresh())
    } catch (error) {
      if (allowStale) return this.stale(error)
      throw error
    }
  }

  async validate(model) {
    return this.validateResult(await this.list({ allowStale: false }), model)
  }

  close() {}
}
