import { spawn, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"

const DEFAULT_START_TIMEOUT_MS = 15_000

// npm installs the OpenCode launcher as `opencode.cmd` on Windows. `spawn("opencode")` does not
// resolve that command shim, even though it is correctly present on PATH, which made the daemon
// advertise a managed OpenCode host and then immediately report ENOENT. Go through cmd.exe for
// command shims (and bare commands resolved through PATHEXT); native executables remain direct.
function openCodeSpawnInvocation(command, args, platform, environment) {
  if (platform !== "win32" || /\.(?:exe|com)$/i.test(command)) return { command, args }
  return {
    command: environment.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", command, ...args]
  }
}

function stopWindowsProcessTree(processID) {
  // `cmd /c opencode` can outlive its cmd.exe parent. taskkill /T targets only the managed
  // process tree, unlike a port-based kill which could terminate an unrelated OpenCode instance.
  spawnSync("taskkill", ["/pid", String(processID), "/t", "/f"], { stdio: "ignore", windowsHide: true })
}
const READINESS_RETRY_MS = 100
const READINESS_ATTEMPT_MS = 1_000

class OpenCodeCredentialError extends Error {}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function httpHost(host) {
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host
}

export async function waitForOpenCodeHealth({ host, port, username, password, timeoutMs = DEFAULT_START_TIMEOUT_MS, fetchImpl = fetch }) {
  const deadline = Date.now() + timeoutMs
  const authorization = Buffer.from(`${username}:${password}`).toString("base64")
  const url = `http://${httpHost(host)}:${port}/global/health`
  let lastError

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.min(READINESS_ATTEMPT_MS, remaining))
    try {
      const response = await fetchImpl(url, {
        headers: { Authorization: `Basic ${authorization}` },
        signal: controller.signal
      })
      if (response.status === 200) return
      if (response.status === 401) {
        throw new OpenCodeCredentialError(`OpenCode health check rejected the generated credentials on ${host}:${port}`)
      }
      lastError = new Error(`OpenCode health check returned HTTP ${response.status}`)
    } catch (error) {
      if (error instanceof OpenCodeCredentialError) throw error
      lastError = error
    } finally {
      clearTimeout(timer)
    }

    if (Date.now() < deadline) await sleep(Math.min(READINESS_RETRY_MS, Math.max(1, deadline - Date.now())))
  }

  const detail = lastError instanceof Error ? `: ${lastError.message}` : ""
  throw new Error(`OpenCode did not become healthy on ${host}:${port} within ${timeoutMs}ms${detail}`)
}

function startTimeout(host, port, timeoutMs) {
  let timer
  const promise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      `OpenCode did not become ready on ${host}:${port} within ${timeoutMs}ms`
    )), timeoutMs)
  })
  return { promise, cancel: () => clearTimeout(timer) }
}

function forwardStderrLines(child, emitLine) {
  if (!child?.stderr?.on) return
  child.stderr.setEncoding?.("utf8")
  let buffer = ""
  child.stderr.on("data", (chunk) => {
    buffer += String(chunk)
    let newline = buffer.indexOf("\n")
    while (newline !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "")
      buffer = buffer.slice(newline + 1)
      if (line) emitLine(line)
      newline = buffer.indexOf("\n")
    }
  })
  child.stderr.on("end", () => {
    const line = buffer.replace(/\r$/, "")
    buffer = ""
    if (line) emitLine(line)
  })
}

export class ManagedOpenCodeHost extends EventEmitter {
  constructor({
    command = "opencode",
    host = "127.0.0.1",
    port = 4096,
    username,
    password,
    environment = process.env,
    spawnProcess = spawn,
    platform = process.platform,
    stopProcessTree = stopWindowsProcessTree,
    readinessHost,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    waitUntilReady = waitForOpenCodeHealth
  } = {}) {
    super()
    this.command = command
    this.host = host
    this.port = port
    this.username = username
    this.password = password
    this.environment = environment
    this.spawnProcess = spawnProcess
    this.platform = platform
    this.stopProcessTree = stopProcessTree
    this.readinessHost = readinessHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host)
    this.startTimeoutMs = startTimeoutMs
    this.waitUntilReady = waitUntilReady
    this.child = undefined
    this.windowsShellChild = false
    this.starting = undefined
  }

  get processID() {
    if (!this.child || this.child.exitCode != null || this.child.signalCode != null) return undefined
    return Number.isInteger(this.child.pid) ? this.child.pid : undefined
  }

  diagnostics() {
    const listenerCounts = Object.fromEntries(
      this.eventNames().map((eventName) => [String(eventName), this.listenerCount(eventName)])
    )
    return {
      state: this.starting ? "starting" : this.processID ? "running" : "stopped",
      processID: this.processID,
      startInFlight: Boolean(this.starting),
      listenerCount: Object.values(listenerCounts).reduce((total, count) => total + count, 0),
      listenerCounts
    }
  }

  async start() {
    if (this.child && this.child.exitCode == null && this.child.signalCode == null) return
    if (this.starting) return this.starting
    this.starting = this.#start()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  async #start() {
    const invocation = openCodeSpawnInvocation(
      this.command,
      ["serve", "--hostname", this.host, "--port", String(this.port)],
      this.platform,
      this.environment
    )
    const child = this.spawnProcess(invocation.command, invocation.args, {
      // Keep OpenCode stdout quiet so the daemon owns the startup summary. Pipe stderr instead of
      // inheriting it so every upstream warning can be identified as OpenCode by the parent CLI.
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      env: {
        ...this.environment,
        OPENCODE_SERVER_USERNAME: this.username,
        OPENCODE_SERVER_PASSWORD: this.password
      }
    })
    this.child = child
    forwardStderrLines(child, (line) => this.emit("stderr", line))
    this.windowsShellChild = this.platform === "win32" && this.spawnProcess === spawn && invocation.command !== this.command

    const exited = new Promise((_, reject) => {
      child.once("error", (error) => reject(error))
      child.once("exit", (code, signal) => reject(new Error(
        `OpenCode exited before becoming ready (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`
      )))
    })
    const timeout = startTimeout(this.readinessHost, this.port, this.startTimeoutMs)

    try {
      await Promise.race([
        this.waitUntilReady({
          host: this.readinessHost,
          port: this.port,
          username: this.username,
          password: this.password,
          timeoutMs: this.startTimeoutMs
        }),
        exited,
        timeout.promise
      ])
      timeout.cancel()
      this.emit("available", { pid: this.processID, host: this.host, port: this.port })
    } catch (error) {
      timeout.cancel()
      this.stop("SIGTERM")
      throw error
    }

    child.removeAllListeners("exit")
    child.removeAllListeners("error")
    child.once("error", (error) => this.#handleExit(error))
    child.once("exit", (code, signal) => this.#handleExit(new Error(
      `OpenCode exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`
    )))
  }

  stop(signal = "SIGTERM") {
    const child = this.child
    if (!child || child.exitCode != null || child.signalCode != null) return false
    if (this.windowsShellChild && Number.isInteger(child.pid)) {
      this.stopProcessTree(child.pid)
      return true
    }
    return child.kill(signal)
  }

  #handleExit(error) {
    if (!this.child) return
    this.child = undefined
    this.emit("unavailable", error)
  }
}

export function trackManagedHostLifecycle(host, registry, hostID) {
  const start = host.start.bind(host)
  host.start = async (...args) => {
    try {
      const result = await start(...args)
      registry.updateHost(hostID, { state: "available", processID: host.processID })
      return result
    } catch (error) {
      registry.updateHost(hostID, { state: "unavailable", processID: undefined })
      throw error
    }
  }
  host.on("unavailable", () => registry.updateHost(hostID, { state: "unavailable", processID: undefined }))
  return host
}
