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

function posixProcessTree(processID, listProcesses = spawnSync) {
  const result = listProcesses("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8",
    windowsHide: true
  })
  if (result?.error || result?.status !== 0 || typeof result?.stdout !== "string") return [processID]

  const children = new Map()
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
    if (!match) continue
    const pid = Number(match[1])
    const ppid = Number(match[2])
    if (!Number.isInteger(pid) || !Number.isInteger(ppid)) continue
    const current = children.get(ppid) ?? []
    current.push(pid)
    children.set(ppid, current)
  }

  // Return descendants before parents. OpenCode's npm/native serve chain has historically left the
  // innermost server alive when only its launcher receives SIGTERM; snapshotting the tree while the
  // launcher is still alive preserves those exact descendant PIDs before they can be re-parented.
  const ordered = []
  const visited = new Set()
  const visit = (pid) => {
    if (visited.has(pid)) return
    visited.add(pid)
    for (const child of children.get(pid) ?? []) visit(child)
    ordered.push(pid)
  }
  visit(processID)
  return ordered
}

export function stopPosixProcessTree(
  processID,
  _requestedSignal = "SIGTERM",
  { listProcesses = spawnSync, killProcess = (pid, signal) => process.kill(pid, signal) } = {}
) {
  // OpenCode `serve` has had multiple upstream lifecycle regressions where SIGTERM is consumed while
  // an internal server/child remains alive. Harness Remote owns only this exact process tree, so use
  // SIGKILL on the snapshotted PIDs rather than guessing by port or signalling unrelated processes.
  // This mirrors Windows' existing `taskkill /T /F` semantics and makes daemon restart deterministic.
  let signalled = false
  for (const pid of posixProcessTree(processID, listProcesses)) {
    try {
      killProcess(pid, "SIGKILL")
      signalled = true
    } catch (error) {
      if (error?.code !== "ESRCH") throw error
    }
  }
  return signalled
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

export async function waitForOpenCodeHealth({
  host,
  port,
  username,
  password,
  fallbackUsername = "opencode",
  timeoutMs = DEFAULT_START_TIMEOUT_MS,
  fetchImpl = fetch
}) {
  const deadline = Date.now() + timeoutMs
  const usernames = [...new Set([username, fallbackUsername]
    .filter((candidate) => typeof candidate === "string" && candidate.length > 0))]
  if (!usernames.length) usernames.push("")
  const endpoints = [
    { path: "/global/health", apiBasePath: "" },
    { path: "/api/info", apiBasePath: "/api" }
  ]
  let lastError

  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now())
    let allCandidatesRejected = true
    for (const candidateUsername of usernames) {
      for (const endpoint of endpoints) {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), Math.min(READINESS_ATTEMPT_MS, remaining))
        try {
          const authorization = Buffer.from(`${candidateUsername}:${password}`).toString("base64")
          const response = await fetchImpl(`http://${httpHost(host)}:${port}${endpoint.path}`, {
            headers: { Authorization: `Basic ${authorization}` },
            signal: controller.signal
          })
          if (response.status === 200) {
            const contentType = response.headers?.get?.("content-type") ?? ""
            // OpenCode v2 serves the web UI at /global/health but exposes its JSON readiness
            // endpoint at /api/info. A successful HTML response is not readiness.
            if (endpoint.apiBasePath || !contentType || /json/i.test(contentType)) {
              return { username: candidateUsername, apiBasePath: endpoint.apiBasePath }
            }
            continue
          }
          if (response.status === 401) {
            // The remaining endpoints cannot become useful with this username either.
            break
          }
          allCandidatesRejected = false
          lastError = new Error(`OpenCode health check returned HTTP ${response.status}`)
        } catch (error) {
          allCandidatesRejected = false
          lastError = error
        } finally {
          clearTimeout(timer)
        }
      }
    }

    if (allCandidatesRejected) {
      throw new OpenCodeCredentialError(`OpenCode health check rejected the generated credentials on ${host}:${port}`)
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
    stopPosixTree = stopPosixProcessTree,
    isolatePosixProcessTree = platform !== "win32" && spawnProcess === spawn,
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
    this.apiBasePath = ""
    this.environment = environment
    this.spawnProcess = spawnProcess
    this.platform = platform
    this.stopProcessTree = stopProcessTree
    this.stopPosixTree = stopPosixTree
    this.isolatePosixProcessTree = isolatePosixProcessTree
    this.readinessHost = readinessHost ?? (host === "0.0.0.0" ? "127.0.0.1" : host)
    this.startTimeoutMs = startTimeoutMs
    this.waitUntilReady = waitUntilReady
    this.child = undefined
    this.windowsShellChild = false
    this.posixManagedTree = false
    this.starting = undefined
    this.closed = false
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
      state: this.closed ? "closed" : this.starting ? "starting" : this.processID ? "running" : "stopped",
      processID: this.processID,
      startInFlight: Boolean(this.starting),
      listenerCount: Object.values(listenerCounts).reduce((total, count) => total + count, 0),
      listenerCounts
    }
  }

  async start() {
    // `stop()` is the daemon-shutdown boundary. Browser/event traffic can still arrive while the
    // outer HTTP server drains, but it must never resurrect OpenCode after MachineDaemon.close()
    // already killed the managed process. A natural crash remains restartable because it never sets
    // this terminal lifecycle latch.
    if (this.closed) throw new Error("Managed OpenCode host is closed")
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
      // POSIX production isolates only this managed tree; shutdown snapshots and kills those exact
      // descendants, including internal OpenCode server children that may otherwise survive SIGTERM.
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
      detached: this.isolatePosixProcessTree,
      env: {
        ...this.environment,
        OPENCODE_SERVER_USERNAME: this.username,
        OPENCODE_SERVER_PASSWORD: this.password,
        // OpenCode v2 prefers OPENCODE_PASSWORD over the legacy server-specific name. Set both so
        // a pre-existing shell value cannot make the managed child reject its generated password.
        OPENCODE_PASSWORD: this.password
      }
    })
    this.child = child
    forwardStderrLines(child, (line) => this.emit("stderr", line))
    this.windowsShellChild = this.platform === "win32" && this.spawnProcess === spawn && invocation.command !== this.command
    this.posixManagedTree = this.isolatePosixProcessTree && Number.isInteger(child.pid)

    const exited = new Promise((_, reject) => {
      child.once("error", (error) => reject(error))
      child.once("exit", (code, signal) => reject(new Error(
        `OpenCode exited before becoming ready (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`
      )))
    })
    const timeout = startTimeout(this.readinessHost, this.port, this.startTimeoutMs)

    try {
      const readiness = await Promise.race([
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
      // OpenCode v2 authenticates its native server as `opencode` even when the legacy
      // OPENCODE_SERVER_USERNAME variable is ignored. Keep the username that actually passed
      // readiness for every subsequent managed HTTP request.
      if (readiness?.username !== undefined) this.username = readiness.username
      if (readiness?.apiBasePath !== undefined) this.apiBasePath = readiness.apiBasePath
      this.emit("available", { pid: this.processID, host: this.host, port: this.port })
    } catch (error) {
      timeout.cancel()
      // A failed lazy startup is recoverable. Terminate this attempt without closing the host so a
      // later authenticated request can retry; only the public stop() method is a terminal shutdown.
      this.#terminate("SIGTERM")
      throw error
    }

    child.removeAllListeners("exit")
    child.removeAllListeners("error")
    child.once("error", (error) => this.#handleExit(error))
    child.once("exit", (code, signal) => this.#handleExit(new Error(
      `OpenCode exited (${code ?? "unknown"}${signal ? `, ${signal}` : ""})`
    )))
  }

  #terminate(signal = "SIGTERM") {
    const child = this.child
    if (!child || child.exitCode != null || child.signalCode != null) return false
    if (this.windowsShellChild && Number.isInteger(child.pid)) {
      this.stopProcessTree(child.pid)
      return true
    }
    if (this.posixManagedTree && Number.isInteger(child.pid)) {
      try {
        return this.stopPosixTree(child.pid, signal) !== false
      } catch {
        // If process enumeration itself becomes unavailable, retain a precise launcher-only fallback.
        return child.kill(signal)
      }
    }
    return child.kill(signal)
  }

  stop(signal = "SIGTERM") {
    // MachineDaemon.close() calls this while its HTTP server can still have live EventSource/model
    // requests draining. Make that boundary terminal before killing the process so those requests
    // cannot race through ensureManagedHttpAvailable() and start a replacement OpenCode instance.
    this.closed = true
    return this.#terminate(signal)
  }

  #handleExit(error) {
    if (!this.child) return
    this.child = undefined
    this.windowsShellChild = false
    this.posixManagedTree = false
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
