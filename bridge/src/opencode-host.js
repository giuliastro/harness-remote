import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import net from "node:net"

const DEFAULT_START_TIMEOUT_MS = 15_000

function waitForPort(host, port, timeoutMs = DEFAULT_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection({ host, port })
      socket.once("connect", () => {
        socket.destroy()
        resolve()
      })
      socket.once("error", () => {
        socket.destroy()
        if (Date.now() >= deadline) {
          reject(new Error(`OpenCode did not become ready on ${host}:${port} within ${timeoutMs}ms`))
          return
        }
        setTimeout(tryConnect, 100).unref?.()
      })
    }
    tryConnect()
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
    readinessHost,
    startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
    waitUntilReady = waitForPort
  } = {}) {
    super()
    this.command = command
    this.host = host
    this.port = port
    this.username = username
    this.password = password
    this.environment = environment
    this.spawnProcess = spawnProcess
    this.readinessHost = readinessHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host)
    this.startTimeoutMs = startTimeoutMs
    this.waitUntilReady = waitUntilReady
    this.child = undefined
    this.starting = undefined
  }

  get processID() {
    return Number.isInteger(this.child?.pid) ? this.child.pid : undefined
  }

  async start() {
    if (this.child && !this.child.killed) return
    if (this.starting) return this.starting
    this.starting = this.#start()
    try {
      await this.starting
    } finally {
      this.starting = undefined
    }
  }

  async #start() {
    const child = this.spawnProcess(this.command, ["serve", "--hostname", this.host, "--port", String(this.port)], {
      stdio: "inherit",
      env: {
        ...this.environment,
        OPENCODE_SERVER_USERNAME: this.username,
        OPENCODE_SERVER_PASSWORD: this.password
      }
    })
    this.child = child

    const exited = new Promise((_, reject) => {
      child.once("error", (error) => reject(error))
      child.once("exit", (code, signal) => reject(new Error(
        `OpenCode exited before becoming ready (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`
      )))
    })

    try {
      await Promise.race([
        this.waitUntilReady(this.readinessHost, this.port, this.startTimeoutMs),
        exited
      ])
      this.emit("available", { pid: this.processID, host: this.host, port: this.port })
    } catch (error) {
      this.stop()
      throw error
    }

    child.removeAllListeners("exit")
    child.removeAllListeners("error")
    child.once("error", (error) => this.#handleExit(error))
    child.once("exit", (code, signal) => this.#handleExit(new Error(
      `OpenCode exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`
    )))
  }

  stop() {
    const child = this.child
    this.child = undefined
    if (child && !child.killed) child.kill()
  }

  #handleExit(error) {
    if (!this.child) return
    this.child = undefined
    this.emit("unavailable", error)
  }
}

export function trackManagedHostLifecycle(host, registry, hostID) {
  host.on("available", () => registry.updateHost(hostID, { state: "available", processID: host.processID }))
  host.on("unavailable", () => registry.updateHost(hostID, { state: "unavailable", processID: undefined }))
  return host
}
