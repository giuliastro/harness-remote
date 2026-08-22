import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

// HTTP providers are already running and should fail quickly. ACP adapters may need their first
// `npx` launch, authentication, and a technical session before they can expose config options.
export const MODEL_CATALOG_TIMEOUT_MS = 8_000
export const ACP_MODEL_CATALOG_TIMEOUT_MS = 90_000

function withTimeout(promise, timeoutMs, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function splitModelValue(value, fallbackProviderID) {
  const separator = value.indexOf("/")
  return separator > 0
    ? { providerID: value.slice(0, separator), modelID: value.slice(separator + 1) }
    : { providerID: fallbackProviderID, modelID: value }
}

function finiteNumber(value) {
  return Number.isFinite(value) ? Number(value) : undefined
}

function variantNames(model) {
  if (Array.isArray(model?.variants)) {
    return model.variants.flatMap((variant) => typeof variant === "string"
      ? variant ? [variant] : []
      : variant && typeof variant.id === "string" && variant.id ? [variant.id] : [])
  }
  if (model?.variants && typeof model.variants === "object") return Object.keys(model.variants)
  return []
}

function pricingMetadata(model) {
  const rawCosts = Array.isArray(model?.cost) ? model.cost : model?.cost && typeof model.cost === "object" ? [model.cost] : []
  const first = rawCosts.find((cost) => cost && typeof cost === "object")
  const inputCost = finiteNumber(first?.input)
  const outputCost = finiteNumber(first?.output)
  const explicitFree = model?.free === true || model?.isFree === true
  const hasKnownTokenCost = inputCost !== undefined || outputCost !== undefined
  const allAdvertisedTokenCostsZero = rawCosts.length > 0 && rawCosts.every((cost) => {
    if (!cost || typeof cost !== "object") return false
    const input = finiteNumber(cost.input)
    const output = finiteNumber(cost.output)
    return input !== undefined && output !== undefined && input === 0 && output === 0
  })
  const anyPositiveTokenCost = rawCosts.some((cost) => Number(cost?.input) > 0 || Number(cost?.output) > 0)
  return {
    ...(inputCost !== undefined ? { inputCost } : {}),
    ...(outputCost !== undefined ? { outputCost } : {}),
    ...(explicitFree || allAdvertisedTokenCostsZero ? { isFree: true } : anyPositiveTokenCost || hasKnownTokenCost ? { isFree: false } : {})
  }
}

function dedupeModels(models) {
  const seen = new Set()
  return models.filter((model) => {
    const key = `${model.providerID}|${model.modelID}|${model.variant || ""}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function modelsFromConfigOptions(configOptions, fallbackProviderID) {
  const option = configOptions?.find((item) => item?.id === "model")
  if (!option || !Array.isArray(option.options)) return []
  return dedupeModels(option.options.flatMap((candidate) => {
    if (typeof candidate?.value !== "string" || !candidate.value || candidate.disabled === true) return []
    const { providerID, modelID } = splitModelValue(candidate.value, fallbackProviderID)
    if (!providerID || !modelID) return []
    return [{
      providerID,
      providerName: candidate.providerName || providerID,
      modelID,
      modelName: candidate.name ?? modelID,
      description: candidate.description || undefined,
      status: typeof candidate.status === "string" ? candidate.status : undefined,
      isFree: typeof candidate.free === "boolean" ? candidate.free : typeof candidate.isFree === "boolean" ? candidate.isFree : undefined,
      isDefault: candidate.value === option.currentValue
    }]
  }))
}

export function modelsFromProvidersResponse(payload) {
  const providers = Array.isArray(payload?.providers) ? payload.providers : []
  const models = providers.flatMap((provider) => {
    if (!provider || typeof provider.id !== "string" || !provider.models || typeof provider.models !== "object") return []
    const defaultModel = payload?.default?.[provider.id]
    return Object.entries(provider.models).flatMap(([key, model]) => {
      if (!model || typeof model !== "object" || model.enabled === false) return []
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
        isDefault: defaultModel === key || defaultModel === modelID,
        ...pricingMetadata(model)
      }
      const variants = variantNames(model)
      return [base, ...variants.map((variant) => ({ ...base, variant, isDefault: false }))]
    })
  })
  return dedupeModels(models)
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

class CachedCatalog {
  cache = []
  refreshedAt = null

  result(models, stale = false, error) {
    return { models, stale, refreshedAt: this.refreshedAt, ...(error ? { error } : {}) }
  }

  remember(models) {
    this.cache = models
    this.refreshedAt = new Date().toISOString()
    return this.result(models, false)
  }

  clear() {
    this.cache = []
    this.refreshedAt = null
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

export class AcpAgentModelCatalog extends CachedCatalog {
  constructor({ agent, agentID, directory, stateDirectory, timeoutMs = ACP_MODEL_CATALOG_TIMEOUT_MS }) {
    super()
    this.agent = agent
    this.agentID = agentID
    this.directory = directory
    this.timeoutMs = timeoutMs
    this.stateFile = path.join(stateDirectory, `model-catalog-${agentID}.json`)
    this.sessionID = undefined
    this.stateLoaded = false
    this.hiddenSessionIDs = new Set()
    this.onAgentExit = () => this.clear()
    this.agent.on?.("exit", this.onAgentExit)
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

  async preloadState() {
    await this.#loadState()
    return this.hiddenSessionIDs
  }

  async #saveState() {
    await mkdir(path.dirname(this.stateFile), { recursive: true })
    await writeFile(this.stateFile, JSON.stringify({ version: 1, sessionID: this.sessionID, directory: this.directory }), { mode: 0o600 })
  }

  async #newCatalogSession() {
    const created = await this.agent.request("session/new", { cwd: this.directory, mcpServers: [] }, this.timeoutMs)
    if (!created?.sessionId) throw new Error(`Agent ${this.agentID} did not return a catalog session id`)
    this.sessionID = created.sessionId
    this.hiddenSessionIDs.add(created.sessionId)
    await this.#saveState()
    return created.configOptions
  }

  async #refreshOptions() {
    await this.agent.start()
    await this.#loadState()
    if (this.sessionID) {
      try {
        const loaded = await this.agent.request("session/load", { sessionId: this.sessionID, cwd: this.directory, mcpServers: [] }, this.timeoutMs)
        return loaded?.configOptions
      } catch {
        this.hiddenSessionIDs.delete(this.sessionID)
        this.sessionID = undefined
      }
    }
    return this.#newCatalogSession()
  }

  async list({ allowStale = true, refresh = false } = {}) {
    // ACP adapters commonly attach live listeners when a session is loaded. Re-loading the same
    // prompt-less catalog session every time a model picker opens can therefore accumulate adapter
    // listeners even though the advertised model set has not changed. Keep one in-memory catalog
    // for the lifetime of this dedicated adapter process. Its `exit` event invalidates the cache,
    // so a restarted adapter still performs one real load before serving models again.
    if (!refresh && this.cache.length) return this.result(this.cache, false)
    try {
      const options = await withTimeout(this.#refreshOptions(), this.timeoutMs, `${this.agentID} model catalog`)
      const models = modelsFromConfigOptions(options, this.agentID)
      if (!models.length) throw new Error(`Agent ${this.agentID} did not advertise any models`)
      return this.remember(models)
    } catch (error) {
      if (allowStale) return this.stale(error)
      throw error
    }
  }

  async validate(model) { return this.validateResult(await this.list({ allowStale: false }), model) }
  close() {
    this.agent.off?.("exit", this.onAgentExit)
    this.agent.close?.()
  }
}

export class HttpAgentModelCatalog extends CachedCatalog {
  constructor({ host, agentID, fetchImpl = fetch, timeoutMs = MODEL_CATALOG_TIMEOUT_MS }) {
    super()
    this.host = host
    this.agentID = agentID
    this.fetchImpl = fetchImpl
    this.timeoutMs = timeoutMs
    this.hiddenSessionIDs = new Set()
  }

  async #refresh() {
    await this.host.start?.()
    const host = this.host.readinessHost ?? this.host.host ?? "127.0.0.1"
    const base = `http://${httpHost(host)}:${this.host.port}`
    const auth = authorization(this.host.username, this.host.password)
    const response = await this.fetchImpl(`${base}/config/providers`, {
      headers: { Accept: "application/json", ...(auth ? { Authorization: auth } : {}) }
    })
    if (!response.ok) throw new Error(`Refreshing ${this.agentID} models failed with HTTP ${response.status}`)
    const models = modelsFromProvidersResponse(await response.json())
    if (!models.length) throw new Error(`Agent ${this.agentID} did not advertise any models`)
    return models
  }

  async list({ allowStale = true } = {}) {
    try {
      return this.remember(await withTimeout(this.#refresh(), this.timeoutMs, `${this.agentID} model catalog`))
    } catch (error) {
      if (allowStale) return this.stale(error)
      throw error
    }
  }

  async validate(model) { return this.validateResult(await this.list({ allowStale: false }), model) }
  close() {}
}
