import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import path from "node:path"
import { CachedCatalog } from "./agent-model-catalog.js"
import { findExecutable } from "./executable-discovery.js"

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_HEADER_BYTES = 8 * 1024
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024
const STDERR_KEPT_CHARS = 600
const READ_ONLY_METHODS = new Set(["ping", "auth.getStatus", "models.list"])

function errorMessage(error) {
  const message = error?.message ?? "Copilot CLI request failed"
  const details = [error?.data?.details, error?.data?.message].find((value) => typeof value === "string" && value)
  return details && !message.includes(details) ? `${message}: ${details}` : message
}

function resolveCommand(command, environment) {
  if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) return command
  return findExecutable(command, {
    pathValue: environment.PATH ?? environment.Path ?? process.env.PATH ?? ""
  }) ?? command
}

/** A bounded, read-only JSON-RPC client for the native Copilot CLI SDK transport. */
export class CopilotSdkClient extends EventEmitter {
  #command
  #environment
  #spawn
  #timeoutMs
  #child
  #starting
  #nextID = 1
  #pending = new Map()
  #buffer = Buffer.alloc(0)
  #stderr = ""
  #closed = false

  constructor({ command = "copilot", environment = {}, spawnProcess = spawn, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super()
    this.#command = typeof command === "string" && command ? command : "copilot"
    this.#environment = environment && typeof environment === "object" ? { ...environment } : {}
    this.#spawn = spawnProcess
    this.#timeoutMs = Math.max(1, Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS)
  }

  async start(timeoutMs = this.#timeoutMs) {
    if (this.#child) return
    if (this.#closed) throw new Error("Copilot SDK client is closed")
    if (this.#starting) return this.#starting
    this.#starting = this.#start(timeoutMs)
    try {
      await this.#starting
    } finally {
      this.#starting = undefined
    }
  }

  async #start(timeoutMs) {
    const command = resolveCommand(this.#command, this.#environment)
    const args = ["--headless", "--stdio", "--no-auto-update"]
    const windowsShell = process.platform === "win32"
      && this.#spawn === spawn
      && /\.(cmd|bat)$/i.test(command)
    const executable = windowsShell ? process.env.ComSpec ?? "cmd.exe" : command
    const executableArgs = windowsShell ? ["/d", "/s", "/c", command, ...args] : args
    let child
    try {
      child = this.#spawn(executable, executableArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...this.#environment }
      })
    } catch (error) {
      throw new Error(`Could not start Copilot CLI: ${errorMessage(error)}`)
    }
    this.#child = child
    this.#buffer = Buffer.alloc(0)
    this.#stderr = ""
    child.stdout?.on("data", (chunk) => this.#consume(chunk))
    child.stderr?.on("data", (chunk) => {
      this.#stderr = `${this.#stderr}${Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)}`.slice(-STDERR_KEPT_CHARS)
    })
    child.on("error", (error) => this.#handleExit(new Error(`Copilot CLI process failed: ${errorMessage(error)}`)))
    // Same as AcpClient: a CLI that starts and exits at once turns the next stdin write into EPIPE,
    // which must not reach the process as an uncaught stream error.
    child.stdin?.on?.("error", () => {})
    child.on("exit", (code, signal) => {
      this.#handleExit(new Error(`Copilot CLI exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`))
    })

    await new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off?.("spawn", onSpawn)
        child.off?.("error", onError)
        if (error) reject(error)
        else resolve()
      }
      const onSpawn = () => finish()
      const onError = (error) => finish(new Error(`Could not start Copilot CLI: ${errorMessage(error)}`))
      const timer = setTimeout(() => {
        finish(new Error(`Copilot CLI startup timed out after ${timeoutMs}ms`))
        this.close()
      }, timeoutMs)
      child.once?.("spawn", onSpawn)
      child.once?.("error", onError)
      if (!child.once) finish()
    })
  }

  async request(method, params = {}, timeoutMs = this.#timeoutMs) {
    if (!READ_ONLY_METHODS.has(method)) throw new Error(`Copilot SDK method is not allowed: ${method}`)
    await this.start(timeoutMs)
    const child = this.#child
    if (!child || child.killed || !child.stdin?.writable) throw new Error("Copilot CLI is not running")
    const id = this.#nextID++
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }), "utf8")
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "ascii"), payload])
    return new Promise((resolve, reject) => {
      const pending = { resolve, reject, method, timer: undefined }
      pending.timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new Error(`Copilot CLI request timed out: ${method}`))
      }, Math.max(1, timeoutMs))
      this.#pending.set(id, pending)
      child.stdin.write(frame, (error) => {
        if (!error) return
        clearTimeout(pending.timer)
        this.#pending.delete(id)
        reject(error)
      })
    })
  }

  #consume(chunk) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, bytes]) : bytes
    if (this.#buffer.length > MAX_MESSAGE_BYTES + MAX_HEADER_BYTES) {
      this.#failProcess(new Error("Copilot CLI JSON-RPC buffer exceeded its size limit"))
      return
    }
    while (true) {
      const headerEnd = this.#buffer.indexOf("\r\n\r\n")
      if (headerEnd < 0) {
        if (this.#buffer.length > MAX_HEADER_BYTES) {
          this.#failProcess(new Error("Copilot CLI sent an oversized JSON-RPC header"))
        }
        return
      }
      if (headerEnd > MAX_HEADER_BYTES) {
        this.#failProcess(new Error("Copilot CLI sent an oversized JSON-RPC header"))
        return
      }
      const header = this.#buffer.subarray(0, headerEnd).toString("ascii")
      const lengthLine = header.split(/\r\n/).find((line) => /^content-length\s*:/i.test(line))
      const length = Number(lengthLine?.split(":", 2)[1]?.trim())
      if (!Number.isInteger(length) || length < 0 || length > MAX_MESSAGE_BYTES) {
        this.#failProcess(new Error("Copilot CLI sent an invalid JSON-RPC Content-Length"))
        return
      }
      const bodyStart = headerEnd + 4
      if (this.#buffer.length < bodyStart + length) return
      const body = this.#buffer.subarray(bodyStart, bodyStart + length)
      this.#buffer = this.#buffer.subarray(bodyStart + length)
      let message
      try {
        message = JSON.parse(body.toString("utf8"))
      } catch {
        this.emit("protocol-error", new Error("Copilot CLI emitted invalid JSON-RPC JSON"))
        continue
      }
      this.#consumeMessage(message)
    }
  }

  #consumeMessage(message) {
    if (message?.id === undefined) return
    const pending = this.#pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.#pending.delete(message.id)
    if (message.error) pending.reject(new Error(errorMessage(message.error)))
    else pending.resolve(message.result)
  }

  #handleExit(error) {
    if (!this.#child) return
    this.#child = undefined
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
    this.emit("exit", error)
  }

  #failProcess(error) {
    const child = this.#child
    this.#handleExit(error)
    if (child && !child.killed) child.kill()
  }

  diagnostics() {
    return {
      state: this.#starting ? "starting" : this.#child ? "running" : "stopped",
      pendingRequestCount: this.#pending.size,
      pendingMethods: [...this.#pending.values()].map(({ method }) => method)
    }
  }

  close() {
    this.#closed = true
    const child = this.#child
    this.#child = undefined
    if (child && !child.killed) child.kill()
    const error = new Error("Copilot SDK client closed")
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.#pending.clear()
  }
}

export class CopilotModelCatalog extends CachedCatalog {
  constructor({ client, Client = CopilotSdkClient, command, environment, agentID = "copilot", includeAuto = false, spawnProcess, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super()
    this.agentID = agentID
    this.client = client ?? new Client({ command, environment, spawnProcess, timeoutMs })
    this.timeoutMs = timeoutMs
    this.includeAuto = includeAuto
    this.hiddenSessionIDs = new Set()
    this.source = "copilot-sdk-models-list"
    this.client.on?.("exit", (error) => {
      this.lastError = error instanceof Error ? error.message : String(error ?? "Copilot CLI exited")
      this.clear()
    })
  }

  async preloadState() {
    return this.hiddenSessionIDs
  }

  async #refresh() {
    this.lastAttemptAt = new Date().toISOString()
    await this.client.start?.(this.timeoutMs)
    const response = await this.client.request("models.list", {}, this.timeoutMs)
    const nativeModels = Array.isArray(response?.models) ? response.models : []
    const models = nativeModels.flatMap((model) => {
      if (!model || typeof model.id !== "string" || !model.id || model.enabled === false || model.policy?.state === "disabled") return []
      const billingMultiplier = model.billing?.multiplier
      const explicitFree = model.free === true || model.isFree === true || billingMultiplier === 0
      const limit = model.capabilities?.limits ?? model.limits ?? {}
      const supports = Array.isArray(model.capabilities?.supports) ? model.capabilities.supports : []
      const attachments = supports.some((value) => typeof value === "string" && /image|vision|attachment|file/i.test(value))
      const tools = supports.some((value) => typeof value === "string" && /tool/i.test(value))
      return [{
        providerID: "copilot",
        providerName: "GitHub Copilot",
        modelID: model.id,
        modelName: typeof model.name === "string" && model.name ? model.name : model.id,
        ...(typeof model.description === "string" && model.description ? { description: model.description } : {}),
        ...(Object.keys(limit).length ? {
          ...(Number.isFinite(limit.max_context_window_tokens ?? limit.context) ? { contextLimit: limit.max_context_window_tokens ?? limit.context } : {}),
          ...(Number.isFinite(limit.max_output_tokens ?? limit.output) ? { outputLimit: limit.max_output_tokens ?? limit.output } : {})
        } : {}),
        ...(supports.length ? { tools, attachments } : typeof model.capabilities?.supports?.vision === "boolean" ? { attachments: model.capabilities.supports.vision } : {}),
        ...(explicitFree ? { isFree: true } : {}),
        ...(Number.isFinite(billingMultiplier) ? { billingMultiplier } : {})
      }]
    })
    if (this.includeAuto && !models.some((model) => model.modelID === "auto")) {
      const auth = await this.client.request("auth.getStatus", {}, this.timeoutMs)
      if (auth?.isAuthenticated === true) {
        // Auto is a documented native CLI selection, confirmed by `/model auto` over ACP.
        // Free accounts may expose no individual model rows. Auto's pricing follows the account;
        // an empty list alone must neither invent a login failure nor label routing as free.
        models.unshift({ providerID: "copilot", providerName: "GitHub Copilot", modelID: "auto", modelName: "Auto", isDefault: true })
      }
    }
    if (!models.length) {
      const error = new Error("No Copilot models are available. Run `copilot login` with an account enabled for Copilot, then refresh the model catalog.")
      error.code = "model_catalog_unavailable"
      throw error
    }
    return this.remember(models)
  }

  async list({ allowStale = true, refresh = false } = {}) {
    if (!refresh && this.cache.length) return this.result(this.cache, false)
    if (!this.inFlight) {
      const operation = this.#refresh()
      let wrapped
      wrapped = operation.finally(() => {
        if (this.inFlight === wrapped) this.inFlight = null
      })
      this.inFlight = wrapped
    }
    try {
      return await this.inFlight
    } catch (error) {
      if (allowStale) return this.stale(error)
      this.lastError = error instanceof Error ? error.message : String(error)
      throw error
    }
  }

  async resolve(model) { return this.resolveResult(await this.list({ allowStale: false }), model) }
  async validate(model) { await this.resolve(model) }
  diagnostics() {
    return {
      ...this.diagnosticsBase(this.source),
      agentID: this.agentID,
      hiddenSessionCount: this.hiddenSessionIDs.size,
      client: this.client.diagnostics?.() ?? { state: "unknown" }
    }
  }
  close() { this.client.close?.() }
}
