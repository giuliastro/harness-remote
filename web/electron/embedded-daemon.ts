import { spawn, type ChildProcess } from "node:child_process"
import { randomBytes } from "node:crypto"
import { createServer } from "node:net"
import { join } from "node:path"

export const EMBEDDED_DAEMON_HOST = "127.0.0.1"
export const EMBEDDED_DAEMON_PROFILE_ID = "desktop-local-runtime"
const DEFAULT_STARTUP_TIMEOUT_MS = 30_000
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000
const DEFAULT_HEALTH_CHECK_INTERVAL_MS = 10_000
const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 2_000
const DEFAULT_HEALTH_FAILURE_THRESHOLD = 3
const MAX_CAPTURED_STDERR = 4_096

export type EmbeddedDaemonEndpoint = {
  id: typeof EMBEDDED_DAEMON_PROFILE_ID
  host: typeof EMBEDDED_DAEMON_HOST
  port: number
  username: string
  password: string
}

export type EmbeddedDaemonReady = {
  endpoint: EmbeddedDaemonEndpoint
  pid: number | null
}

export type EmbeddedDaemonExit = {
  code: number | null
  signal: NodeJS.Signals | null
}

export type EmbeddedDaemonPathOptions = {
  isPackaged: boolean
  appPath: string
  resourcesPath: string
}

type EmbeddedDaemonEnvironment = NodeJS.ProcessEnv | (() => Promise<NodeJS.ProcessEnv>)
type EmbeddedDaemonLaunchConfig = {
  port: number
  openCodePort: number
  auth: { username: string; password: string }
}

export function embeddedDaemonEntry({ isPackaged, appPath, resourcesPath }: EmbeddedDaemonPathOptions): string {
  return isPackaged
    ? join(resourcesPath, "bridge-runtime", "src", "daemon-cli.js")
    : join(appPath, "..", "bridge", "src", "daemon-cli.js")
}

export function embeddedDaemonArgs(port: number, openCodePort: number, stateDirectory?: string): string[] {
  return [
    "--host", EMBEDDED_DAEMON_HOST,
    "--port", String(port),
    "--opencode-host", EMBEDDED_DAEMON_HOST,
    "--opencode-port", String(openCodePort),
    ...(stateDirectory ? ["--state-dir", stateDirectory] : [])
  ]
}

export function embeddedDaemonEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  auth?: { username: string; password: string }
): NodeJS.ProcessEnv {
  return {
    ...environment,
    ELECTRON_RUN_AS_NODE: "1",
    ...(auth
      ? {
          HARNESS_REMOTE_USERNAME: auth.username,
          HARNESS_REMOTE_PASSWORD: auth.password
        }
      : {})
  }
}

export async function resolveEmbeddedDaemonEnvironment(
  environment: EmbeddedDaemonEnvironment | undefined
): Promise<NodeJS.ProcessEnv> {
  if (typeof environment === "function") return await environment()
  return environment ?? process.env
}

export async function findLoopbackPort(startPort: number, excluded: readonly number[] = [], attempts = 64): Promise<number> {
  const excludedPorts = new Set(excluded)
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = startPort + offset
    if (port > 65_535) break
    if (excludedPorts.has(port)) continue
    if (await canBindLoopback(port)) return port
  }
  throw new Error(`No free loopback port found from ${startPort} through ${Math.min(65_535, startPort + attempts - 1)}`)
}

function canBindLoopback(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.unref()
    probe.once("error", () => resolve(false))
    probe.listen(port, EMBEDDED_DAEMON_HOST, () => probe.close(() => resolve(true)))
  })
}

function credentials(): { username: string; password: string } {
  return {
    username: "harness-desktop",
    password: randomBytes(24).toString("base64url")
  }
}

function appendTail(current: string, chunk: Buffer | string): string {
  return `${current}${chunk.toString()}`.slice(-MAX_CAPTURED_STDERR)
}

function cleanErrorDetail(value: string): string {
  const lines = value.trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  return lines.slice(-3).join(" | ").slice(0, 1_000)
}

export class EmbeddedDaemonRuntime {
  private child: ChildProcess | undefined
  private ready: EmbeddedDaemonReady | undefined
  private starting: Promise<EmbeddedDaemonReady> | undefined
  private launchConfig: EmbeddedDaemonLaunchConfig | undefined
  private healthTimer: NodeJS.Timeout | undefined
  private healthFailures = 0
  private recovering: Promise<void> | undefined
  private stopRequested = false

  constructor(private readonly options: {
    entryPath: string
    executable?: string
    environment?: EmbeddedDaemonEnvironment
    stateDirectory?: string
    startupTimeoutMs?: number
    shutdownTimeoutMs?: number
    healthCheckIntervalMs?: number
    healthCheckTimeoutMs?: number
    healthFailureThreshold?: number
    onExit?: (details: EmbeddedDaemonExit) => void
  }) {}

  get isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed && this.ready)
  }

  start(): Promise<EmbeddedDaemonReady> {
    this.stopRequested = false
    if (this.ready && this.isRunning) return Promise.resolve(this.ready)
    if (this.recovering) {
      return this.recovering.then(() => {
        if (this.ready && this.isRunning) return this.ready
        return this.start()
      })
    }
    if (this.starting) return this.starting
    this.starting = this.launch().finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  async healthCheck(): Promise<boolean> {
    const ready = this.ready
    const child = this.child
    if (!ready || !child || child.exitCode !== null || child.killed) return false

    const controller = new AbortController()
    const timeoutMs = this.options.healthCheckTimeoutMs ?? DEFAULT_HEALTH_CHECK_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    const authorization = `Basic ${Buffer.from(`${ready.endpoint.username}:${ready.endpoint.password}`, "utf8").toString("base64")}`
    try {
      const response = await fetch(`http://${ready.endpoint.host}:${ready.endpoint.port}/v1/machine`, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: authorization },
        redirect: "manual",
        signal: controller.signal
      })
      void response.body?.cancel().catch(() => undefined)
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  private async launch(reuse?: EmbeddedDaemonLaunchConfig): Promise<EmbeddedDaemonReady> {
    const environment = await resolveEmbeddedDaemonEnvironment(this.options.environment)
    const port = reuse?.port ?? await findLoopbackPort(4097)
    const openCodePort = reuse?.openCodePort ?? await findLoopbackPort(4096, [port])
    const auth = reuse?.auth ?? credentials()
    const launchConfig = { port, openCodePort, auth }
    const args = embeddedDaemonArgs(port, openCodePort, this.options.stateDirectory)
    const child = spawn(this.options.executable ?? process.execPath, [this.options.entryPath, ...args], {
      env: embeddedDaemonEnvironment(environment, auth),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    })
    this.child = child
    let stderr = ""
    child.stderr?.on("data", (chunk) => { stderr = appendTail(stderr, chunk) })

    const readyMarker = `Harness daemon ready at http://${EMBEDDED_DAEMON_HOST}:${port}`
    const startupTimeoutMs = this.options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
    try {
      await new Promise<void>((resolve, reject) => {
        let stdout = ""
        let settled = false
        const finish = (error?: Error) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          child.stdout?.off("data", onStdout)
          child.off("error", onError)
          child.off("exit", onExit)
          if (error) reject(error)
          else resolve()
        }
        const onStdout = (chunk: Buffer | string) => {
          stdout = `${stdout}${chunk.toString()}`.slice(-8_192)
          if (stdout.includes(readyMarker)) finish()
        }
        const onError = (error: Error) => finish(new Error(`Embedded daemon failed to start: ${error.message}`))
        const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
          const detail = cleanErrorDetail(stderr)
          const suffix = detail ? `: ${detail}` : ""
          finish(new Error(`Embedded daemon exited before ready (${code ?? "unknown"}${signal ? `, ${signal}` : ""})${suffix}`))
        }
        const timer = setTimeout(() => {
          const detail = cleanErrorDetail(stderr)
          finish(new Error(`Embedded daemon did not become ready within ${startupTimeoutMs}ms${detail ? `: ${detail}` : ""}`))
        }, startupTimeoutMs)
        timer.unref?.()
        child.stdout?.on("data", onStdout)
        child.once("error", onError)
        child.once("exit", onExit)
      })
    } catch (error) {
      if (this.child === child) this.child = undefined
      if (!child.killed && child.exitCode === null) child.kill("SIGTERM")
      throw error
    }

    const result: EmbeddedDaemonReady = {
      endpoint: {
        id: EMBEDDED_DAEMON_PROFILE_ID,
        host: EMBEDDED_DAEMON_HOST,
        port,
        username: auth.username,
        password: auth.password
      },
      pid: child.pid ?? null
    }
    this.launchConfig = launchConfig
    this.ready = result
    this.healthFailures = 0
    child.once("exit", (code, signal) => {
      const wasReady = this.ready === result
      if (this.child === child) this.child = undefined
      if (this.ready === result) this.ready = undefined
      if (wasReady) {
        this.cancelHealthCheck()
        this.launchConfig = undefined
        this.options.onExit?.({ code, signal })
      }
    })
    this.scheduleHealthCheck()
    return result
  }

  private scheduleHealthCheck(): void {
    this.cancelHealthCheck()
    const intervalMs = this.options.healthCheckIntervalMs ?? DEFAULT_HEALTH_CHECK_INTERVAL_MS
    if (intervalMs <= 0 || this.stopRequested || !this.ready || !this.isRunning) return
    const expectedReady = this.ready
    this.healthTimer = setTimeout(() => {
      this.healthTimer = undefined
      void this.runHealthCheck(expectedReady)
    }, intervalMs)
    this.healthTimer.unref?.()
  }

  private cancelHealthCheck(): void {
    clearTimeout(this.healthTimer)
    this.healthTimer = undefined
  }

  private async runHealthCheck(expectedReady: EmbeddedDaemonReady): Promise<void> {
    if (this.stopRequested || this.recovering || this.ready !== expectedReady || !this.isRunning) return
    const healthy = await this.healthCheck()
    if (this.stopRequested || this.ready !== expectedReady) return
    if (healthy) {
      this.healthFailures = 0
    } else {
      this.healthFailures += 1
      const threshold = Math.max(1, Math.floor(this.options.healthFailureThreshold ?? DEFAULT_HEALTH_FAILURE_THRESHOLD))
      if (this.healthFailures >= threshold) {
        await this.recover(expectedReady)
        return
      }
    }
    this.scheduleHealthCheck()
  }

  private async recover(expectedReady: EmbeddedDaemonReady): Promise<void> {
    if (this.recovering) return this.recovering
    const child = this.child
    const launchConfig = this.launchConfig
    if (!child || !launchConfig || this.ready !== expectedReady) return

    this.recovering = (async () => {
      this.cancelHealthCheck()
      this.healthFailures = 0
      // Keep the exact loopback endpoint and volatile credentials stable across recovery. The
      // renderer/profile registry can therefore ride through a daemon restart without learning new
      // secrets or creating a desktop-only reconnection protocol.
      if (this.child === child) this.child = undefined
      if (this.ready === expectedReady) this.ready = undefined
      await this.terminateChild(child)
      if (this.stopRequested) return
      try {
        await this.launch(launchConfig)
      } catch {
        this.launchConfig = undefined
        this.options.onExit?.({ code: null, signal: null })
      }
    })().finally(() => {
      this.recovering = undefined
    })
    return this.recovering
  }

  private async terminateChild(child: ChildProcess): Promise<void> {
    if (child.exitCode !== null) return
    const shutdownTimeoutMs = this.options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.off("exit", finish)
        resolve()
      }
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill("SIGKILL")
        finish()
      }, shutdownTimeoutMs)
      timer.unref?.()
      child.once("exit", finish)
      if (child.exitCode !== null) {
        finish()
        return
      }
      child.kill("SIGTERM")
    })
  }

  async stop(): Promise<void> {
    this.stopRequested = true
    this.cancelHealthCheck()
    if (this.recovering) await this.recovering.catch(() => undefined)
    const child = this.child
    this.child = undefined
    this.ready = undefined
    this.launchConfig = undefined
    this.healthFailures = 0
    if (!child || child.exitCode !== null) return
    await this.terminateChild(child)
  }
}
